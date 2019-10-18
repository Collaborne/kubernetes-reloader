#!/usr/bin/env node

import { createServer } from 'http';
import { resolve } from 'path';

import k8s from 'auto-kubernetes-client';
import express from 'express';
import prometheusBundle from 'express-prom-bundle';
import { configure } from 'log4js';
import yargs from 'yargs';

import { createK8sConfig } from './kubernetes';
import { getModuleLogger } from './logger';
import { resourceLoop } from './resource-loop';

configure(process.env.LOG4JS_CONFIG || resolve(__dirname, '../log4js.json'));

const logger = getModuleLogger();

const argv = yargs
	.alias('s', 'server').describe('server', 'The address and port of the Kubernetes API server')
	.alias('cacert', 'certificate-authority').describe('certificate-authority', 'Path to a cert. file for the certificate authority')
	.alias('cert', 'client-certificate').describe('client-certificate', 'Path to a client certificate file for TLS')
	.alias('key', 'client-key').describe('client-key', 'Path to a client key file for TLS')
	.boolean('insecure-skip-tls-verify').describe('insecure-skip-tls-verify', 'If true, the server\'s certificate will not be checked for validity. This will make your HTTPS connections insecure')
	.describe('token', 'Bearer token for authentication to the API server')
	.describe('namespace', 'The namespace to watch').demandOption('namespace')
	.array('resource-type').describe('resource-type', 'Enabled resource types (empty to enable all, can use multiple times)').default('resource-type', [])
	.number('port').default('port', process.env.PORT || 8080)
	.help()
	.argv;

const app = express();

app.use(prometheusBundle({
	promClient: {
		collectDefaultMetrics: {
			timeout: 5000,
		},
	},
}));

const server = createServer(app);
const listener = server.listen(argv.port, () => {
	const k8sConfig = createK8sConfig(argv);
	k8s(k8sConfig).then(k8sClient => {


		const resourceLoopPromises = resourceDescriptions.map(resourceDescription => {
			const awsResourcesK8sClient = k8sClient.group('aws.k8s.collaborne.com', 'v1').ns(argv.namespace);
			const resourceK8sClient = awsResourcesK8sClient[resourceDescription.type];
			if (!resourceK8sClient) {
				// XXX: Is this a failure?
				logger.error(`Cannot create client for resources of type ${resourceDescription.type}: Available resources: ${Object.keys(awsResourcesK8sClient)}.`);
				return Promise.reject(new Error(`Missing kubernetes client for ${resourceDescription.type}`));
			}

			const promisesQueue = new PromisesQueue();
			return resourceLoop(resourceDescription.type, resourceK8sClient, resourceDescription.resourceClient, promisesQueue).catch(err => {
				logger.error(`Error when monitoring resources of type ${resourceDescription.type}: ${err.message}`);
				throw err;
			});
		});

		// XXX: The promises now all start, but technically they might fail quickly if something goes wrong.
		//      For the purposes of logging things though we're "ready" now.
		logger.info(`${pkg.name} ${pkg.version} ready on port ${listener.address().port}`);

		return Promise.all(resourceLoopPromises);
	}).catch(err => {
		logger.error(`Uncaught error, aborting: ${err.message}`);
		process.exit(1);
	});
});
