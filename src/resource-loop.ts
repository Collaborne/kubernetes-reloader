import { getModuleLogger } from './logger';

const logger = getModuleLogger();

interface WatchItem {
	type: 'ADDED'|'MODIFIED'|'DELETED'|'ERROR';
	object: any;
}

export async function resourceLoop(type: string, resourceK8sClient: /* XXX */ any) {
	const list = await resourceK8sClient.list();
	const resourceVersion = list.metadata.resourceVersion;

	// Treat all resources we see as "update", which will trigger a creation/update of attributes accordingly.
	for (const resource of list.items) {
		const name = resource.metadata.name;

		// TODO: Do something now
	}

	// Start watching the resources from that version on
	logger.info(`Watching ${type} at ${resourceVersion}...`);
	resourceK8sClient.watch(resourceVersion)
		.on('data', (item: WatchItem) => {
			const resource = item.object;
			const name = resource.metadata.name;

			let next;

			switch (item.type) {
			case 'ADDED':
				logger.info(`[${name}]: Creating resource`);
				break;
			case 'MODIFIED':
				logger.info(`[${name}]: Updating resource attributes`);
				break;
			case 'DELETED':
				logger.info(`[${name}]: Deleting resource`);
				break;
			case 'ERROR':
				// Log the message, and continue: usually the stream would end now, but there might be more events
				// in it that we do want to consume.
				logger.warn(`Error while watching: ${item.object.message}, ignoring`);
				return;
			default:
				logger.warn(`Unkown watch event type ${item.type}, ignoring`);
				return;
			}
		})
		.on('end', () => {
			// Restart the watch from the last known version.
			logger.info(`Watch of ${type} ended, restarting`);
			resourceLoop(type, resourceK8sClient);
		});
}
