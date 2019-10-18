import { GetCallerModule as getCallerModule } from 'caller-module';
import { getLogger } from 'log4js';

// tslint:disable-next-line: no-var-requires
const pkg = require('../package.json');

export function getModuleLogger(name: string = getCallerModule().name) {
	return getLogger(`${pkg.name}.${name}`);
}
