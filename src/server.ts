#!/usr/bin/env node

import { createServer } from 'http';
import { resolve } from 'path';

import k8s from 'auto-kubernetes-client';
import express from 'express';
import prometheusBundle from 'express-prom-bundle';
import { configure } from 'log4js';
import yargs from 'yargs';

import { createCachedResourceClient } from './cached-resource-client';
import { createManagedConfigmapHashStore } from './hash-store';
import { createK8sConfig } from './kubernetes';
import { getModuleLogger } from './logger';
import { BaseDeploymentPayload, ConfigMapPayload, createHandleUpdate, SecretPayload } from './reloader';
import { createResourceClient } from './resource-client';
import { resourceLoop } from './resource-loop';

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
	.describe('ignored-config-resource-types', 'Configuration resource types to ignore').array('ignored-config-resource-types').default('ignored-config-resource-types', [])
	.describe('coalesce-period', 'Period in milliseconds for which to wait for additional changes before updating a target resource').number('coalesce-period').default('coalesce-period', 5000).demandOption('coalesce-period')
	.help()
	.argv;

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

function isMonitoredConfigResource(resourceType: string) {
	if (!configResourceTypesToAnnotations[resourceType]) {
		return false;
	}

	const ignoredConfigResourceTypes = argv['ignored-config-resource-types'] as string[];
	return (!ignoredConfigResourceTypes.includes(resourceType));
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

		const configMapResourceClient = createResourceClient<ConfigMapPayload>(k8sClient, 'v1.ConfigMap', argv.namespace as string);
		const hashStore = createManagedConfigmapHashStore(configMapResourceClient, argv.configmap);

		// Create clients for each target
		const targetResourceClients = targetResourceTypes
			.map(targetResourceType => createResourceClient<BaseDeploymentPayload>(k8sClient, targetResourceType, argv.namespace as string))
			.map(createCachedResourceClient);
		const handleUpdate = createHandleUpdate(configResourceTypesToAnnotations, hashStore, targetResourceClients, argv['coalesce-period']);

		// Start a monitoring loop for each of the allowed resources
		Object.keys(configResourceTypesToAnnotations)
			.filter(isMonitoredConfigResource)
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

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
	logger.fatal(`Unhandled promise rejection with ${reason}, aborting`, promise);
	// Actually abort right now: In the worst case we'll end up in the orchestration layer and get restarted,
	// which is way better than eating out errors.
	// This may affect "correct" unhandled rejections from fancy promises code, but these need to be reviewed
	// whether they are really the best thing.
	process.exit(1);
});
