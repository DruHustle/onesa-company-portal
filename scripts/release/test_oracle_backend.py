"""Offline Compose checks for the Oracle API trust and isolation boundaries."""

import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = {
    "onesa-company-portal": ("portal", 18301, 18300, 8300),
    "onesa-ai-platform": ("ai", 18001, 18000, 8000),
    "onesa-ai-robot": ("robot", 18432, 18431, 8431),
}


class OracleBackendConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env.update({
            "ORACLE_STAGING_IMAGE": "sha256:" + "a" * 64,
            "ORACLE_PRODUCTION_IMAGE": "sha256:" + "b" * 64,
            "ORACLE_STAGING_COMMIT": "c" * 40,
            "ORACLE_PRODUCTION_COMMIT": "d" * 40,
        })
        result = subprocess.run([
            "docker", "compose", "-f", str(ROOT / "compose.oracle-backend.yaml"),
            "--profile", "*", "config", "--no-env-resolution", "--format", "json",
        ], env=env, capture_output=True, text=True, timeout=20, check=True)
        cls.config = json.loads(result.stdout)
        cls.product, cls.stage_port, cls.prod_port, cls.target_port = POLICY[ROOT.name]

    def test_explicit_profiles_pinned_images_and_source_labels(self):
        self.assertEqual(set(self.config["services"]), {"staging", "production"})
        for name, image, commit in (("staging", "a", "c"), ("production", "b", "d")):
            service = self.config["services"][name]
            self.assertEqual(service["profiles"], [name])
            self.assertEqual(service["image"], "sha256:" + image * 64)
            self.assertEqual(service["labels"]["org.onesa.source-commit"], commit * 40)
            self.assertEqual(service["labels"]["org.onesa.environment"], name)
            self.assertEqual(service["platform"], "linux/arm64")
            self.assertEqual(service["pull_policy"], "never")
            self.assertNotIn("build", service)

    def test_loopback_ports_separate_networks_and_private_runtime_files(self):
        for name, port in (("staging", self.stage_port), ("production", self.prod_port)):
            service = self.config["services"][name]
            self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
            self.assertEqual(int(service["ports"][0]["published"]), port)
            self.assertEqual(service["ports"][0]["target"], self.target_port)
            self.assertEqual(set(service["networks"]), {name})
            self.assertEqual(service["env_file"][0]["path"],
                             f"/etc/onesa/backends/{self.product}-{name}.env")
            self.assertEqual(service["env_file"][0]["format"], "raw")
            for volume in service.get("volumes", []):
                self.assertEqual(volume["type"], "volume")
                self.assertEqual(volume["target"], "/app/storage")
                self.assertTrue(volume["source"].startswith(name))

    def test_resources_and_hardening_keep_staging_lower_priority(self):
        stage, prod = (self.config["services"][name] for name in ("staging", "production"))
        self.assertLess(stage["cpu_shares"], prod["cpu_shares"])
        self.assertLess(float(stage["cpus"]), float(prod["cpus"]))
        for service in (stage, prod):
            self.assertTrue(service["read_only"])
            self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertIn("no-new-privileges:true", service["security_opt"])
            self.assertLessEqual(int(service["mem_limit"]), 512 * 1024 * 1024)
            self.assertEqual(service["logging"]["options"]["max-file"], "3")
            self.assertNotIn("privileged", service)
            self.assertNotIn("network_mode", service)


if __name__ == "__main__":
    unittest.main()
