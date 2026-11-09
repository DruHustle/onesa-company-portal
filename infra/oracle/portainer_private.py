#!/usr/bin/env python3
"""Render or observe a private, persistent Portainer CE deployment; never apply it.

The generated Kubernetes List is reviewed source preparation, not an installation
receipt. The owner-controlled release path must bind its real image, node and
retained storage class. First access remains an approved SSH/loopback port-forward.
Portainer's local management identity has cluster-admin rights and is owner-only.
"""

import argparse
import copy
import json
import re

from kubernetes_preflight import Refused, command, require


LABELS = {"app.kubernetes.io/name": "portainer", "app.kubernetes.io/managed-by": "onesa"}


def name(value):
    require(isinstance(value, str) and len(value) <= 253
            and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
                    for part in value.split(".")), "KUBERNETES_NAME_INVALID")
    return value


def manifest(image, storage_class, node_name, volume_size="1Gi"):
    require(isinstance(image, str)
            and re.fullmatch(r"portainer/portainer-ce@sha256:[0-9a-f]{64}", image)
            and len(set(image.rsplit(":", 1)[-1])) > 1, "PINNED_PORTAINER_CE_IMAGE_REQUIRED")
    name(storage_class)
    name(node_name)
    require(re.fullmatch(r"(?:[1-9]|[1-9][0-9]|100)Gi", volume_size) is not None,
            "PERSISTENT_VOLUME_SIZE_INVALID")

    def metadata(object_name="portainer", namespaced=True):
        result = {"name": object_name, "labels": dict(LABELS)}
        if namespaced:
            result["namespace"] = "portainer"
        return result

    probe = {"httpGet": {"path": "/", "port": "https", "scheme": "HTTPS"},
             "timeoutSeconds": 5, "periodSeconds": 10, "failureThreshold": 6}
    return {"apiVersion": "v1", "kind": "List", "items": [
        {"apiVersion": "v1", "kind": "Namespace",
         "metadata": {**metadata(namespaced=False), "labels": {
             **LABELS, "pod-security.kubernetes.io/enforce": "baseline",
         }}},
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": metadata()},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
         "metadata": metadata("onesa-portainer-owner", namespaced=False),
         "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin"},
         "subjects": [{"kind": "ServiceAccount", "name": "portainer", "namespace": "portainer"}]},
        {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": metadata(),
         "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": storage_class,
                  "resources": {"requests": {"storage": volume_size}}}},
        {"apiVersion": "v1", "kind": "Service", "metadata": metadata(),
         "spec": {"type": "ClusterIP", "selector": dict(LABELS),
                  "ports": [{"name": "https", "port": 9443, "targetPort": "https", "protocol": "TCP"}]}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
         "metadata": metadata("portainer-private"),
         "spec": {"podSelector": {"matchLabels": dict(LABELS)}, "policyTypes": ["Ingress"], "ingress": []}},
        {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": metadata(),
         "spec": {"replicas": 1, "strategy": {"type": "Recreate"},
                  "selector": {"matchLabels": dict(LABELS)}, "template": {
                      "metadata": {"labels": dict(LABELS)}, "spec": {
                          "nodeSelector": {"kubernetes.io/hostname": node_name},
                          "serviceAccountName": "portainer",
                          "securityContext": {"seccompProfile": {"type": "RuntimeDefault"}},
                          "containers": [{
                              "name": "portainer", "image": image, "imagePullPolicy": "IfNotPresent",
                              "args": ["--http-disabled", "--tunnel-addr=127.0.0.1"],
                              "ports": [{"name": "https", "containerPort": 9443, "protocol": "TCP"}],
                              "securityContext": {"allowPrivilegeEscalation": False,
                                                  "capabilities": {"drop": ["ALL"]}},
                              "volumeMounts": [{"name": "data", "mountPath": "/data"}],
                              "resources": {"requests": {"cpu": "100m", "memory": "128Mi"},
                                            "limits": {"cpu": "500m", "memory": "512Mi"}},
                              "startupProbe": {**copy.deepcopy(probe), "failureThreshold": 30},
                              "readinessProbe": copy.deepcopy(probe),
                              "livenessProbe": copy.deepcopy(probe),
                          }],
                          "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "portainer"}}],
                      }}},
        },
    ]}


def by_kind(items, kind):
    selected = [item for item in items if item.get("kind") == kind]
    require(len(selected) == 1, "PORTAINER_OBSERVATION_INCOMPLETE")
    return selected[0]


def includes(expected, actual):
    """Allow Kubernetes defaulted object fields, but never omit intended settings."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and includes(value, actual[key])
                                                for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(
            includes(left, right) for left, right in zip(expected, actual)
        )
    return type(expected) is type(actual) and expected == actual


def verify(expected, actual, volume, storage_class):
    """Inspect metadata/status only; never retrieve Kubernetes Secrets or logs."""
    require(actual.get("kind") == "List" and isinstance(actual.get("items"), list),
            "PORTAINER_OBSERVATION_INVALID")
    items = actual["items"]
    for desired in expected["items"]:
        kind = desired["kind"]
        observed = by_kind(items, kind)
        if kind == "NetworkPolicy":
            # Kubernetes omits an empty ingress list when serializing deny-all.
            observed = copy.deepcopy(observed)
            observed.setdefault("spec", {}).setdefault("ingress", [])
        require(includes(desired, observed), "PORTAINER_CONFIGURATION_DRIFT")
    service = by_kind(items, "Service")["spec"]
    require(not service.get("externalIPs") and not service.get("loadBalancerIP")
            and not service.get("externalName") and not service.get("loadBalancerClass")
            and all(not item.get("nodePort") for item in service["ports"]),
            "PORTAINER_PUBLIC_SERVICE_REFUSED")
    deployment = by_kind(items, "Deployment")
    pod = deployment["spec"]["template"]["spec"]
    require(not any(pod.get(key) for key in ("hostNetwork", "hostPID", "hostIPC", "nodeName", "initContainers", "ephemeralContainers")),
            "PORTAINER_HOST_ACCESS_REFUSED")
    container = pod["containers"][0]
    require(not container.get("securityContext", {}).get("privileged")
            and not container.get("securityContext", {}).get("capabilities", {}).get("add")
            and not any(item.get("hostPort") for item in container.get("ports", [])),
            "PORTAINER_HOST_ACCESS_REFUSED")
    require(not container.get("env") and not container.get("envFrom")
            and not container.get("command") and not container.get("lifecycle"),
            "PORTAINER_UNREVIEWED_EXECUTION_CONFIGURATION")
    status = deployment.get("status", {})
    generation = deployment.get("metadata", {}).get("generation")
    require(type(generation) is int and generation > 0
            and status.get("observedGeneration", 0) >= generation
            and all(status.get(key) == 1 for key in ("replicas", "readyReplicas", "availableReplicas", "updatedReplicas"))
            and status.get("unavailableReplicas", 0) == 0, "PORTAINER_NOT_READY")
    pvc = by_kind(items, "PersistentVolumeClaim")
    require(pvc.get("status", {}).get("phase") == "Bound", "PORTAINER_STORAGE_NOT_BOUND")
    require(volume.get("kind") == "PersistentVolume"
            and volume.get("metadata", {}).get("name") == pvc["spec"].get("volumeName")
            and volume.get("spec", {}).get("claimRef", {}).get("uid") == pvc["metadata"].get("uid")
            and pvc["metadata"].get("uid")
            and volume.get("spec", {}).get("persistentVolumeReclaimPolicy") == "Retain",
            "PORTAINER_RETAINED_VOLUME_REQUIRED")
    desired_class = pvc["spec"]["storageClassName"]
    require(storage_class.get("kind") == "StorageClass"
            and storage_class.get("metadata", {}).get("name") == desired_class
            and storage_class.get("reclaimPolicy") == "Retain"
            and volume.get("spec", {}).get("storageClassName") == desired_class,
            "PORTAINER_RETAINED_STORAGE_CLASS_REQUIRED")
    return {"schema_version": 1, "status": "PORTAINER_CONFIGURATION_AND_READINESS_PASS",
            "mutation_performed": False, "service_type": "ClusterIP", "tls_only": True,
            "ui_login_verified": False, "public_reachability_tested": False,
            "backup_restore_verified": False}


def observe(expected):
    """Use local K3s only; do not inherit a workstation's Kubernetes context."""
    base = ["k3s", "kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=8s"]
    resources = {"Namespace": "namespace", "ServiceAccount": "serviceaccount",
                 "ClusterRoleBinding": "clusterrolebinding", "PersistentVolumeClaim": "persistentvolumeclaim",
                 "Service": "service", "NetworkPolicy": "networkpolicy", "Deployment": "deployment"}
    actual = {"apiVersion": "v1", "kind": "List", "items": []}
    for item in expected["items"]:
        args = [*base, "get", resources[item["kind"]] + "/" + item["metadata"]["name"], "-o", "json"]
        if "namespace" in item["metadata"]:
            args += ["--namespace=portainer"]
        actual["items"].append(json.loads(command(args)))
    pvc = by_kind(actual["items"], "PersistentVolumeClaim")
    volume_name = name(pvc.get("spec", {}).get("volumeName", ""))
    class_name = name(pvc["spec"]["storageClassName"])
    volume = json.loads(command([*base, "get", "persistentvolume/" + volume_name, "-o", "json"]))
    storage_class = json.loads(command([*base, "get", "storageclass/" + class_name, "-o", "json"]))
    return verify(expected, actual, volume, storage_class)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("render", "verify"))
    parser.add_argument("--image", required=True, help="Reviewed portainer/portainer-ce@sha256 digest")
    parser.add_argument("--storage-class", required=True, help="Existing reviewed class with Retain policy")
    parser.add_argument("--node-name", required=True, help="Observed Kubernetes node hostname label")
    parser.add_argument("--volume-size", default="1Gi")
    args = parser.parse_args()
    try:
        expected = manifest(args.image, args.storage_class, args.node_name, args.volume_size)
        result = expected if args.action == "render" else observe(expected)
    except Refused as error:
        print(json.dumps({"status": "BLOCKED", "reason": str(error), "mutation_performed": False}))
        return 2
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "BLOCKED", "reason": "PORTAINER_OBSERVATION_INCOMPLETE",
                          "mutation_performed": False}))
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
