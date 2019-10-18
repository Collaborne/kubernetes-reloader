export interface ResourceClient<Payload extends {} = {}> {
	apiVersion: string;
	kind: string;

	list(): Promise<K8sResource<K8sListPayload<Payload>>>;
	create(spec: K8sResource<Payload>): Promise<K8sResource<Payload>>;
	watch(resourceVersion?: string): K8sResourceWatch<Payload>;

	get(name: string): Promise<K8sResource<Payload>>;
	patch(name: string, patch: Partial<K8sResource<Payload>>|JSONPatchEntry[]): /* XXX */ Promise<void>;
}

export function createResourceClient<Payload>(k8sClient: any, resourceType: string, ns?: string): ResourceClient<Payload> {
	const RE = /(((.*)\/)?(.+))\.([^\.]+)/;
	const match = RE.exec(resourceType);
	if (!match) {
		throw new Error(`Invalid qualified name ${resourceType}`);
	}
	const groupName = match[3] ? match[1] : match[4];
	const kind = match[5];
	let groupK8sClient: any;
	if (ns) {
		groupK8sClient = k8sClient.group(groupName).ns(ns);
	} else {
		groupK8sClient = k8sClient.group(groupName);
	}

	// Now wrap this to make it easier to work with:
	const kindLower = kind.toLowerCase();
	const { create, list, watch } = groupK8sClient[`${kindLower}s`];
	const get = (name: string) => groupK8sClient[kindLower](name).get();
	const patch = (name: string, p: object) => groupK8sClient[kindLower](name).patch(p);
	return {
		apiVersion: groupName,
		kind,

		create,
		get,
		list,
		patch,
		watch,
	};
}
