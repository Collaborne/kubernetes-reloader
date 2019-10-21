import { ResourceClient } from './index';
import { getModuleLogger } from './logger';

const logger = getModuleLogger();

type UpdateCallback<Payload extends {} = {}> = (type: string, oldResource: K8sResource<Payload>|undefined, newResource: K8sResource<Payload>|undefined) => any;

export async function resourceLoop<Payload extends {} = {}>(type: string, resourceClient: ResourceClient<Payload>, onUpdate: UpdateCallback<Payload>) {
	const list = await resourceClient.list();
	const resourceVersion = list.metadata.resourceVersion;

	// Map the resources by name, so we can easily look them up. We expose the changes as "update" to our client.
	const resourcesByName = list.items.reduce((agg, resource) => {
		const name = resource.metadata.name;
		agg[name] = Object.assign({ apiVersion: resourceClient.apiVersion, kind: resourceClient.kind }, resource);
		return agg;
	}, {} as {[name: string]: K8sResource<Payload>});

	// XXX: Should we also report the adds?

	// Start watching the resources from that version on
	logger.info(`Watching ${type} at ${resourceVersion}...`);
	resourceClient.watch(resourceVersion)
		.on('data', (item: WatchItem) => {
			const resource = item.object;
			const name = resource.metadata.name;

			switch (item.type) {
			case 'ADDED':
				logger.info(`[${resourceClient.apiVersion}.${resourceClient.kind}:${name}]: Created resource`);
				onUpdate(type, undefined, resource);
				break;
			case 'MODIFIED':
				logger.info(`[${resourceClient.apiVersion}.${resourceClient.kind}:${name}]: Updating resource attributes: ${JSON.stringify(resourcesByName[name])} -> ${JSON.stringify(resource)}`);
				onUpdate(type, resourcesByName[name], resource);
				break;
			case 'DELETED':
				logger.info(`[${resourceClient.apiVersion}.${resourceClient.kind}:${name}]: Deleting resource`);
				onUpdate(type, resourcesByName[name], undefined);
				break;
			case 'ERROR':
				// Log the message, and continue: usually the stream would end now, but there might be more events
				// in it that we do want to consume.
				logger.warn(`Error while watching: ${item.object.message}, ignoring`);
				return;
			default:
				logger.warn(`Unknown watch event type ${item.type}, ignoring`);
				return;
			}
			resourcesByName[name] = resource;
		})
		.on('end', () => {
			// Restart the watch from the last known version.
			logger.info(`Watch of ${type} ended, restarting`);
			resourceLoop(type, resourceClient, onUpdate);
		});
}
