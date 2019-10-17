# kubernetes-reloader

A tool similar to <https://github.com/fabric8io/configmapcontroller> and <https://github.com/stakater/Reloader>.

In contrast to these tools this reloader keeps information _outside_ of the deployment, so that it can handle updates that replace the environment variables.

## Approach

The reloader keeps status information for each {configmap, secret} <-> {deployment, daemonset, ...} link in a separate configmap. The entries in that configmap are named `CONTROLLERTYPE-CONTROLLERNAME-CONFIGTYPE-CONFIGNAME`, and the value of such an entry is the SHA1 of the (sorted and joined) key-value pairs of the referenced configuration.

The reloader watches the configuration types for changes, and when Kubernetes reports a change will calculate the new SHA value, then list all dependents of each type, and then for each noticed diversion between the new SHA value and the stored SHA value will enqueue an update operation (through adding or updating a environment variable of the form `_RELOADER_-CONFIGTYPE-CONFIGNAME` with the new SHA value)

To avoid multiple updates in quick succession an update will only execute if there were no other needed updates for the same resource in a given window.

### XXX

* Is scanning all dependents each time smart enough? We could also try to watch these things, and just process the currently known list.
* Instead of an environment variable we should also be able to trigger an update by a metadata-label change (on the pod level). It's probably not a good idea to try to implement an update controller on our side (i.e. do not replicate [`kubectl rollout restart`](https://github.com/kubernetes/kubernetes/pull/77423))
