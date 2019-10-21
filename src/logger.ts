import { basename, relative } from 'path';

import { GetCallerModule as getCallerModule } from 'caller-module';
import { getLogger } from 'log4js';

export function getModuleLogger(logger?: string) {
	const callerModule = getCallerModule();
	if (!logger) {
		// TODO: Use path.relative/path.basename to translate callerModule.path against callerModule.root
		logger = basename(relative(callerModule.name, callerModule.root));
	}
	return getLogger(`${callerModule.name}.${logger}`);
}
