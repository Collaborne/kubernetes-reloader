declare interface WatchItem {
	type: 'ADDED'|'MODIFIED'|'DELETED'|'ERROR';
	object: any;
}

declare interface K8sResourceMeta {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace?: string;
		labels?: {[label: string]: string};
		annotations?: {[annotation: string]: string};
		resourceVersion?: string;
	};
}
declare type K8sResource<Payload extends {} = {}> = K8sResourceMeta & Payload; 


declare interface K8sListPayload<ItemPayload extends {} = {}> {
	items: Array<K8sResource<ItemPayload>>;
}

declare type NodeJSEventEmitter = import('events').EventEmitter;
declare interface K8sResourceWatch<Payload extends {} = {}> extends NodeJSEventEmitter {
	// Nothing more yet
}

declare interface JSONPatchEntry {
	op: 'replace'|'remove'|'add'|'copy'|'move'|'test';
	path: string;
	value?: any;
} 

declare module 'auto-kubernetes-client';
