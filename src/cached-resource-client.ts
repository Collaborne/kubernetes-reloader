import { getModuleLogger } from './logger';
import { ResourceClient } from './resource-client';
import { resourceLoop } from './resource-loop';

const logger = getModuleLogger();

export function createCachedResourceClient<Payload>(resourceClient: ResourceClient<Payload>): ResourceClient<Payload> {
	const itemsByName: {[name: string]: Omit<K8sResource<Payload>, 'apiVersion'|'kind'>} = {};
	let latestResourceVersion: string;

	const resourceType = `${resourceClient.apiVersion}.${resourceClient.kind}`;

	// Do a list to get the needed apiVersion/kind of the list type, and to see the itemsByName
	// resourceLoop doesn't tell us when it is done with processing its own internal list() call,
	// and we need the contents to be correct before the first request to the list() of the cached resource
	// comes in.
	// Note that this will run in the background, and might therefore race with the updates from
	// resourceLoop().
	const initialListPromise = resourceClient.list().then(listResponse => {
		if (!latestResourceVersion && listResponse.metadata.resourceVersion) {
			latestResourceVersion = listResponse.metadata.resourceVersion;
		}
		for (const item of listResponse.items) {
			if (itemsByName[item.metadata.name]) {
				continue;
			}
			itemsByName[item.metadata.name] = item;
		}
		logger.debug(`Loaded ${listResponse.items.length} items for ${resourceType} at ${listResponse.metadata.resourceVersion}`);
		return listResponse;
	});

	resourceLoop(resourceType, resourceClient, async (type, oldResource, updatedResource, resourceVersion) => {
		latestResourceVersion = resourceVersion;
		if (updatedResource) {
			const { apiVersion, kind, ...item } = updatedResource;
			itemsByName[updatedResource.metadata.name] = item;
			logger.debug(`Updated ${resourceType}:${updatedResource.metadata.name} at ${resourceVersion}`);
		} else if (oldResource) {
			delete itemsByName[oldResource.metadata.name];
			logger.debug(`Deleted ${resourceType}:${oldResource.metadata.name} at ${resourceVersion}`);
		} else {
			logger.warn(`Unexpected update to ${resourceType} with neither old nor updated resource at ${resourceVersion}`);
		}
	});

	// Delegate all methods except for list, which in turn returns a snapshot of the itemsByName values.
	const { list, ...otherMethods } = resourceClient;
	return Object.assign(otherMethods, {
		async list() {
			const initialListResult = await initialListPromise;
			const result = {
				apiVersion: initialListResult.apiVersion,
				kind: initialListResult.kind,
				metadata: Object.assign({}, initialListResult.metadata, {resourceVersion: latestResourceVersion}),
				// tslint:disable-next-line: object-literal-sort-keys
				items: Object.values(itemsByName),
			};
			logger.trace(`Synthesized list response for ${resourceType} at ${latestResourceVersion} with ${result.items.length} items`);
			return result;
		},
	});
}
