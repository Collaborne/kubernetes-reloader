import { expect } from 'chai';
import 'mocha';

import { calculateConfigMapEntryName } from '../src/hash-store';

describe('hash-store', () => {
	describe('calculateConfigMapEntryName', () => {
		it('retains capitalization and canonical naming as much as possible', () => {
			const resource = {
				apiVersion: 'test/v1',
				kind: 'SourceThing',
				metadata: {
					name: 'source',
				},
			};
			expect(calculateConfigMapEntryName(resource)).to.be.equal('test_v1.SourceThing_source');
		});
		it('replaces invalid characters', () => {
			const resource = {
				apiVersion: 'api!+',
				kind: 'type?/',
				metadata: {
					name: 'foo:~',
				},
			};
			expect(calculateConfigMapEntryName(resource)).to.be.equal('api_.type__foo_');
		});
	});
});
