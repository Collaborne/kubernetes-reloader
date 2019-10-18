import { sep } from 'path';

import { GetCallerModule as getCallerModule } from 'caller-module';
import { getLogger, Logger } from 'log4js';

interface CallerModuleData {
	name: string;
	root: string;
	path: string;
}

export function getModuleLogger(logger?: string, callerModuleData: CallerModuleData = getCallerModule(2)): Logger {
	if (!logger) {
		// Strip the common prefix + one directory level (src/test/build/...)
		const rootSegments = callerModuleData.root.split(sep);
		const pathSegments = callerModuleData.path.split(sep);
		let i = 0;
		while (i < rootSegments.length && i < pathSegments.length && rootSegments[i] === pathSegments[i]) {
			i++;
		}
		i++;
		if (i < pathSegments.length) {
			// Trim the extension from the last segment, and join the pieces
			const name = pathSegments[pathSegments.length - 1];
			pathSegments[pathSegments.length - 1] = name.substring(0, name.lastIndexOf('.'));
			logger = pathSegments.slice(i).join('.');
		} else {
			logger = 'UNKNOWN';
		}
	}
	return getLogger(`${callerModuleData.name}.${logger}`);
}
