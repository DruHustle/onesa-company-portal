"""Restore-only rejection and erasure/hold boundaries; no provider access."""

import copy
import datetime
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "restore_replay", Path(__file__).with_name("restore_replay.py")
)
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)
IDENTIFIER = "12345678-1234-4234-8234-123456789abc"


def value():
    now = datetime.datetime.now(datetime.timezone.utc)
    return {
        "schema": 1,
        "product": "portal",
        "source_backup_sha256": "a" * 64,
        "backup_created_at": (now - datetime.timedelta(hours=1)).isoformat(),
        "reconciled_through": now.isoformat(),
        "events": {k: [] for k in replay.KINDS},
        "legal_holds": {k: [] for k in replay.KINDS},
    }


class RestoreReplay(unittest.TestCase):
    def fixture(self, data, mode=0o600):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        p = Path(folder.name) / "ledger.json"
        p.write_text(json.dumps(data))
        p.chmod(mode)
        return p

    def test_valid_ledger(self):
        d = value()
        read, digest = replay.ledger(self.fixture(d))
        self.assertEqual(read, d)
        self.assertEqual(len(digest), 64)

    def test_injection_invalid_watermark_missing_scope_and_holds_rejected(self):
        for change in [
            "sql",
            "future",
            "naive",
            "missing_category",
            "unknown_product",
            "duplicate",
            "hold",
        ]:
            d = value()
            if change == "sql":
                d["events"]["deleted_enquiries"] = ["x'); DROP TABLE users;--"]
            if change == "future":
                d["reconciled_through"] = (
                    datetime.datetime.now(datetime.timezone.utc)
                    + datetime.timedelta(days=1)
                ).isoformat()
            if change == "naive":
                d["backup_created_at"] = "2026-01-01T00:00:00"
            if change == "missing_category":
                del d["events"]["deleted_files"]
            if change == "unknown_product":
                d["product"] = "ai"
            if change == "duplicate":
                d["events"]["deleted_enquiries"] = [IDENTIFIER, IDENTIFIER]
            if change == "hold":
                d["events"]["deleted_enquiries"] = [IDENTIFIER]
                d["legal_holds"]["deleted_enquiries"] = [IDENTIFIER]
            with (
                self.subTest(change=change),
                self.assertRaises((ValueError, TypeError, KeyError)),
            ):
                replay.ledger(self.fixture(d))

    def test_world_readable_or_symlink_rejected(self):
        p = self.fixture(value(), 0o644)
        with self.assertRaises(ValueError):
            replay.ledger(p)
        p.chmod(0o600)
        link = p.with_name("link")
        link.symlink_to(p)
        with self.assertRaises(ValueError):
            replay.ledger(link)

    def test_live_network_bind_mount_ports_wrong_snapshot_identity_rejected(self):
        name = "onesa-isolated-portal-restore-" + "1" * 12
        item = {
            "Id": "1" * 64,
            "Name": "/" + name,
            "Config": {
                "Labels": {
                    "org.onesa.restore-scope": "isolated",
                    "org.onesa.product": "portal",
                    "org.onesa.restore-snapshot-sha256": "a" * 64,
                }
            },
            "HostConfig": {"NetworkMode": "none", "PortBindings": {}},
            "State": {"Running": True, "OOMKilled": False},
            "Mounts": [{"Type": "tmpfs"}],
        }
        self.assertEqual(
            replay.isolated_target(name, "onesa_test_restore", [item], value()),
            "1" * 64,
        )
        for change in [
            "network",
            "mount",
            "ports",
            "snapshot",
            "identity",
            "name",
            "product",
        ]:
            row = copy.deepcopy(item)
            if change == "network":
                row["HostConfig"]["NetworkMode"] = "host"
            if change == "mount":
                row["Mounts"] = [{"Type": "bind"}]
            if change == "ports":
                row["HostConfig"]["PortBindings"] = {"5432/tcp": [{"HostPort": "5432"}]}
            if change == "snapshot":
                row["Config"]["Labels"]["org.onesa.restore-snapshot-sha256"] = "b" * 64
            if change == "identity":
                row["Id"] = "--privileged"
            if change == "name":
                row["Name"] = "/onesa-ai-oracle-api-production-1"
            if change == "product":
                row["Config"]["Labels"]["org.onesa.product"] = "robot"
            with self.subTest(change=change), self.assertRaises(ValueError):
                replay.isolated_target(name, "onesa_test_restore", [row], value())

    def test_no_apply_stops_before_docker_or_sql(self):
        with patch.object(replay.subprocess, "check_output") as called:
            with self.assertRaises(ValueError):
                replay.run("anything", "anything", self.fixture(value()), False, "")
            called.assert_not_called()


if __name__ == "__main__":
    unittest.main()
