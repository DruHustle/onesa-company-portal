"""Failure and isolation tests; never hosted qualification evidence."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_operations as ops
import oracle_recovery as recovery

SPEC = importlib.util.spec_from_file_location(
    "private_monitor", Path(__file__).parents[1] / "infra/oracle/operations/monitor.py"
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class OperationsGuards(unittest.TestCase):
    def setUp(self):
        self.metrics = {
            "worker_required": True,
            "worker_healthy": True,
            "failed_jobs": 0,
            "queue_age_seconds": 0,
            "deletion_age_seconds": 0,
            "scanner_ready": True,
            "signature_current": True,
            "backup_failed": False,
            "backup_age_seconds": 60,
            "disk_used_percent": 20,
            "memory_available_bytes": 1024 * 1024 * 1024,
            "database_available": True,
            "worker_restart_count": 0,
            "previous_restart_count": 0,
        }

    def test_all_nine_failure_classes_and_clearance(self):
        self.assertFalse(any(monitor.evaluate(self.metrics).values()))
        faults = {
            "worker-stopped": ("worker_healthy", False),
            "job-retry-exhausted": ("failed_jobs", 1),
            "queue-stalled": ("queue_age_seconds", 301),
            "clamav-unavailable": ("scanner_ready", False),
            "signature-update-failed": ("signature_current", False),
            "backup-failed": ("backup_failed", True),
            "resource-exhaustion": ("memory_available_bytes", 0),
            "database-unavailable": ("database_available", False),
            "worker-restarted": ("worker_restart_count", 1),
        }
        for name, (key, value) in faults.items():
            with self.subTest(rule=name):
                actual = monitor.evaluate({**self.metrics, key: value})
                self.assertEqual([n for n, v in actual.items() if v], [name])

    def test_stale_backup_and_disk_pressure_are_not_silent(self):
        self.assertTrue(
            monitor.evaluate({**self.metrics, "backup_age_seconds": 7201})[
                "backup-failed"
            ]
        )
        self.assertTrue(
            monitor.evaluate({**self.metrics, "disk_used_percent": 80})[
                "resource-exhaustion"
            ]
        )

    def test_install_cannot_write_vm_or_create_keys_before_source_qualification(self):
        with (
            patch.object(ops.worker, "qualified_source", side_effect=ValueError),
            patch.object(ops, "run") as remote,
            patch.object(ops, "public_key") as keys,
        ):
            with self.assertRaises(ValueError):
                ops.install("a" * 40)
            remote.assert_not_called()
            keys.assert_not_called()

    def test_wrong_recovered_application_key_cannot_start_database_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            master = private / "production-backup-encryption.key"
            master.write_bytes(b"m" * 32)
            master.chmod(0o600)
            (private / "production-operations-installation.json").write_text(
                json.dumps(
                    {
                        "source_commit": "a" * 40,
                        "backup": {
                            "object_count": 1,
                            "object_key": "synthetic-backup",
                            "key_id": "synthetic-key",
                            "ciphertext_sha256": "b" * 64,
                        },
                    }
                )
            )
            values = {
                "DATABASE_URL": "postgresql://synthetic@"
                + ops.production.DATABASE_HOST
                + "/neondb",
                "S3_ENDPOINT": "https://" + ops.production.BUCKET_HOST,
                "S3_REGION": "synthetic-region",
                "S3_BUCKET": "synthetic-bucket",
                "AWS_ACCESS_KEY_ID": "synthetic-access",
                "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
                "SESSION_KEY": "approved-synthetic-key",
            }
            with (
                patch.object(ops, "PRIVATE", private),
                patch.object(ops.worker, "qualified_source"),
                patch.object(ops.production, "provider", return_value=[]),
                patch.object(ops.production, "inventory", return_value=values),
                patch.object(
                    recovery,
                    "run",
                    return_value=json.dumps(
                        {"session_key": "wrong-synthetic-key"}
                    ).encode(),
                ) as commands,
            ):
                with self.assertRaisesRegex(
                    ValueError, "Recovered application key differs"
                ):
                    recovery.recover("a" * 40)
                self.assertEqual(commands.call_count, 1)
                self.assertEqual(commands.call_args.args[0][0], "node")
                self.assertFalse(list(private.glob("independent-restore-*")))

    def test_monitor_never_stops_restarts_or_deletes_services(self):
        source = Path(monitor.__file__).read_text()
        for command in ["'stop'", "'restart'", "'rm'", "'kill'", "'pause'"]:
            self.assertNotIn(command, source)


if __name__ == "__main__":
    unittest.main()
