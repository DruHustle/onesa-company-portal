"""Credential-free K3s host refusal and private Portainer configuration tests."""

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra/oracle"
sys.path.insert(0, str(INFRA))
import kubernetes_preflight as preflight
import portainer_private as portainer


def host():
    return {
        "machine_identity_sha256": hashlib.sha256(b"synthetic-host").hexdigest(),
        "architecture": "aarch64", "cpu_capacity": 4, "load_average_1m": 0.5,
        "memory_total_mib": 24576, "memory_available_mib": 16000, "disk_free_gib": 50,
        "swap_active": False, "cgroup_controllers": ["cpu", "memory", "pids"],
        "ipv4_forwarding": True, "existing_cluster_paths": False,
        "networks": ["10.0.0.0/24", "172.18.0.0/16"], "listener_ports": [22, 80, 443, 18300],
        "onesa_input_chain_present": False, "docker_count": 8,
        "docker_runtime_identity_sha256": hashlib.sha256(b"synthetic-containers").hexdigest(),
        "docker_runtime_identity_stable": True,
    }


def desired_portainer():
    return portainer.manifest(
        "portainer/portainer-ce@sha256:" + hashlib.sha256(b"synthetic-image").hexdigest(),
        "synthetic-retained", "synthetic-node",
    )


def portainer_observation():
    expected = desired_portainer()
    actual = copy.deepcopy(expected)
    deployment = portainer.by_kind(actual["items"], "Deployment")
    deployment["metadata"]["generation"] = 2
    deployment["status"] = {"observedGeneration": 2, "replicas": 1, "readyReplicas": 1,
                            "availableReplicas": 1, "updatedReplicas": 1}
    pvc = portainer.by_kind(actual["items"], "PersistentVolumeClaim")
    pvc["metadata"]["uid"] = "synthetic-pvc-uid"
    pvc["spec"]["volumeName"] = "synthetic-volume"
    pvc["status"] = {"phase": "Bound"}
    volume = {"kind": "PersistentVolume", "metadata": {"name": "synthetic-volume"},
              "spec": {"claimRef": {"uid": "synthetic-pvc-uid"}, "storageClassName": "synthetic-retained",
                       "persistentVolumeReclaimPolicy": "Retain"}}
    storage = {"kind": "StorageClass", "metadata": {"name": "synthetic-retained"}, "reclaimPolicy": "Retain"}
    return expected, actual, volume, storage


class HostPrerequisiteTests(unittest.TestCase):
    def test_prerequisites_never_authorize_install_or_claim_workload_capacity(self):
        report = preflight.assess(host())
        self.assertEqual(report["status"], "HOST_PREREQUISITES_PASS")
        self.assertFalse(report["installation_performed"])
        self.assertFalse(report["workload_capacity_qualified"])
        self.assertIn("independent-backup-and-restore", report["unverified"])
        self.assertEqual(report["preservation_contract"]["existing_ingress_ports"], [80, 443])
        self.assertTrue(report["preservation_contract"]["initial_traefik_and_servicelb_disabled"])
        self.assertNotIn("networks", report["observations"])

    def test_available_memory_not_total_memory_controls_admission(self):
        sample = host()
        sample["memory_available_mib"] = 2048
        result = preflight.assess(sample)
        self.assertIn("AVAILABLE_MEMORY_BELOW_BUDGET", result["blockers"])
        self.assertGreater(result["candidate"]["required_available_memory_mib"], 2048)

    def test_additional_workloads_reserve_memory_and_disk(self):
        report = preflight.assess(host(), workload_memory_mib=16000, workload_disk_gib=50)
        self.assertIn("AVAILABLE_MEMORY_BELOW_BUDGET", report["blockers"])
        self.assertIn("DISK_RESERVE_BELOW_BUDGET", report["blockers"])
        with self.assertRaises(preflight.Refused):
            preflight.assess(host(), workload_memory_mib=-1)

    def test_observed_host_defects_fail_independently(self):
        cases = [
            ("cpu_capacity", 1, "CPU_BELOW_CLUSTER_MINIMUM"),
            ("cpu_capacity", 1.5, "CPU_BELOW_CLUSTER_MINIMUM"),
            ("load_average_1m", 5, "CPU_HEADROOM_LOW"),
            ("disk_free_gib", 9, "DISK_RESERVE_BELOW_BUDGET"),
            ("swap_active", True, "ACTIVE_SWAP_REQUIRES_REVIEW"),
            ("cgroup_controllers", ["cpu"], "REQUIRED_CGROUPS_MISSING"),
            ("ipv4_forwarding", False, "IPV4_FORWARDING_DISABLED"),
            ("existing_cluster_paths", True, "EXISTING_CLUSTER_REQUIRES_OWN_UPGRADE_PATH"),
            ("listener_ports", [22, 6443], "CLUSTER_PORTS_ALREADY_BOUND"),
            ("onesa_input_chain_present", True, "EXISTING_ONESA_FIREWALL_INTEGRATION_REQUIRED"),
            ("docker_runtime_identity_stable", False, "DOCKER_RUNTIME_IDENTITY_CHANGED"),
        ]
        for key, value, refusal in cases:
            with self.subTest(key=key, value=value):
                sample = host()
                sample[key] = value
                result = preflight.assess(sample)
                self.assertEqual(result["status"], "BLOCKED")
                self.assertIn(refusal, result["blockers"])

    def test_route_and_docker_network_collisions_are_not_ignored(self):
        for subnet in ("10.42.0.0/16", "10.43.1.0/24", "10.0.0.0/8"):
            with self.subTest(subnet=subnet):
                sample = host()
                sample["networks"].append(subnet)
                self.assertIn("CLUSTER_NETWORK_OVERLAP", preflight.assess(sample)["blockers"])

    def test_candidate_networks_must_be_private_canonical_and_disjoint(self):
        for pods, services in (("10.42.1.0/16", "10.43.0.0/16"),
                               ("8.8.0.0/16", "10.43.0.0/16"),
                               ("10.42.0.0/16", "10.42.1.0/24"),
                               ("10.42.0.0/16", "::/64")):
            with self.subTest(pods=pods), self.assertRaises(preflight.Refused):
                preflight.candidate_networks(pods, services)

    def test_route_parser_ignores_default_but_preserves_host_and_overlay_routes(self):
        result = preflight.route_networks([{"dst": "default"}, {"dst": "10.42.1.7"}, {"dst": "100.64.0.0/10"}])
        self.assertEqual(result, ["10.42.1.7/32", "100.64.0.0/10"])
        with self.assertRaises(preflight.Refused):
            preflight.route_networks([{"dst": "unrecognized"}])

    def test_listener_parser_handles_ipv4_and_ipv6_without_emitting_addresses(self):
        observed = preflight.listener_ports(
            "tcp LISTEN 0 128 127.0.0.1:18300 0.0.0.0:*\n"
            "udp UNCONN 0 0 [::]:8472 [::]:*\n")
        self.assertEqual(observed, [8472, 18300])
        with self.assertRaises(preflight.Refused):
            preflight.listener_ports("unexpected response")

    def test_incomplete_memory_is_not_zero_or_available_memory(self):
        self.assertEqual(preflight.memory_values("MemTotal: 4096 kB\nMemAvailable: 2048 kB\n"),
                         {"MemTotal": 4, "MemAvailable": 2})
        with self.assertRaises(preflight.Refused):
            preflight.memory_values("MemTotal: 4096 kB\nMemFree: 2048 kB\n")

    def test_docker_inspection_never_requests_environment_or_remote_context(self):
        identifier = "a" * 64
        projected = json.dumps(identifier) + "|" + json.dumps("sha256:" + "b" * 64) + '|"synthetic-start"|true|0\n'
        with patch.object(preflight, "command", side_effect=[identifier + "\n", projected]) as call:
            result = preflight.docker_snapshot()
        self.assertEqual(result["count"], 1)
        for observed in call.call_args_list:
            self.assertEqual(observed.args[0][:3], ["docker", "--host", "unix:///var/run/docker.sock"])
        self.assertNotIn(".Config", str(call.call_args_list))
        self.assertNotIn("synthetic-start", json.dumps(result))

    def test_partial_and_duplicate_docker_responses_fail_closed(self):
        identifier = "a" * 64
        for responses in ([identifier + "\n", ""], [identifier + "\n" + identifier + "\n"]):
            with self.subTest(responses=responses), patch.object(preflight, "command", side_effect=responses):
                with self.assertRaises(preflight.Refused):
                    preflight.docker_snapshot()

    def test_command_ignores_ambient_credentials_and_redacts_failures(self):
        with patch.object(preflight.shutil, "which", return_value="/usr/bin/ip"), \
             patch.object(preflight.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=b"", stderr=b"synthetic-private-value")) as call:
            with self.assertRaisesRegex(preflight.Refused, "^HOST_OBSERVATION_UNAVAILABLE$"):
                preflight.command(["ip", "-json", "route"])
        self.assertNotIn("shell", call.call_args.kwargs)
        self.assertEqual(set(call.call_args.kwargs["env"]), {"PATH", "LANG", "LC_ALL"})
        self.assertEqual(call.call_args.kwargs["timeout"], 10)

    def test_collection_refuses_container_before_observing_docker(self):
        with patch.object(preflight.platform, "system", return_value="Linux"), \
             patch.object(preflight.os, "geteuid", return_value=0), \
             patch.object(Path, "read_text", return_value="python\n"), \
             patch.object(preflight, "docker_snapshot") as call:
            with self.assertRaisesRegex(preflight.Refused, "SYSTEMD_HOST_REQUIRED"):
                preflight.collect()
        call.assert_not_called()


class PrivatePortainerTests(unittest.TestCase):
    def test_prepared_manifest_has_only_private_tls_service_and_persistent_data(self):
        expected = desired_portainer()
        service = portainer.by_kind(expected["items"], "Service")["spec"]
        self.assertEqual(service["type"], "ClusterIP")
        self.assertEqual([item["port"] for item in service["ports"]], [9443])
        deployment = portainer.by_kind(expected["items"], "Deployment")["spec"]
        self.assertEqual(deployment["strategy"], {"type": "Recreate"})
        self.assertEqual(deployment["template"]["spec"]["volumes"],
                         [{"name": "data", "persistentVolumeClaim": {"claimName": "portainer"}}])
        self.assertNotIn("Ingress", [item["kind"] for item in expected["items"]])
        self.assertNotIn("Secret", [item["kind"] for item in expected["items"]])

    def test_mutable_or_foreign_image_and_invalid_storage_are_refused(self):
        for image in ("portainer/portainer-ce:lts", "portainer/portainer-ee@sha256:" + "a" * 64,
                      "foreign/portainer@sha256:" + hashlib.sha256(b"x").hexdigest()):
            with self.subTest(image=image), self.assertRaises(preflight.Refused):
                portainer.manifest(image, "retained", "node")
        image = desired_portainer()["items"][-1]["spec"]["template"]["spec"]["containers"][0]["image"]
        for storage in ("", "../data", "--insecure", "white space"):
            with self.subTest(storage=storage), self.assertRaises(preflight.Refused):
                portainer.manifest(image, storage, "node")

    def test_readiness_is_separate_from_login_reachability_and_restore(self):
        report = portainer.verify(*portainer_observation())
        self.assertEqual(report["status"], "PORTAINER_CONFIGURATION_AND_READINESS_PASS")
        self.assertFalse(report["ui_login_verified"])
        self.assertFalse(report["public_reachability_tested"])
        self.assertFalse(report["backup_restore_verified"])

    def test_api_omitted_empty_ingress_list_still_means_deny_all(self):
        values = portainer_observation()
        portainer.by_kind(values[1]["items"], "NetworkPolicy")["spec"].pop("ingress")
        portainer.verify(*values)

    def test_public_exposure_and_added_network_permission_are_refused(self):
        mutations = [
            ("Service", lambda x: x["spec"].update(type="NodePort")),
            ("Service", lambda x: x["spec"].update(externalIPs=["203.0.113.5"])),
            ("Service", lambda x: x["spec"]["ports"][0].update(nodePort=30779)),
            ("NetworkPolicy", lambda x: x["spec"].update(ingress=[{}])),
        ]
        for kind, mutate in mutations:
            values = portainer_observation()
            mutate(portainer.by_kind(values[1]["items"], kind))
            with self.subTest(kind=kind), self.assertRaises(preflight.Refused):
                portainer.verify(*values)

    def test_host_access_and_unreviewed_environment_are_refused(self):
        for key, value in (("hostNetwork", True), ("hostPID", True), ("hostIPC", True),
                           ("nodeName", "unqualified-other-node"),
                           ("initContainers", [{"name": "unreviewed"}])):
            values = portainer_observation()
            pod = portainer.by_kind(values[1]["items"], "Deployment")["spec"]["template"]["spec"]
            pod[key] = value
            with self.subTest(key=key), self.assertRaises(preflight.Refused):
                portainer.verify(*values)
        for change in ({"env": [{"name": "SYNTHETIC", "value": "injected"}]},
                       {"securityContext": {"allowPrivilegeEscalation": False, "privileged": True,
                                            "capabilities": {"drop": ["ALL"]}}}):
            values = portainer_observation()
            container = portainer.by_kind(values[1]["items"], "Deployment")["spec"]["template"]["spec"]["containers"][0]
            container.update(change)
            with self.subTest(change=change), self.assertRaises(preflight.Refused):
                portainer.verify(*values)

    def test_stale_or_incomplete_rollout_is_not_healthy(self):
        for change in ({"observedGeneration": 1}, {"readyReplicas": 0}, {"updatedReplicas": 0},
                       {"unavailableReplicas": 1}):
            values = portainer_observation()
            portainer.by_kind(values[1]["items"], "Deployment")["status"].update(change)
            with self.subTest(change=change), self.assertRaisesRegex(preflight.Refused, "PORTAINER_NOT_READY"):
                portainer.verify(*values)

    def test_deleting_unbound_or_wrong_claim_storage_is_refused(self):
        for index, field, value in ((2, "persistentVolumeReclaimPolicy", "Delete"),
                                    (2, "claimRef", {"uid": "different-claim"}),
                                    (2, "storageClassName", "different-class")):
            values = portainer_observation()
            values[index]["spec"][field] = value
            with self.subTest(field=field), self.assertRaises(preflight.Refused):
                portainer.verify(*values)
        values = portainer_observation()
        values[3]["reclaimPolicy"] = "Delete"
        with self.assertRaises(preflight.Refused):
            portainer.verify(*values)
        values = portainer_observation()
        portainer.by_kind(values[1]["items"], "PersistentVolumeClaim")["status"]["phase"] = "Pending"
        with self.assertRaises(preflight.Refused):
            portainer.verify(*values)

    def test_live_observer_uses_only_fixed_local_gets_and_never_secrets(self):
        expected, actual, volume, storage = portainer_observation()
        responses = [json.dumps(item) for item in actual["items"]] + [json.dumps(volume), json.dumps(storage)]
        with patch.object(portainer, "command", side_effect=responses) as call:
            result = portainer.observe(expected)
        self.assertFalse(result["mutation_performed"])
        for observation in call.call_args_list:
            argv = observation.args[0]
            self.assertEqual(argv[:5], ["k3s", "kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml",
                                       "--request-timeout=8s", "get"])
            self.assertNotIn("secret", argv[5])
        self.assertEqual(len(call.call_args_list), 9)

    def test_render_cli_is_offline_and_requires_no_cluster_credentials(self):
        image = desired_portainer()["items"][-1]["spec"]["template"]["spec"]["containers"][0]["image"]
        result = subprocess.run([sys.executable, str(INFRA / "portainer_private.py"), "render",
                                 "--image", image, "--storage-class", "synthetic-retained", "--node-name", "synthetic-node"],
                                capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), desired_portainer())


if __name__ == "__main__":
    unittest.main()
