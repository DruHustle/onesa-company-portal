"""Deployment guard tests use synthetic GitHub metadata, never a hosted PASS."""

import unittest
from unittest.mock import patch

import oracle_worker as worker

SHA = "a" * 40


class GitHub:
    def __init__(self, sha=SHA):
        self.sha = sha

    def api(self, path):
        if path != "repos/DruHustle/onesa-company-portal/branches/staging":
            raise AssertionError("Unexpected provider access")
        return {"commit": {"sha": self.sha}}


class DeploymentGuards(unittest.TestCase):
    def test_unqualified_or_foreign_source_never_reaches_ssh(self):
        with patch.object(worker, "remote") as remote:
            for sha in ["main", "../main", "b" * 40]:
                with self.assertRaises(ValueError):
                    worker.deploy("scanner", sha, github=GitHub())
            for status in ["FAIL", "BLOCKED"]:
                with patch.object(worker.evidence, "checked_ci", return_value=(status, [])):
                    with self.assertRaises(ValueError):
                        worker.deploy("scanner", SHA, github=GitHub())
            remote.assert_not_called()

    def test_worker_needs_explicit_synthetic_scope_before_any_provider_access(self):
        with patch.object(worker, "remote") as remote:
            with self.assertRaisesRegex(ValueError, "synthetic"):
                worker.deploy("worker", SHA, github=GitHub())
            remote.assert_not_called()

    def test_production_operation_is_unavailable(self):
        with patch.object(worker, "remote") as remote:
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                worker.deploy("production", SHA)
            remote.assert_not_called()

    def test_actual_staging_success_uses_existing_full_evidence_gate(self):
        refs = [{"run_id": 123, "commit": SHA}]
        with patch.object(worker.evidence, "checked_ci", return_value=("PASS", refs)) as gate:
            github = GitHub()
            self.assertEqual(worker.qualified_source(SHA, github), refs)
            gate.assert_called_once_with(github, SHA)


if __name__ == "__main__":
    unittest.main()
