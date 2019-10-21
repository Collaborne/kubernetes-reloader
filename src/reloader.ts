import { calculateHash } from './hash';
import { HashStore } from './hash-store';
import { getModuleLogger } from './logger';
import { ResourceClient } from './resource-client';

const logger = getModuleLogger();

const ENV_PREFIX = '_RELOADER_';

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

export interface BaseDeploymentPayload {
	spec: {
		template: PodTemplateSpec;
	};
}

export interface ConfigMapPayload {
	data?: {[key: string]: string};
}

export interface SecretPayload {
	data?: {[key: string]: string};
}

/** @visibleForTesting */
export function calculateEnvVarName(prefix: string, resource: K8sResource) {
	return `${prefix}_${resource.kind}_${resource.metadata.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** @visibleForTesting */
export function calculateResourceType(resource: K8sResource) {
	return `${resource.apiVersion}.${resource.kind}`;
}

export function calculateResourceTypeColonName(resource: K8sResource) {
	return `${calculateResourceType(resource)}:${resource.metadata.name}`;
}

function dependsOn(configResourceTypesToAnnotations: {[resourceType: string]: string[]}, targetResource: K8sResource, updatedResource: K8sResource) {
	// Check annotations of targetResource whether it should get updated on the updatedResource
	const updatedResourceType = calculateResourceType(updatedResource);
	const annotations = configResourceTypesToAnnotations[updatedResourceType];
	if (!annotations) {
		logger.warn(`Unexpected resource type ${updatedResourceType}`);
		return false;
	}

	if (!targetResource.metadata.annotations || Object.keys(targetResource.metadata.annotations).length === 0) {
		logger.trace(`No annotations on ${calculateResourceTypeColonName(targetResource)}`);
		return false;
	}

	let annotationValue;
	for (const annotation of annotations) {
		annotationValue = targetResource.metadata.annotations[annotation];
		if (annotationValue) {
			logger.trace(`Found ${annotation} on ${calculateResourceTypeColonName(targetResource)}`);
			break;
		}
	}
	if (!annotationValue) {
		logger.trace(`None of ${annotations} on ${calculateResourceTypeColonName(targetResource)}`);
		return false;
	}

	const names = annotationValue.split(',');
	return names.includes(updatedResource.metadata.name);
}

interface PendingUpdate {
	timeout: NodeJS.Timeout;
	updatedResources: Array<K8sResource<ConfigMapPayload|SecretPayload>>;
}

async function executeResourceUpdate(resourceClient: ResourceClient<BaseDeploymentPayload>, resource: K8sResource<BaseDeploymentPayload>, updatedResources: Array<K8sResource<ConfigMapPayload|SecretPayload>>) {
	// For each of the updated resources add or update the environment variable with the SHA for that resource,
	// and then do an actual update request.
	const resourceTypeColonName = calculateResourceTypeColonName(resource);
	logger.info(`Executing update for ${resourceTypeColonName} (${updatedResources.map(calculateResourceTypeColonName).join(',')})`);

	const containerEnvVars: {[containerName: string]: EnvVar[]} = {};

	// For each of the updated resources: Find a suitable container, and then add the update.
	for (const updatedResource of updatedResources) {
		const envVarName = calculateEnvVarName(ENV_PREFIX, updatedResource);
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
		containerEnvVars[containerToUpdate.name] = [
			...envVars,
			{name: envVarName, value: calculateHash(updatedResource.data || {})},
		];
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
	logger.debug(`Updating ${resourceTypeColonName} with ${JSON.stringify(patch)}`);
	try {
		await resourceClient.patch(resource.metadata.name, patch);
	} catch (err) {
		logger.error(`Cannot update ${resourceTypeColonName}: ${err.message}`);
	}
}

export function createHandleUpdate(configResourceTypesToAnnotations: {[resourceType: string]: string[]}, hashStore: HashStore, targetResourceClients: Array<ResourceClient<BaseDeploymentPayload>>, coalescePeriod: number) {
	// type:name -> timeout reference when that will be updated.
	const pendingUpdates: {[resourceTypeColonName: string]: PendingUpdate} = {};

	return async (type: string, oldResource: K8sResource<ConfigMapPayload|SecretPayload>|undefined, resource: K8sResource<ConfigMapPayload|SecretPayload>|undefined) => {
		// Find all things that care about this resource.
		const updatedResource = (resource || oldResource)!;

		// Skip changes in our own configmap
		if (hashStore.isSelf(updatedResource)) {
			logger.trace(`Ignoring change in hash store (${calculateResourceTypeColonName(updatedResource)})`);
			return;
		}

		// Check whether this is an actual update, or whether we have seen it already
		const knownHash = await hashStore.get(updatedResource);
		const updatedHash = calculateHash(updatedResource.data || {});
		if (knownHash === updatedHash) {
			logger.trace(`Ignoring reported change in ${calculateResourceTypeColonName(updatedResource)}, hash values are equal (${knownHash})`);
			return;
		}
		logger.debug(`Updated ${calculateResourceTypeColonName(updatedResource)}, searching for dependents`);

		/** Whether the resource needs tracking or not right now */
		// This avoids filling the configmap with entries for irrelevant and left-over resources such as secrets for service
		// accounts that are not actually used by anything.
		let dependents = 0;
		for (const targetResourceClient of targetResourceClients) {
			const targetResourceList = await targetResourceClient.list();
			const targetResourceMeta = {apiVersion: targetResourceClient.apiVersion, kind: targetResourceClient.kind};
			const targetResources = targetResourceList.items.map(item => Object.assign({}, targetResourceMeta, item));
			for (const targetResource of targetResources) {
				if (dependsOn(configResourceTypesToAnnotations, targetResource, updatedResource)) {
					// Mark this resource as having dependents, i.e. we need to remember the hash
					dependents++;

					// Schedule an update for this one, or modify it.
					const resourceTypeColonName = calculateResourceTypeColonName(targetResource);
					logger.debug(`Scheduling update for ${resourceTypeColonName}`);
					let pendingUpdate = pendingUpdates[resourceTypeColonName];
					if (pendingUpdate) {
						logger.debug(`Coalescing update for ${resourceTypeColonName} with already scheduled update`);
						clearTimeout(pendingUpdate.timeout);
					}
					pendingUpdate = {
						timeout: setTimeout(() => {
							executeResourceUpdate(targetResourceClient, targetResource, pendingUpdate.updatedResources);
							delete pendingUpdates[resourceTypeColonName];
						}, coalescePeriod),
						updatedResources: [
							...(pendingUpdate ? pendingUpdate.updatedResources : []),
							updatedResource,
						],
					};
					pendingUpdates[resourceTypeColonName] = pendingUpdate;
				}
			}
		}

		if (dependents > 0) {
			logger.info(`Updated ${calculateResourceTypeColonName(updatedResource)} with ${dependents} dependents, recording hash ${updatedHash}`);
			hashStore.update(updatedResource, updatedHash).catch(err => {
				// Bad luck, we will likely do the update again when the resource updates again.
				// Nonetheless this error doesn't stop the actual updating.
				logger.warn(`Failed to update hash store for ${calculateResourceTypeColonName(updatedResource)}: ${err.message}`);
			});
		}
	};
}
