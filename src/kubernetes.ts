import fs from 'fs';
import path from 'path';

interface K8sServerArgs {
	server: string;
	insecureSkipTlsVerify?: boolean;
	certificateAuthority?: string;
}

interface K8sTokenAuthArgs {
	token: string;
}
function isTokenAuthArgs(o: any): o is K8sTokenAuthArgs {
	return Boolean(o.token);
}

interface K8sUserPasswordAuthArgs {
	username: string;
	password: string;
}
function isUserPasswordAuthArgs(o: any): o is K8sUserPasswordAuthArgs {
	return Boolean(o.username) && Boolean(o.password);
}

interface K8sClientCertificateAuthArgs {
	clientCertificate: string;
	clientKey: string;
}
function isClientCertificateAuthArgs(o: any): o is K8sClientCertificateAuthArgs {
	return Boolean(o.clientCertificate) && Boolean(o.clientKey);
}

type K8sArgs = K8sServerArgs & (K8sTokenAuthArgs | K8sUserPasswordAuthArgs | K8sClientCertificateAuthArgs);

function createK8sConfigWithServer(args: K8sArgs) {
	const k8sConfig: {[key: string]: any} = {
		rejectUnauthorized: !Boolean(args.insecureSkipTlsVerify),
		url: args.server,
	};
	if (args.certificateAuthority) {
		k8sConfig.ca = fs.readFileSync(args.certificateAuthority, 'utf8');
	}
	if (isTokenAuthArgs(args)) {
		k8sConfig.auth = {
			bearer: args.token,
		};
	} else if (isUserPasswordAuthArgs(args)) {
		k8sConfig.auth = {
			pass: args.password,
			user: args.username,
		};
	} else if (isClientCertificateAuthArgs(args)) {
		k8sConfig.cert = fs.readFileSync(args.clientCertificate, 'utf8');
		k8sConfig.key = fs.readFileSync(args.clientKey, 'utf8');
	}

	return k8sConfig;
}

function createK8sConfigFromEnvironment(env: NodeJS.ProcessEnv) {
	// Runs in Kubernetes
	const credentialsPath = '/var/run/secrets/kubernetes.io/serviceaccount/';
	return {
		auth: {
			bearer: fs.readFileSync(path.resolve(credentialsPath, 'token'), 'utf8'),
		},
		ca: fs.readFileSync(path.resolve(credentialsPath, 'ca.crt'), 'utf8'),
		url: `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT}`,
	};
}

/**
 * Creates basic configuration for accessing the Kubernetes API server
 *
 * @param args Command line arguments
 * @returns Kubernetes client configuration
 */
export function createK8sConfig(argv: any) {
	let k8sConfig;
	if (argv.server) {
		// For local development
		k8sConfig = createK8sConfigWithServer(argv as K8sArgs);
	} else if (process.env.KUBERNETES_SERVICE_HOST) {
		k8sConfig = createK8sConfigFromEnvironment(process.env);
	} else {
		throw new Error('Unknown Kubernetes API server');
	}

	return k8sConfig;
}
