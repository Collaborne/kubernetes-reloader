#!/usr/bin/env node

import { createServer } from 'http';
import { resolve } from 'path';

import k8s from 'auto-kubernetes-client';
import express from 'express';
import prometheusBundle from 'express-prom-bundle';
import { configure } from 'log4js';
import yargs from 'yargs';

import { calculateHash } from './hash';
import { createK8sConfig } from './kubernetes';
import { getModuleLogger } from './logger';
import { resourceLoop } from './resource-loop';

export interface ResourceClient<Payload extends {} = {}> {
	apiVersion: string;
	kind: string;

	list(): Promise<K8sResource<K8sListPayload<Payload>>>;
	get(name: string): Promise<K8sResource<Payload>>;
	watch(resourceVersion?: string): K8sResourceWatch<Payload>;
	patch(name: string, patch: Partial<K8sResource<Payload>>|JSONPatchEntry[]): /* XXX */ Promise<void>;
}

configure(process.env.LOG4JS_CONFIG || resolve(__dirname, '../log4js.json'));

// tslint:disable-next-line: no-var-requires
const pkg = require('../package.json');

const logger = getModuleLogger();

const argv = yargs
	.alias('s', 'server').describe('server', 'The address and port of the Kubernetes API server')
	.alias('cacert', 'certificate-authority').describe('certificate-authority', 'Path to a cert. file for the certificate authority')
	.alias('cert', 'client-certificate').describe('client-certificate', 'Path to a client certificate file for TLS')
	.alias('key', 'client-key').describe('client-key', 'Path to a client key file for TLS')
	.boolean('insecure-skip-tls-verify').describe('insecure-skip-tls-verify', 'If true, the server\'s certificate will not be checked for validity. This will make your HTTPS connections insecure')
	.describe('token', 'Bearer token for authentication to the API server')
	.describe('namespace', 'The namespace to watch').demandOption('namespace')
	.array('resource-type').describe('resource-type', 'Enabled resource types (empty to enable all, can use multiple times)').default('resource-type', [])
	.number('port').default('port', process.env.PORT || 8080)
	.describe('configmap', 'The configmap under which to store known content hashes').string('configmap').demandOption('configmap')
	.describe('ignored-config-resource-types', 'Configuration resource types to ignore').array('ignored-config-resource-types').default('ignored-config-resource-types', ['v1.Secret'])
	.help()
	.argv;

const ENV_PREFIX = '_RELOADER_';
const CONFIGMAP_RELOADER_ANNOTATION = 'reloader.k8s.collaborne.com/configmap';
const SECRET_RELOADER_ANNOTATION = 'reloader.k8s.collaborne.com/secret';

const CONFIGMAP_LEGACY_RELOADER_ANNOTATION = 'configmap.reloader.stakater.com/reload';
const SECRET_LEGACY_RELOADER_ANNOTATION = 'secret.reloader.stakater.com/reload';

const configResourceTypesToAnnotations: {[resourceType: string]: string[]} = {
	'v1.ConfigMap': [CONFIGMAP_RELOADER_ANNOTATION, CONFIGMAP_LEGACY_RELOADER_ANNOTATION],
	'v1.Secret': [SECRET_RELOADER_ANNOTATION, SECRET_LEGACY_RELOADER_ANNOTATION],
};
const targetResourceTypes = [
	'apps/v1.Deployment',
	'apps/v1.Daemonset',
	'apps/v1.StatefulSet',
];

export interface ConfigMapPayload {
	data?: {[key: string]: string};
}
export interface SecretPayload {
	data?: {[key: string]: string};
}

interface EnvVar {
	name: string;
	value: string;
}

interface Container {
	name: string;
	env?: EnvVar[];
}

interface PodTemplateSpec {
	spec: {
		containers: Container[];
		initContainers?: Container[];
	};
}

interface BaseDeploymentPayload {
	spec: {
		template: PodTemplateSpec;
	};
}

function createResourceClient<Payload>(k8sClient: any, resourceType: string, ns?: string): ResourceClient<Payload> {
	const RE = /(((.*)\/)?(.+))\.([^\.]+)/;
	const match = RE.exec(resourceType);
	if (!match) {
		throw new Error(`Invalid qualified name ${resourceType}`);
	}
	const groupName = match[3] ? match[1] : match[4];
	const kind = match[5];
	let groupK8sClient: any;
	if (ns) {
		groupK8sClient = k8sClient.group(groupName).ns(ns);
	} else {
		groupK8sClient = k8sClient.group(groupName);
	}

	// Now wrap this to make it easier to work with:
	const kindLower = kind.toLowerCase();
	const { list, watch } = groupK8sClient[`${kindLower}s`];
	const get = (name: string) => groupK8sClient[kindLower](name).get();
	const patch = (name: string, p: object) => groupK8sClient[kindLower](name).patch(p);
	return {
		apiVersion: groupName,
		kind,
		get, list, patch, watch,
	};
}

function dependsOn(targetResource: K8sResource, updatedResource: K8sResource) {
	// Check annotations of targetResource whether it should get updated on the updatedResource
	const updatedResourceType = `${updatedResource.apiVersion}.${updatedResource.kind}`;
	const annotations = configResourceTypesToAnnotations[updatedResourceType];
	if (!annotations) {
		logger.warn(`Unexpected resource type ${updatedResourceType}`);
		return false;
	}

	if (!targetResource.metadata.annotations || Object.keys(targetResource.metadata.annotations).length === 0) {
		logger.trace(`No annotations on ${targetResource.apiVersion}.${targetResource.kind}:${targetResource.metadata.name}`);
		return false;
	}

	let annotationValue;
	for (const annotation of annotations) {
		annotationValue = targetResource.metadata.annotations[annotation];
		if (annotationValue) {
			logger.trace(`Found ${annotation} on ${targetResource.apiVersion}.${targetResource.kind}:${targetResource.metadata.name}`);
			break;
		}
	}
	if (!annotationValue) {
		logger.trace(`None of ${annotations} on ${targetResource.apiVersion}.${targetResource.kind}:${targetResource.metadata.name}`);
		return false;
	}

	const names = annotationValue.split(',');
	return names.includes(updatedResource.metadata.name);
}

interface PendingUpdate {
	timeout: NodeJS.Timeout;
	updatedResources: Array<K8sResource<ConfigMapPayload|SecretPayload>>;
}

function executeResourceUpdate(resourceClient: ResourceClient<BaseDeploymentPayload>, resource: K8sResource<BaseDeploymentPayload>, updatedResources: Array<K8sResource<ConfigMapPayload|SecretPayload>>) {
	// For each of the updated resources add or update the environment variable with the SHA for that resource,
	// and then do an actual update request.
	const resourceTypeColonName = `${resource.apiVersion}.${resource.kind}:${resource.metadata.name}`;
	logger.info(`Executing update for ${resourceTypeColonName}`);

	const containerEnvVars: {[containerName: string]: EnvVar[]} = {};

	// For each of the updated resources: Find a suitable container, and then add the update.
	for (const updatedResource of updatedResources) {
		const envVarName = `${ENV_PREFIX}_${updatedResource.kind.toUpperCase()}_${updatedResource.metadata.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
		let containerToUpdate;
		switch (`${resource.apiVersion}.${resource.kind}`) {
			case 'apps/v1.Deployment':
			case 'apps/v1.Daemonset':
			case 'apps/v1.StatefulSet':
				// XXX: We're ignoring initContainers here, which should be fine
				nextContainer: for (const container of resource.spec.template.spec.containers) {
					if (!container.env) {
						continue;
					}
					for (const envVar of container.env) {
						if (envVar.name === envVarName) {
							containerToUpdate = container;
							break nextContainer;
						}
					}
				}
				if (!containerToUpdate) {
					containerToUpdate = resource.spec.template.spec.containers[0];
				}
				break;
			default:
				throw new Error(`Unrecognized target resource ${resourceTypeColonName}`);
		}

		const envVars = containerEnvVars[containerToUpdate.name] || [];
		containerEnvVars[containerToUpdate.name] = [...envVars, {name: envVarName, value: calculateHash(updatedResource.data || {})}];
	}

	// Now translate that into a suitable strategic-merge patch
	const patch = {
		spec: {
			template: {
				spec: {
					containers: Object.entries(containerEnvVars).map(([name, envVars]) => ({
						env: envVars,
						name,
					})),
				},
			},
		},
	};
	logger.info(`Updating ${resourceTypeColonName} with ${JSON.stringify(patch)}`);
	return resourceClient.patch(resource.metadata.name, patch);
}

function createHandleUpdate(configMapResourceClient: ResourceClient<ConfigMapPayload>, targetResourceClients: Array<ResourceClient<BaseDeploymentPayload>>) {
	// type:name -> timeout reference when that will be updated.
	const pendingUpdates: {[resourceTypeColonName: string]: PendingUpdate} = {};

	return async (type: string, oldResource: K8sResource<ConfigMapPayload|SecretPayload>|undefined, resource: K8sResource<ConfigMapPayload|SecretPayload>|undefined) => {
		// Find all things that care about this resource.
		const updatedResource = (resource || oldResource)!;

		// Check whether this is an actual update, or whether we have seen it already
		const configMap = await configMapResourceClient.get(argv.configmap);
		const configMapEntryName = `${type}_${updatedResource.metadata.name}`;
		const knownHash = (configMap.data || {})[configMapEntryName];
		const updatedHash = calculateHash(updatedResource.data || {});
		if (knownHash === updatedHash) {
			logger.trace(`Ignoring reported change in ${type}:${updatedResource.metadata.name}, hash values are equal (${knownHash})`);
			return;
		}
		logger.debug(`Checking for affected resources for update of ${type}:${updatedResource.metadata.name}`);
		configMapResourceClient.patch(argv.configmap, {data: {[configMapEntryName]: updatedHash}});

		for (const targetResourceClient of targetResourceClients) {
			const targetResourceList = await targetResourceClient.list();
			const targetResourceMeta = {apiVersion: targetResourceClient.apiVersion, kind: targetResourceClient.kind};
			const targetResources = targetResourceList.items.map(item => Object.assign({}, targetResourceMeta, item));
			for (const targetResource of targetResources) {
				if (dependsOn(targetResource, updatedResource)) {
					// Schedule an update for this one, or modify it.
					const resourceTypeColonName = `${targetResource.apiVersion}.${targetResource.kind}:${targetResource.metadata.name}`;
					logger.debug(`Scheduling update for ${resourceTypeColonName}`);
					let pendingUpdate = pendingUpdates[resourceTypeColonName];
					if (pendingUpdate) {
						clearTimeout(pendingUpdate.timeout);
					}
					pendingUpdate = {
						timeout: setTimeout(() => {
							executeResourceUpdate(targetResourceClient, targetResource, pendingUpdate.updatedResources);
							delete pendingUpdates[resourceTypeColonName];
						}, 5000),
						updatedResources: [
							...(pendingUpdate ? pendingUpdate.updatedResources : []),
							updatedResource,
						],
					};
					pendingUpdates[resourceTypeColonName] = pendingUpdate;
				}
			}
		}
	};
}

const app = express();
app.use(prometheusBundle({
	promClient: {
		collectDefaultMetrics: {
			timeout: 5000,
		},
	},
}));

const server = createServer(app);
const listener = server.listen(argv.port, async () => {
	try {
		const k8sConfig = createK8sConfig(argv);
		const k8sClient = await k8s(k8sConfig);

		const configMapResourceClient = createResourceClient<ConfigMapPayload>(k8sClient, '/v1.ConfigMap', argv.namespace as string);

		// Create clients for each target
		const targetResourceClients = targetResourceTypes.map(targetResourceType => createResourceClient<BaseDeploymentPayload>(k8sClient, targetResourceType, argv.namespace as string));
		const handleUpdate = createHandleUpdate(configMapResourceClient, targetResourceClients);

		// Start a monitoring loop for each of the allowed resources
		Object.keys(configResourceTypesToAnnotations)
			.filter(configResourceType => !argv['ignored-config-resource-types'].includes(configResourceType))
			.forEach(configResourceType => {
				const resourceK8sClient = createResourceClient<ConfigMapPayload|SecretPayload>(k8sClient, configResourceType, argv.namespace as string);
				resourceLoop(configResourceType, resourceK8sClient, handleUpdate);
			});

		const address = listener.address()!;
		logger.info(`${pkg.name} ${pkg.version} ready on port ${typeof address === 'string' ? address : address.port}`);
	} catch (err) {
		logger.error(`Uncaught error, aborting: ${err.message}`);
		process.exit(1);
	}
});
