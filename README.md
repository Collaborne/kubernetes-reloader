# kubernetes-reloader [![Build Status](https://travis-ci.com/Collaborne/kubernetes-reloader.svg?branch=master)](https://travis-ci.com/Collaborne/kubernetes-reloader)

A tool similar to <https://github.com/fabric8io/configmapcontroller> and <https://github.com/stakater/Reloader>, with some improved behaviors specifically for our deployment approach using <https://github.com/Collaborne/kubernetes-bootstrap>.

The main differences:

* State for all monitored configmaps and secrets is kept in a dedicated configmap _outside_ of the deployment, so that it can handle updates that replace the environment variables slightly better, and will not trigger a forced rebuild just because the environment variable is missing. A replacement of a deployment that was once reloaded would still trigger another reload though because the environment variable was removed.
* Coalesces multiple reloads that become needed due to multiple updates of configmaps and secrets
* Less network and memory use due to caching of the target deployments, daemonsets, and statefulsets
* Prometheus metrics exposed at `:8080/metrics`

## Approach

The reloader keeps the hash of the contents for each configuration resource in a separate configmap. The entries in that configmap are named `CONFIGAPIVERSION.CONFIGKIND_CONFIGNAME`, and the value of such an entry is the SHA1 of the (sorted and joined) key-value pairs of the referenced configuration.

The reloader watches the configuration resources for changes, and when Kubernetes reports a change will calculate the new SHA value, then list all dependents of each type, and then for each noticed diversion between the new SHA value and the stored SHA value will enqueue an update operation (through adding or updating a environment variable of the form `_RELOADER_-CONFIGTYPE-CONFIGNAME` with the new SHA value)

To avoid multiple updates in quick succession an update will only execute if there were no other needed updates for the same resource in a given window.

## Deployment in Kubernetes

```yaml
# Based on https://github.com/stakater/Reloader/blob/v0.0.24/deployments/kubernetes/reloader.yaml, adapted
# for Collaborne/kubernetes-reloader
apiVersion: v1
kind: ServiceAccount
metadata:
  namespace: NAMESPACE
  name: reloader
---
apiVersion: v1
kind: ConfigMap
metadata:
  namespace: NAMESPACE
  name: reloader-state
data: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: NAMESPACE
  name: reloader
  labels:
    service: reloader
spec:
  replicas: 1
  selector:
    matchLabels:
      service: reloader
  template:
    metadata:
      labels:
        service: reloader
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '8080'
    spec:
      serviceAccountName: reloader
      containers:
      - image: Collaborne/kubernetes-reloader:latest
        imagePullPolicy: Always
        name: reloader
        args:
        - --port=8080
        - --namespace=$(KUBERNETES_NAMESPACE)
        - --configmap=reloader-state
        # Set these if needed
        #- --alternative-configmap-annotation=configmap.reloader.stakater.com/reload
        #- --alternative-secret-annotation=secret.reloader.stakater.com/reload
        # Increase the time for coalescing, should only be needed for big deployments
        #- --coalesce-period=10000
        env:
        - name: KUBERNETES_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        ports:
        - name: http
          containerPort: 8080
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: NAMESPACE
  name: reloader
rules:
- apiGroups:
  - ""
  resources:
  - secrets
  - configmaps
  verbs:
  - list
  - get
  - watch
- apiGroups:
  - ""
  resources:
  - configmaps
  resourceNames:
  - reloader-state
  verbs:
  - patch
- apiGroups:
  - extensions
  - apps
  resources:
  - deployments
  - daemonsets
  - statefulsets
  verbs:
  - list
  - get
  - update
  - patch
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: NAMESPACE
  name: reloader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: reloader
subjects:
- kind: ServiceAccount
  name: reloader
  namespace: NAMESPACE
```
