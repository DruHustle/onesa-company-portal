"""Synthetic restore orchestration; no Docker daemon, database or provider access."""

import base64
import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_portal as r
import oracle_portal_identity as identity
import oracle_portal_identity_restore as restore


class RestoreMigrationOwnershipTests(unittest.TestCase):
    def exercise(self, baseline, *, replay_failure=False):
        operation = "11111111-1111-4111-8111-111111111111"
        name = "onesa-isolated-portal-restore-" + operation.replace("-", "")
        container = "a" * 64
        binding = {"candidate_commit": "b" * 40, "source_tree": "c" * 40,
                   "artifact_digest": "sha256:" + "d" * 64}
        image = "sha256:" + "e" * 64
        custody_hash = "f" * 64
        backup = {"ciphertext_sha256": "1" * 64, "dump_sha256": "2" * 64,
                  "object_key": "synthetic-backup", "key_id": "3" * 64}
        tool = {"transport_image": image, "postgres_image": image}
        value = {"recovery_file": {"path": "/synthetic/recovery"},
                 "ledger_file": {"path": "/synthetic/ledger", "sha256": custody_hash}}
        plan = {"restore": value, "legacy_backup": {
            "transport_image": image, "transport_env": "/etc/onesa/portal-production.env",
            "transport_runtime_sha256": custody_hash,
        }}
        ledger = {"source_backup_sha256": backup["dump_sha256"],
                  "reconciled_through": r.now().isoformat()}
        payload = {"manifest": [], "objects": []}
        runtime = {key: "synthetic" for key in (
            "SESSION_KEY", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
        )}
        root = Path(__file__).resolve().parents[2]
        migrations = {path.name: path.read_bytes() for path in sorted(
            (root / "onesa-company-portal-backend/migrations").glob("*.sql"))}
        manifest = {key: hashlib.sha256(raw).hexdigest() for key, raw in migrations.items()}
        files = {identity.PREFIX + "migrations/" + key: digest for key, digest in manifest.items()}
        for required in ("Dockerfile", "package.json", "package-lock.json", "src/identity/config.ts",
                         "src/identity/routes.ts", "src/identity/provider.ts", "src/identity/accounts.ts",
                         "src/jobs/worker.ts", "src/services/database-readiness.ts"):
            files[identity.PREFIX + required] = "4" * 64
        rows = [{"name": key, "checksum": digest} for key, digest in list(manifest.items())[:baseline]]
        item = {"Id": container, "Name": "/" + name,
                "Config": {"Labels": {"org.onesa.restore-scope": "isolated",
                                       "org.onesa.product": "portal",
                                       "org.onesa.restore-snapshot-sha256": backup["dump_sha256"]}},
                "HostConfig": {"NetworkMode": "none", "PortBindings": {}},
                "State": {"Running": True, "OOMKilled": False}, "Mounts": [{"Type": "tmpfs"}]}
        commands, applied, fallback_names = [], [], []

        def docker(*args, **kwargs):
            commands.append(args)
            if args == ("image", "inspect", image):
                return json.dumps([{"Id": image, "Os": "linux", "Architecture": "arm64"}]).encode()
            if args == ("inspect", container):
                return json.dumps([item]).encode()
            if args[:2] == ("run", "-d"):
                self.assertEqual(args[args.index("--name") + 1], name)
                return container.encode()
            if args[:2] == ("run", "--rm") and args[-3:] == ("id", image, "postgres"):
                return b"uid=70(postgres) gid=70(postgres)"
            if args[:2] == ("run", "--rm") and args[-1].startswith("/app/migrations/"):
                return migrations[Path(args[-1]).name]
            if args[:2] == ("exec", "-i") and "pg_restore" in args:
                self.assertEqual(kwargs["data"], b"PGDMP-synthetic")
                return b""
            if args == ("rm", "-f", container) or args[:3] == ("container", "ls", "--all"):
                return b""
            self.fail("Unexpected Docker fixture request")

        def sql(actual_container, database, statement):
            self.assertEqual((actual_container, database), (container, "onesa_identity_restore"))
            if statement == restore.MANIFEST_SQL:
                return b""
            if "SELECT json_agg(x ORDER BY name)" in statement:
                return json.dumps(rows).encode()
            if statement.startswith("BEGIN;"):
                self.assertTrue(statement.endswith("COMMIT;\n"))
                for migration, checksum in re.findall(
                    r"INSERT INTO schema_migrations\(name,checksum\) VALUES\('([^']+)','([^']+)'\)", statement
                ):
                    applied.append(migration)
                    rows.append({"name": migration, "checksum": checksum})
                return b""
            if statement == "SELECT count(*) FROM schema_migrations;":
                return str(len(rows)).encode()
            if statement == "synthetic replay":
                if replay_failure:
                    raise r.Refused("SYNTHETIC_REPLAY_FAILURE")
                return b"ERASURE_REPLAY_AND_CAPABILITY_LOCKDOWN_PASS"
            self.fail("Unexpected SQL fixture request")

        def fallback(actual_binding, actual_operation, restore_name, actual_container, database, actual_ledger):
            fallback_names.append(restore_name)
            self.assertEqual((actual_binding, actual_operation, restore_name, actual_container, database, actual_ledger),
                             (binding, operation, name, container, "onesa_identity_restore", ledger))
            return {"synthetic": True}

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "restore"
            with (
                patch.object(restore, "validate", return_value=(value, tool)),
                patch.object(restore, "backup_current", return_value=backup),
                patch.object(r, "private", side_effect=lambda path: path),
                patch.object(r, "sha", return_value=custody_hash),
                patch.object(r, "inspect_database_backup", return_value={"synthetic": True}),
                patch.object(identity, "private_bytes", return_value=json.dumps({
                    "master": base64.b64encode(b"0" * 32).decode()}).encode()),
                patch.object(r, "runtime_values", return_value=runtime),
                patch.object(Path, "read_text", return_value="// synthetic decoder"),
                patch.object(restore, "private_capture", return_value=json.dumps(payload).encode()),
                patch.object(restore, "payload_valid", return_value=b"PGDMP-synthetic"),
                patch.object(restore.restore_replay, "ledger", return_value=(ledger, custody_hash)),
                patch.object(r, "docker", side_effect=docker),
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1)),
                patch.object(restore, "wait_for_restore"),
                patch.object(restore, "sql", side_effect=sql),
                patch.object(r, "source_inventory", return_value=(None, files)),
                patch.object(restore.restore_replay, "replay_sql", return_value="synthetic replay"),
                patch.object(restore, "fallback_observe", side_effect=fallback),
            ):
                if replay_failure:
                    with self.assertRaisesRegex(r.Refused, "SYNTHETIC_REPLAY_FAILURE"):
                        restore.observe(binding, plan, operation, target)
                else:
                    proof = restore.observe(binding, plan, operation, target)
                    self.assertTrue(proof["schema_016_rehearsed"])
                    self.assertTrue(proof["isolated_container_removed"])
            self.assertEqual((target / "receipt.json").exists(), not replay_failure)
        self.assertEqual(applied, list(migrations)[baseline:])
        self.assertEqual(fallback_names, [] if replay_failure else [name])
        self.assertEqual([args for args in commands if args[0] == "rm"], [("rm", "-f", container)])
        self.assertTrue(any(args[:3] == ("container", "ls", "--all") for args in commands))

    def test_migrations_preserve_restore_identity_for_fallback_and_cleanup(self):
        for baseline in (12, 14, 15, 16):
            with self.subTest(baseline=baseline):
                self.exercise(baseline)

    def test_failure_after_migration_still_removes_the_owned_restore(self):
        self.exercise(14, replay_failure=True)


if __name__ == "__main__":
    unittest.main()
