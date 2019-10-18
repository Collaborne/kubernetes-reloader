import { expect } from 'chai';
import 'mocha';

import { Logger } from 'log4js';

import { getModuleLogger } from '../src/logger';

function getCategory(logger: Logger) {
	// Poke into the internals of Log4JS to get the logger name back.
	// tslint:disable-next-line: no-string-literal
	return (logger as any)['category'];
}

describe('logger', () => {
	describe('getModuleLogger', () => {
		it('uses the provided logger name', () => {
			const logger = getModuleLogger('test');
			expect(getCategory(logger)).to.be.equal('@collaborne/kubernetes-reloader.test');
		});
		it('determines the logger name from the caller', () => {
			const logger = getModuleLogger();
			expect(getCategory(logger)).to.be.equal('@collaborne/kubernetes-reloader.logger.spec');
		});
		it('trims .ts extension', () => {
			const logger = getModuleLogger('', {
				name: '@collaborne/kubernetes-reloader',
				path: 'path/test/test.ts',
				root: 'path',
			});
			expect(getCategory(logger)).to.be.equal('@collaborne/kubernetes-reloader.test');
		});
		it('trims .js extension', () => {
			const logger = getModuleLogger('', {
				name: '@collaborne/kubernetes-reloader',
				path: 'path/test/test.ts',
				root: 'path',
			});
			expect(getCategory(logger)).to.be.equal('@collaborne/kubernetes-reloader.test');
		});
	});
});
