import { getModuleLogger } from './logger';
import { ResourceClient } from './resource-client';

const logger = getModuleLogger();

type UpdateCallback<Payload extends {} = {}> = (type: string, oldResource: K8sResource<Payload>|undefined, newResource: K8sResource<Payload>|undefined, resourceVersion: string) => any;

export async function resourceLoop<Payload extends {} = {}>(type: string, resourceClient: ResourceClient<Payload>, onUpdate: UpdateCallback<Payload>) {
	return innerResourceLoop(type, resourceClient, onUpdate, {});
}

async function innerResourceLoop<Payload extends {} = {}>(type: string, resourceClient: ResourceClient<Payload>, onUpdate: UpdateCallback<Payload>, resourcesByName: {[name: string]: K8sResource<Payload>}) {
	const list = await resourceClient.list();
	const initialResourceVersion = list.metadata.resourceVersion!;

	// Map the resources by name, so we can easily look them up. We expose the changes as "update" to our client.
	// At the same time we want to report all resources, so that the handler can check whether they got updated
	// while we were not watching.
	for (const item of list.items) {
		const name = item.metadata.name;
		// Listing resources doesn't return the apiVersion/kind, as they are implicit in the type of list.
		// For our purposes these items now stop being part of the list, and so we need these fields as well.
		// XXX: Why is the '... as' needed here?
		const resource = Object.assign({ apiVersion: resourceClient.apiVersion, kind: resourceClient.kind }, item) as K8sResource<Payload>;

		// Report the resource, either as modification or as add.
		onUpdate(type, resourcesByName[name], resource, initialResourceVersion);
		resourcesByName[name] = resource;
	}

	// Start watching the resources from that version on
	logger.info(`Watching ${type} at ${initialResourceVersion}...`);
	resourceClient.watch(initialResourceVersion)
		.on('data', (item: WatchItem) => {
			const resource = item.object;
			const name = resource.metadata.name;
			const resourceVersion = resource.metadata.resourceVersion;

			switch (item.type) {
			case 'ADDED':
				logger.debug(`Created resource ${resourceClient.apiVersion}.${resourceClient.kind}:${name}`);
				onUpdate(type, undefined, resource, resourceVersion);
				break;
			case 'MODIFIED':
				logger.debug(`Updated resource ${resourceClient.apiVersion}.${resourceClient.kind}:${name}`);
				onUpdate(type, resourcesByName[name], resource, resourceVersion);
				break;
			case 'DELETED':
				logger.debug(`Deleted resource ${resourceClient.apiVersion}.${resourceClient.kind}:${name}`);
				onUpdate(type, resourcesByName[name], undefined, resourceVersion);
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
			innerResourceLoop(type, resourceClient, onUpdate, resourcesByName);
		});
}
