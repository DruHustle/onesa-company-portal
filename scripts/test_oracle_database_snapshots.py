"""Isolated snapshot target, Robot consistency and stale-backup alarm regressions."""

import datetime
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "infra/oracle/operations"))
import database_snapshots as snapshots
import monitor


class SnapshotSafety(unittest.TestCase):
    def test_robot_rejects_other_environment_before_network(self):
        from urllib.parse import urlsplit

        with patch("urllib.request.build_opener") as opener:
            with self.assertRaises(ValueError):
                snapshots.robot_snapshot({}, urlsplit("libsql://staging.example"))
            opener.assert_not_called()

    def test_private_configuration_rejects_symlink_and_open_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "config"
            p.write_text("{}")
            p.chmod(0o644)
            with self.assertRaises(ValueError):
                snapshots.private_json(p)
            link = Path(directory) / "link"
            link.symlink_to(p)
            with self.assertRaises(ValueError):
                snapshots.private_json(link)

    def test_one_statement_snapshot_and_exact_schema_coverage(self):
        import urllib.parse

        row = {
            "schema_count": "2",
            "tasks_schema": "CREATE TABLE robot_simulation_tasks_v1 (id TEXT)",
            "tasks_rows": '[{"id":"synthetic"}]',
            "lease_schema": "CREATE TABLE robot_simulation_lease_v1 (id INTEGER)",
            "lease_rows": "[]",
        }

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def read(self, _limit):
                result = {
                    "cols": [{"name": k} for k in row],
                    "rows": [[{"type": "text", "value": v} for v in row.values()]],
                }
                return json.dumps(
                    {
                        "results": [
                            {"type": "ok", "response": {"result": result}},
                            {"type": "ok"},
                        ]
                    }
                ).encode()

        class Opener:
            def open(self, request, **_):
                statements = json.loads(request.data)["requests"]
                assert len(statements) == 2 and statements[0]["stmt"]["sql"].startswith(
                    "SELECT"
                )
                assert statements[1] == {"type": "close"}
                return Response()

        uri = urllib.parse.urlsplit(
            "libsql://onesa-ai-robot-backend-druhustle.aws-eu-west-1.turso.io"
        )
        with patch("urllib.request.build_opener", return_value=Opener()):
            payload, manifest = snapshots.robot_snapshot(
                {"ROBOT_TURSO_AUTH_TOKEN": "synthetic-only"}, uri
            )
            self.assertEqual(len(json.loads(payload)["tables"]), 2)
            self.assertEqual(
                manifest[0]["sha256"],
                hashlib.sha256(row["tasks_rows"].encode()).hexdigest(),
            )
            row["schema_count"] = "3"
            with self.assertRaises(ValueError):
                snapshots.robot_snapshot(
                    {"ROBOT_TURSO_AUTH_TOKEN": "synthetic-only"}, uri
                )

    def test_missing_stale_future_failed_or_wrong_product_receipt_alerts(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            p = state / "database-backup-ai-success.json"
            self.assertTrue(
                monitor.database_backup_health(["ai"], state, now.timestamp())[
                    "database_backup_failed"
                ]
            )
            receipt = {
                "verified_at": now.isoformat(),
                "product": "ai",
                "passed": True,
                "off_instance_storage_verified": True,
                "consistent_snapshot": True,
            }
            p.write_text(json.dumps(receipt))
            self.assertFalse(
                monitor.database_backup_health(["ai"], state, now.timestamp())[
                    "database_backup_failed"
                ]
            )
            self.assertTrue(
                monitor.database_backup_health(["ai"], state, now.timestamp() + 7201)[
                    "database_backup_failed"
                ]
            )
            self.assertTrue(
                monitor.database_backup_health(["ai"], state, now.timestamp() - 1)[
                    "database_backup_failed"
                ]
            )
            receipt["product"] = "robot"
            p.write_text(json.dumps(receipt))
            self.assertTrue(
                monitor.database_backup_health(["ai"], state, now.timestamp())[
                    "database_backup_failed"
                ]
            )
            receipt["product"] = "ai"
            p.write_text(json.dumps(receipt))
            (state / "database-backup-ai-failure.json").write_text("{}")
            self.assertTrue(
                monitor.database_backup_health(["ai"], state, now.timestamp())[
                    "database_backup_failed"
                ]
            )




class BootstrapSafety(unittest.TestCase):
    def test_existing_install_stops_before_source_config_or_key_writes(self):
        import oracle_operations

        with (
            patch.object(oracle_operations.worker, "qualified_source", return_value=[]),
            patch.object(
                oracle_operations, "run", side_effect=ValueError("Already installed")
            ) as command,
            patch.object(oracle_operations, "public_key") as key,
        ):
            with self.assertRaises(ValueError):
                oracle_operations.install("a" * 40)
            command.assert_called_once_with(
                "sudo test ! -e /etc/onesa/operations.json", timeout=20
            )
            key.assert_not_called()

    def test_archive_includes_encryption_module(self):
        import oracle_operations

        self.assertIn("scripts/oracle_backup_payload.mjs", oracle_operations.PATHS)


if __name__ == "__main__":
    unittest.main()
