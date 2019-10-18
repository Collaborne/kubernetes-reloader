import { getModuleLogger } from './logger';
import { ConfigMapPayload } from './reloader';
import { ResourceClient } from './resource-client';

export interface HashStore {
	isSelf(resource: K8sResource): boolean;
	get(resource: K8sResource): Promise<string|undefined>;
	update(resource: K8sResource, newValue: string): Promise<boolean>;
}

const logger = getModuleLogger();

function isManagedConfigmap(managedConfigMapName: string, resource: K8sResource) {
	return resource.apiVersion === 'v1' && resource.kind === 'ConfigMap' && resource.metadata.name === managedConfigMapName;
}

/** @visibleForTesting */
export function calculateConfigMapEntryName(resource: K8sResource) {
	return `${resource.apiVersion}.${resource.kind}_${resource.metadata.name}`.replace(/[^-._a-zA-Z0-9]+/g, '_');
}

export function createManagedConfigmapHashStore(configMapResourceClient: ResourceClient<ConfigMapPayload>, managedConfigMapName: string): HashStore {
	const uncommitted: {[entry: string]: string} = {};
	const fetchPromise = new Promise<{[entry: string]: string}>(async resolve => {
		logger.info(`Fetching managed configmap ${managedConfigMapName}`);
		try {
			const configMap = await configMapResourceClient.get(managedConfigMapName);
			resolve(configMap.data || {});
		} catch (err) {
			logger.info(`Error in fetching managed configmap ${managedConfigMapName}: ${err.message}`);
			logger.info(`Trying to create managed configmap ${managedConfigMapName}`);
			await configMapResourceClient.create({
				apiVersion: 'v1',
				kind: 'ConfigMap',
				metadata: {
					name: managedConfigMapName,
				},

				data: {},
			});
			resolve({});
		}
	});

	return {
		isSelf(resource: K8sResource) {
			return isManagedConfigmap(managedConfigMapName, resource);
		},
		async get(resource: K8sResource) {
			const entryName = calculateConfigMapEntryName(resource);

			const cache = await fetchPromise;

			// Prefer the uncommitted content, only if there is nothing for that entry go to the cache
			// XXX: Should we "once-in-while" try to sync the cache again? What would happen to the uncommitted items?
			return uncommitted[entryName] || cache[entryName];
		},
		async update(resource: K8sResource, newValue: string) {
			const entryName = calculateConfigMapEntryName(resource);

			uncommitted[entryName] = newValue;
			try {
				await configMapResourceClient.patch(managedConfigMapName, {data: {[entryName]: newValue}});
				const cache = await fetchPromise;
				cache[entryName] = newValue;
				if (uncommitted[entryName] === newValue) {
					delete uncommitted[entryName];
				}
				return true;
			} catch (err) {
				// XXX: We should probably record that this entry failed to update somewhere here.
				logger.warn(`Cannot update ${managedConfigMapName} for entry ${entryName}=${newValue}: ${err.message}`);
				throw err;
			}
		},
	};
}
