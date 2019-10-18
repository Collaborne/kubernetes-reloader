import { expect } from 'chai';
import 'mocha';

import { calculateEnvVarName } from '../src/reloader';

describe('reloader', () => {
	describe('calculateEnvVarName', () => {
		it('includes the prefix', () => {
			const resource = {
				apiVersion: 'api',
				kind: 'type',
				metadata: {
					name: 'name',
				},
			};
			expect(calculateEnvVarName('prefix', resource)).to.be.equal('PREFIX_TYPE_NAME');
		});
		it('replaces invalid characters', () => {
			const resource = {
				apiVersion: 'api!+',
				kind: 'type?/',
				metadata: {
					name: 'foo:~',
				},
			};
			expect(calculateEnvVarName('prefix', resource)).to.be.equal('PREFIX_TYPE_FOO_');
		});
	});
});
