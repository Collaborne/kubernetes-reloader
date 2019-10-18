import { getModuleLogger } from './logger';
import { ResourceClient } from './resource-client';
import { resourceLoop } from './resource-loop';

const logger = getModuleLogger();

export function createCachedResourceClient<Payload>(resourceClient: ResourceClient<Payload>): ResourceClient<Payload> {
	const initialListPromise = resourceClient.list();
	let latestResourceVersion: string;
	const itemsByName: {[name: string]: Omit<K8sResource<Payload>, 'apiVersion'|'kind'>} = {};

	resourceLoop(`${resourceClient.apiVersion}.${resourceClient.kind}`, resourceClient, async (type, oldResource, updatedResource, resourceVersion) => {
		latestResourceVersion = resourceVersion;
		if (updatedResource) {
			const { apiVersion, kind, ...item } = updatedResource;
			itemsByName[updatedResource.metadata.name] = item;
		} else {
			delete itemsByName[oldResource!.metadata.name];
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
			logger.trace(`Synthesized list response for ${resourceClient.apiVersion}.${resourceClient.kind} at ${latestResourceVersion} with ${result.items.length} items`);
			return result;
		},
	});
}
