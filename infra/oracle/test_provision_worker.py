"""Offline safety regressions. These never contact OCI or generate real keys."""

import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("provision_worker", Path(__file__).with_name("provision-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeOci:
    region = "eu-frankfurt-1"

    def __init__(self, home=None, instances=None, storage=0, images=None):
        self.home = home or self.region
        self.instances = instances or []
        self.storage = storage
        self.calls = []
        self.images = images if images is not None else [{
            "id": "image", "lifecycle-state": "AVAILABLE", "compartment-id": None,
            "operating-system-version": "24.04",
            "display-name": "Canonical-Ubuntu-24.04-Minimal-aarch64", "time-created": "2026-10-01"}]

    def get(self, command, *args, **kwargs):
        self.calls.append(command)
        values = {
            "iam region-subscription list": [{"region-name": self.home, "is-home-region": True, "status": "READY"}],
            "iam compartment list": [], "iam availability-domain list": [{"name": "AD1"}],
            "compute instance list": self.instances,
            "bv boot-volume list": [{"size-in-gbs": self.storage, "lifecycle-state": "AVAILABLE"}],
            "bv volume list": [], "compute image list": self.images}
        return values[command]

    def request(self, command, *args, **kwargs):
        self.calls.append(command)
        return {"data": {"items": []}}


class SafetyTests(unittest.TestCase):
    def test_only_one_public_ipv4_is_accepted(self):
        self.assertEqual(worker.ssh_cidr("8.8.8.8"), "8.8.8.8/32")
        for value in ("0.0.0.0/0", "8.8.8.0/24", "192.168.1.2", "127.0.0.1", "2001:4860:4860::8888", "example.com"):
            with self.subTest(value=value), self.assertRaises(worker.ProvisionError):
                worker.ssh_cidr(value)

    def test_existing_allocations_and_monthly_usage_fail_closed(self):
        worker.check_budget(0, 0, 150)
        for args in ((2, 0, 0), (0, 12, 0), (0, 0, 151), (0, 0, 0, 1490, 0), (0, 0, 0, 0, 8990)):
            with self.subTest(args=args), self.assertRaises(worker.ProvisionError):
                worker.check_budget(*args)

    def test_home_region_mismatch_stops_before_inventory(self):
        oci = FakeOci(home="us-ashburn-1")
        with self.assertRaises(worker.ProvisionError):
            worker.preflight(oci, "tenancy", "tenancy")
        self.assertEqual(oci.calls, ["iam region-subscription list"])

    def test_unauthorized_compartment_is_rejected(self):
        with self.assertRaises(worker.ProvisionError):
            worker.preflight(FakeOci(), "tenancy", "foreign")

    def test_existing_worker_prevents_duplicate_launch(self):
        oci = FakeOci(instances=[{"display-name": worker.NAME, "lifecycle-state": "RUNNING"}])
        with self.assertRaises(worker.ProvisionError):
            worker.preflight(oci, "tenancy", "tenancy")
        self.assertNotIn("compute image list", oci.calls)

    def test_stopped_a1_and_unattached_volumes_consume_budget(self):
        oci = FakeOci(instances=[{"display-name": "other", "lifecycle-state": "STOPPED",
                                 "shape": worker.SHAPE, "shape-config": {"ocpus": 2, "memory-in-gbs": 12}}])
        with self.assertRaises(worker.ProvisionError):
            worker.preflight(oci, "tenancy", "tenancy")
        with self.assertRaises(worker.ProvisionError):
            worker.preflight(FakeOci(storage=151), "tenancy", "tenancy")

    def test_preflight_is_read_only_and_selects_platform_arm64(self):
        oci = FakeOci()
        _, image, _ = worker.preflight(oci, "tenancy", "tenancy")
        self.assertIn("aarch64", image["display-name"])
        self.assertTrue(all(command.endswith(" list") or command.endswith("request-summarized-usages") for command in oci.calls))
        for replacement in ({"compartment-id": "custom"}, {"display-name": "Canonical-Ubuntu-24.04-amd64"}):
            oci.images = [{**image, **replacement}]
            with self.subTest(replacement=replacement), self.assertRaises(worker.ProvisionError):
                worker.preflight(oci, "tenancy", "tenancy")

    def test_monthly_usage_pagination_and_memory_cpu_accounting(self):
        oci = FakeOci()
        calls = []
        def request(command, *args):
            calls.append(args)
            return ({"data": {"items": [{"sku-name": "Standard - A1", "unit": "OCPU Per Hour", "computed-quantity": 100}]},
                     "opc-next-page": "next"} if len(calls) == 1 else
                    {"data": {"items": [{"sku-name": "Standard - A1 - Memory", "unit": "Gigabyte Per Hour", "computed-quantity": 600}]}})
        oci.request = request
        cpu, memory, remaining = worker.monthly_usage(oci, "tenancy", datetime(2026, 10, 12, tzinfo=timezone.utc))
        self.assertEqual((cpu, memory, remaining), (100, 600, 480))
        self.assertIn("--page", calls[1])

    def test_unknown_or_missing_a1_usage_fails_closed(self):
        for quantity, unit, sku in ((None, "GB HOUR", "A1 Memory"), (10, "GB", "A1 Memory"), (10, "HOUR", "A1 Mystery")):
            oci = FakeOci()
            oci.request = lambda *a, **k: {"data": {"items": [{"sku-name": sku, "unit": unit, "computed-quantity": quantity}]}}
            with self.subTest(sku=sku, unit=unit, quantity=quantity), self.assertRaises(worker.ProvisionError):
                worker.monthly_usage(oci, "tenancy", datetime(2026, 10, 12, tzinfo=timezone.utc))

    def test_network_collision_is_preserved(self):
        oci = FakeOci()
        oci.get = lambda *a, **k: [{"display-name": worker.NAME + "-vcn", "lifecycle-state": "AVAILABLE",
                                   "freeform-tags": {}, "compartment-id": "tenancy", "cidr-block": "10.72.0.0/16"}]
        with self.assertRaises(worker.ProvisionError):
            worker.network_resource(oci, "vcn", "tenancy", "-vcn", {"cidr-block": "10.72.0.0/16"})

    def test_network_has_restricted_ssh_and_no_http_or_scanner_ingress(self):
        class NetworkOci:
            def __init__(self):
                self.created = []
            def get(self, command, *args, payload=None, **kwargs):
                if command.endswith(" list"):
                    return []
                self.created.append((command, payload))
                return {"id": command.split()[1]}
        oci = NetworkOci()
        worker.network(oci, "tenancy", "8.8.8.8/32")
        payload = next(p for c, p in oci.created if c == "network security-list create")
        tcp = [rule for rule in payload["ingressSecurityRules"] if rule["protocol"] == "6"]
        self.assertEqual(len(tcp), 1)
        self.assertEqual(tcp[0]["source"], "8.8.8.8/32")
        self.assertEqual(tcp[0]["tcpOptions"]["destinationPortRange"], {"min": 22, "max": 22})
        subnet = next(p for c, p in oci.created if c == "network subnet create")
        self.assertEqual(subnet["securityListIds"], ["security-list"])

    def test_oci_failure_does_not_expose_provider_output(self):
        for message in ("SECRET provider response", "Out of host capacity"):
            with patch.object(worker.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=message, stdout="")):
                with self.assertRaises(worker.OciError) as failure:
                    worker.Oci("eu-frankfurt-1").get("compute instance launch")
            self.assertNotIn(message, str(failure.exception))
            self.assertEqual(failure.exception.capacity, message == "Out of host capacity")

    def test_transport_timeout_is_never_classified_as_capacity(self):
        with patch.object(worker.subprocess, "run", side_effect=worker.subprocess.TimeoutExpired("oci", 120)):
            with self.assertRaises(worker.ProvisionError) as failure:
                worker.Oci("eu-frankfurt-1").get("compute instance launch")
        self.assertNotIsInstance(failure.exception, worker.OciError)

    def test_empty_cli_list_is_an_empty_inventory(self):
        with patch.object(worker.subprocess, "run", return_value=SimpleNamespace(returncode=0, stderr="", stdout="")):
            oci = worker.Oci("eu-frankfurt-1")
            self.assertEqual(oci.get("compute instance list", "--all"), [])
            with self.assertRaises(worker.ProvisionError):
                oci.get("compute instance get", "--instance-id", "instance")

    def test_public_key_input_rejects_private_or_multiple_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            for value in ("private key content", "ssh-rsa AAAA\nssh-rsa AAAA"):
                path.write_text(value)
                with self.subTest(value=value), self.assertRaises(worker.ProvisionError):
                    worker.public_key(path)

    def test_capacity_retry_never_changes_shape_or_size(self):
        class LaunchOci:
            region = "eu-frankfurt-1"
            def __init__(self, capacity):
                self.payloads = []
                self.capacity = capacity
            def get(self, command, *args, payload=None, **kwargs):
                self.payloads.append(payload)
                raise worker.OciError(self.capacity)
        for capacity, count in ((True, 3), (False, 1)):
            oci = LaunchOci(capacity)
            with tempfile.TemporaryDirectory() as directory, patch.object(worker, "public_key", return_value="public"), \
                    patch.object(worker, "network", return_value={"id": "subnet"}):
                with self.assertRaises(worker.ProvisionError):
                    worker.provision(oci, "tenancy", [{"name": str(i)} for i in range(3)],
                                     {"id": "image"}, "8.8.8.8/32", Path(directory), Path("public-key"))
            self.assertEqual(len(oci.payloads), count)
            for payload in oci.payloads:
                self.assertEqual(payload["shape"], worker.SHAPE)
                self.assertEqual(payload["shapeConfig"], {"ocpus": 1, "memoryInGBs": 6})
                self.assertEqual(payload["sourceDetails"]["bootVolumeSizeInGBs"], 50)
                self.assertEqual(payload["subnetId"], "subnet")
                self.assertTrue(payload["assignPublicIp"])
                self.assertFalse(payload["assignIpv6Ip"])
                self.assertNotIn("createVnicDetails", payload)


if __name__ == "__main__":
    unittest.main()
