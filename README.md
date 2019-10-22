# kubernetes-reloader

A tool similar to <https://github.com/fabric8io/configmapcontroller> and <https://github.com/stakater/Reloader>, with some improved behaviors specifically for our deployment approach using <https://github.com/Collaborne/kubernetes-bootstrap>.

The main differences:

* State for all monitored configmaps and secrets is kept in a dedicated configmap _outside_ of the deployment, so that it can handle updates that replace the environment variables slightly better, and will not trigger a forced rebuild just because the environment variable is missing. A replacement of a deployment that was once reloaded would still trigger another reload though because the environment variable was removed.
* Coalesces multiple reloads that become needed due to multiple updates of configmaps and secrets
* Less network and memory use due to caching of the target deployments, daemonsets, and statefulsets

## Approach

The reloader keeps the hash of the contents for each configuration resource in a separate configmap. The entries in that configmap are named `CONFIGAPIVERSION.CONFIGKIND_CONFIGNAME`, and the value of such an entry is the SHA1 of the (sorted and joined) key-value pairs of the referenced configuration.

The reloader watches the configuration resources for changes, and when Kubernetes reports a change will calculate the new SHA value, then list all dependents of each type, and then for each noticed diversion between the new SHA value and the stored SHA value will enqueue an update operation (through adding or updating a environment variable of the form `_RELOADER_-CONFIGTYPE-CONFIGNAME` with the new SHA value)

To avoid multiple updates in quick succession an update will only execute if there were no other needed updates for the same resource in a given window.
