import { createHash } from 'crypto';

export function calculateHash(data: {[key: string]: string}) {
	const shaSum = createHash('sha1');
	Object.entries(data).forEach(([key, value]) => {
		shaSum.update(`${key}=${value}`);
	});
	return shaSum.digest('hex');
}
