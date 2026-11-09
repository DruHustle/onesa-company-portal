"""Synthetic target/configuration refusals; no Docker daemon or database access."""

import base64
import copy
import hashlib
import io
import json
import os
import ssl
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "infra/oracle/operations"))
import backup
import database_target as target


class TargetFixture(unittest.TestCase):
    def setUp(self):
        roots = ssl.create_default_context().get_ca_certs(binary_form=True)
        self.assertTrue(roots, "A public certificate fixture is required")
        ca = ssl.DER_cert_to_PEM_cert(roots[0]).encode()
        self.files = {}
        tls = {}
        for name, raw in {"ca": ca, "certificate": ca, "key": b"synthetic-fixture-key",
                          "hba": b"hostnossl all all all reject\nhostssl all all 172.30.0.0/24 scram-sha-256\n"}.items():
            path = "/etc/onesa/portal-database/" + name
            self.files[Path(path)] = raw
            tls[name] = {"path": path, "sha256": hashlib.sha256(raw).hexdigest()}
        self.volume = {"Name": "onesa-portal-postgres-production", "Driver": "local", "Scope": "local",
                       "Mountpoint": "/var/lib/docker/volumes/onesa-portal-postgres-production/_data",
                       "CreatedAt": "2026-11-06T00:00:00Z", "Labels": {}, "Options": None}
        self.profile = {
            "schema_version": 1, "environment": "production",
            "database": {"host": "portal-postgres-production", "port": 5432,
                         "name": "portal_fixture", "application_role": "onesa_portal_app"},
            "image": {"reference": "postgres@sha256:" + "a" * 64, "id": "sha256:" + "b" * 64},
            "volume": {"name": self.volume["Name"], "configuration_sha256": target.digest(target.volume_identity(self.volume))},
            "networks": {"api": {"name": "onesa-portal-oracle-api_production", "id": "c" * 64},
                         "worker": {"name": "onesa-portal-oracle-production_worker_egress", "id": "d" * 64}},
            "tls": tls, "runtime_sha256": {}, "container_id": "e" * 64,
        }
        uri = "postgresql://onesa_portal_app:synthetic-fixture-only@portal-postgres-production:5432/portal_fixture?sslmode=verify-full"
        for kind, path in target.runtime_paths("production").items():
            raw = ("DATABASE_URL=" + uri + "\nONESA_DATABASE_CA_PEM_B64=" + base64.b64encode(ca).decode()
                   + "\nSYNTHETIC_SLOT=" + kind + "\n").encode()
            self.files[path] = raw
            self.profile["runtime_sha256"][kind] = hashlib.sha256(raw).hexdigest()
        self.image = {"Id": self.profile["image"]["id"], "Architecture": "arm64", "Os": "linux",
                      "RepoDigests": [self.profile["image"]["reference"]]}
        self.networks = {value["id"]: {"Id": value["id"], "Name": value["name"], "Driver": "bridge", "Scope": "local"}
                         for value in self.profile["networks"].values()}
        service = target.compose(self.profile)["services"]["primary"]
        self.container = {
            "Id": self.profile["container_id"], "Name": "/onesa-portal-postgres-production", "Image": self.image["Id"],
            "Config": {"Image": self.profile["image"]["reference"], "User": "70:70", "Entrypoint": ["postgres"],
                       "Cmd": service["command"], "Env": ["PGDATA=/var/lib/postgresql/data"]},
            "State": {"Running": True, "Paused": False, "Restarting": False},
            "HostConfig": {"PortBindings": {}, "PublishAllPorts": False, "NetworkMode": "private",
                           "Privileged": False, "ReadonlyRootfs": True, "CapDrop": ["ALL"], "CapAdd": None,
                           "SecurityOpt": ["no-new-privileges:true"]},
            "NetworkSettings": {"Networks": {value["name"]: {"NetworkID": value["id"], "Aliases": ["portal-postgres-production"]}
                                               for value in self.profile["networks"].values()}},
            "Mounts": [{"Destination": "/var/lib/postgresql/data", "Type": "volume", "Name": self.volume["Name"],
                        "Source": self.volume["Mountpoint"], "RW": True}],
        }
        for name, destination in (("certificate", "/run/onesa/server.crt"), ("key", "/run/onesa/server.key"),
                                  ("hba", "/run/onesa/pg_hba.conf")):
            self.container["Mounts"].append({"Destination": destination, "Type": "bind",
                                             "Source": tls[name]["path"], "RW": False})

    def read(self, path, **_kwargs):
        return self.files[Path(path)]

    def inspect(self, kind, identity):
        rows = {("image", self.profile["image"]["reference"]): self.image,
                ("volume", self.profile["volume"]["name"]): self.volume,
                ("container", self.profile["container_id"]): self.container}
        rows.update({("network", key): value for key, value in self.networks.items()})
        return copy.deepcopy(rows[(kind, identity)])

    def runtime(self):
        with patch.object(target, "private_bytes", side_effect=self.read):
            return target.checked_runtime(self.profile, target.runtime_paths("production")["worker"])

    def change_runtime(self, kind, old, new):
        path = target.runtime_paths("production")[kind]
        self.files[path] = self.files[path].replace(old.encode(), new.encode())
        self.profile["runtime_sha256"][kind] = hashlib.sha256(self.files[path]).hexdigest()

    def test_valid_private_target_checks_both_writers_and_observed_resources(self):
        values, uri = self.runtime()
        self.assertEqual(uri.hostname, "portal-postgres-production")
        with patch.object(target, "private_bytes", side_effect=self.read), patch.object(target, "inspect", side_effect=self.inspect):
            observed = target.backup_binding(self.profile)
        self.assertEqual(observed["network_id"], "d" * 64)
        self.assertEqual(observed["profile_sha256"], target.digest(self.profile))
        self.assertEqual(base64.b64decode(values["ONESA_DATABASE_CA_PEM_B64"]), observed["ca"])

    def test_changed_runtime_hash_refuses_before_connecting(self):
        path = target.runtime_paths("production")["api"]
        self.files[path] += b"UNREVIEWED=1\n"
        with self.assertRaisesRegex(ValueError, "RUNTIME_CHANGED"):
            self.runtime()

    def test_changed_endpoint_role_database_tls_or_query_override_is_refused(self):
        original = copy.deepcopy((self.files, self.profile))
        for old, new in [("portal-postgres-production", "foreign.example"), ("onesa_portal_app", "postgres"),
                         (":5432/", ":5433/"), ("/portal_fixture?", "/foreign?"),
                         ("verify-full", "require"), ("verify-full", "verify-full&sslmode=disable"),
                         ("verify-full", "verify-full&sslrootcert=/tmp/foreign"),
                         ("verify-full", "verify-full#fragment")]:
            self.files, self.profile = copy.deepcopy(original)
            for kind in ("api", "worker"):
                self.change_runtime(kind, old, new)
            with self.subTest(case=new), self.assertRaisesRegex(ValueError, "RUNTIME_TARGET_MISMATCH"):
                self.runtime()

    def test_api_and_worker_cannot_use_different_credentials(self):
        self.change_runtime("api", "synthetic-fixture-only", "another-fixture")
        with self.assertRaisesRegex(ValueError, "API_WORKER_TARGET_MISMATCH"):
            self.runtime()

    def test_duplicate_env_keys_and_different_ca_are_refused(self):
        for replacement in ("DATABASE_URL=foreign\nDATABASE_URL=", "ONESA_DATABASE_CA_PEM_B64=invalid\nDATABASE_URL="):
            saved = copy.deepcopy((self.files, self.profile))
            self.change_runtime("worker", "DATABASE_URL=", replacement)
            with self.assertRaisesRegex(ValueError, "DUPLICATE_KEY"):
                self.runtime()
            self.files, self.profile = saved

    def test_profile_has_exact_schema_and_immutable_names(self):
        changes = [(lambda p: p.update(extra=True)), (lambda p: p.update(schema_version=True)),
                   (lambda p: p["image"].update(reference="postgres:latest")),
                   (lambda p: p["volume"].update(name="another-product-data")),
                   (lambda p: p["networks"]["worker"].update(name="host")),
                   (lambda p: p["database"].update(application_role="postgres")),
                   (lambda p: p["tls"]["key"].update(path="/etc/onesa/../other/key")),
                   (lambda p: p["tls"]["key"].update(path="/etc/onesa/key,ro"))]
        for change in changes:
            profile = copy.deepcopy(self.profile)
            change(profile)
            with self.subTest(change=change), self.assertRaises(ValueError):
                target.validate(profile)

    def test_wrong_architecture_recreated_volume_and_network_identity_fail_closed(self):
        original = copy.deepcopy((self.image, self.volume, self.networks))
        changes = [lambda: self.image.update(Architecture="amd64"),
                   lambda: self.image.update(Id="sha256:" + "f" * 64),
                   lambda: self.volume.update(CreatedAt="2026-11-07T00:00:00Z"),
                   lambda: self.networks["d" * 64].update(Id="f" * 64)]
        for change in changes:
            self.image, self.volume, self.networks = copy.deepcopy(original)
            change()
            with patch.object(target, "inspect", side_effect=self.inspect), self.assertRaises(ValueError):
                target.resources(self.profile)

    def test_public_port_foreign_mount_and_changed_container_are_refused(self):
        original = copy.deepcopy(self.container)
        changes = [lambda: self.container["HostConfig"].update(PortBindings={"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"}]}),
                   lambda: self.container["Mounts"][0].update(Name="foreign-volume"),
                   lambda: self.container["Mounts"][1].update(RW=True),
                   lambda: self.container.update(Id="f" * 64),
                   lambda: self.container["Config"].update(Entrypoint=["docker-entrypoint.sh"]),
                   lambda: self.container["Config"].update(Env=["PGDATA=/tmp/foreign"]),
                   lambda: self.container["NetworkSettings"]["Networks"]["onesa-portal-oracle-api_production"].update(NetworkID="f" * 64)]
        for change in changes:
            self.container = copy.deepcopy(original)
            change()
            with patch.object(target, "private_bytes", side_effect=self.read), patch.object(target, "inspect", side_effect=self.inspect), self.assertRaises(ValueError):
                target.backup_binding(self.profile)

    def test_tls_changed_file_and_trust_or_plaintext_hba_rule_are_refused(self):
        path = Path(self.profile["tls"]["key"]["path"])
        self.files[path] += b"changed"
        with patch.object(target, "private_bytes", side_effect=self.read), self.assertRaisesRegex(ValueError, "TLS_FILE_CHANGED"):
            target.tls_files(self.profile)
        self.files[path] = b"synthetic-fixture-key"
        for rule in (b"host all all all scram-sha-256\n", b"hostssl all all all trust\n", b"include /tmp/foreign\n"):
            path = Path(self.profile["tls"]["hba"]["path"])
            self.files[path] = b"hostssl all all 172.30.0.0/24 scram-sha-256\n" + rule
            self.profile["tls"]["hba"]["sha256"] = hashlib.sha256(self.files[path]).hexdigest()
            with patch.object(target, "private_bytes", side_effect=self.read), self.assertRaisesRegex(ValueError, "HBA_TLS_REQUIRED"):
                target.tls_files(self.profile)

    def test_render_is_separate_inert_and_cannot_seed_or_create_storage(self):
        existing = json.loads((ROOT / "compose.oracle-backend.yaml").read_text())
        self.assertEqual(set(existing["services"]), {"staging", "production"})
        self.assertEqual(set(existing["networks"]), {"staging", "production"})
        self.assertEqual(set(existing["volumes"]), {"staging_storage", "production_storage"})
        self.assertNotIn("${", json.dumps(existing["x-portal-container-primary"]))
        with patch.object(target, "inspect") as observe, patch.object(subprocess, "run") as execute:
            model = target.compose(self.profile)
        observe.assert_not_called()
        execute.assert_not_called()
        self.assertEqual(set(model["services"]), {"primary"})
        service = model["services"]["primary"]
        self.assertEqual(service["profiles"], ["container-primary"])
        self.assertEqual(service["entrypoint"], ["postgres"])
        self.assertEqual(service["pull_policy"], "never")
        self.assertEqual(service["platform"], "linux/arm64")
        self.assertNotIn("ports", service)
        self.assertNotIn("build", service)
        self.assertEqual(service["environment"], {"PGDATA": "/var/lib/postgresql/data"})
        self.assertNotIn("UNSELECTED", json.dumps(model))
        for resource in [*model["networks"].values(), *model["volumes"].values()]:
            self.assertTrue(resource["external"])
        for mount in service["volumes"]:
            if mount["type"] == "bind":
                self.assertTrue(mount["read_only"])
                self.assertFalse(mount["bind"]["create_host_path"])
        self.profile["container_id"] = None
        self.assertEqual(target.compose(self.profile), model)
        with self.assertRaisesRegex(ValueError, "PRIMARY_NOT_ENROLLED"):
            target.backup_binding(self.profile)

    def test_legacy_neon_target_remains_default_and_profile_error_never_falls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "absent.json"
            self.assertIsNone(target.load(missing))
            with self.assertRaisesRegex(ValueError, "PROFILE_MISSING"):
                target.load(missing, optional=False)
            path = Path(directory) / "worker.env"
            uri = "postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full"
            path.write_text("DATABASE_URL=" + uri + "\n")
            path.chmod(0o600)
            with patch.object(target, "load", return_value=None), patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)):
                self.assertEqual(backup.checked_env(path)[1].geturl(), uri)
            with patch.object(target, "load", side_effect=ValueError("PORTAL_DATABASE_PROFILE_SCHEMA")):
                with self.assertRaisesRegex(ValueError, "PROFILE_SCHEMA"):
                    backup.checked_env(path)

    def test_invalid_or_duplicate_profile_and_symlink_are_not_absence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text("fixture")
            for raw in (b'{"schema_version":1,"schema_version":1}', b'{}', b'not-json'):
                with patch.object(target, "private_bytes", return_value=raw), self.assertRaises(ValueError):
                    target.load(path)
            path.unlink()
            path.symlink_to(Path(directory) / "missing")
            with patch.object(target, "private_bytes", side_effect=OSError("synthetic unsafe path")), self.assertRaises(OSError):
                target.load(path)

    def test_private_custody_rejects_unsafe_mode_owner_and_symlink(self):
        parent = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        safe = dict(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1, st_size=1)
        for change in ({"st_uid": 1000}, {"st_mode": stat.S_IFREG | 0o644}, {"st_nlink": 2},
                       {"st_mode": stat.S_IFREG | 0o4600}, {"st_mode": stat.S_IFIFO | 0o600}):
            info = SimpleNamespace(**{**safe, **change})
            with patch.object(Path, "lstat", return_value=parent), patch.object(os, "open", return_value=9), patch.object(os, "fstat", return_value=info), patch.object(os, "close"):
                with self.assertRaises(ValueError):
                    target.private_bytes("/etc/onesa/fixture")
        with patch.object(Path, "lstat", return_value=parent), patch.object(os, "open", side_effect=OSError("symlink")) as opened:
            with self.assertRaises(OSError):
                target.private_bytes("/etc/onesa/fixture")
        self.assertTrue(opened.call_args.args[1] & os.O_NOFOLLOW)

    def test_local_backup_start_failure_cleans_up_ca_and_scoped_client(self):
        commands = []
        original_read = Path.read_text
        uri = urlsplit("postgresql://onesa_portal_app:synthetic@portal-postgres-production/portal_fixture?sslmode=verify-full")

        def read(path, *args, **kwargs):
            if path == Path("/etc/onesa/operations.json"):
                return json.dumps({"image": "onesa-portal-worker:" + "a" * 40})
            return original_read(path, *args, **kwargs)

        def run(argv, **_kwargs):
            commands.append(argv)
            self.assertEqual(argv[:len(target.DOCKER)], target.DOCKER)
            self.assertEqual(_kwargs["env"], target.PROCESS_ENV)
            if argv[len(target.DOCKER)] == "run":
                self.assertIn("d" * 64, argv)
                ca_mount = next(value for value in argv if value.endswith(":/secrets/database-ca.crt:ro"))
                self.assertEqual(Path(ca_mount.split(":", 1)[0]).read_bytes(), b"synthetic-ca")
                return subprocess.CompletedProcess(argv, 1, b"", b"synthetic failure")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with tempfile.TemporaryDirectory() as directory, patch.object(backup, "STATE", Path(directory)), patch.object(backup.os, "geteuid", return_value=0), patch.object(target, "load", return_value=self.profile), patch.object(backup, "checked_env", return_value=({}, uri)), patch.object(target, "backup_binding", return_value={"network_id": "d" * 64, "ca": b"synthetic-ca", "profile_sha256": "f" * 64}), patch.object(Path, "read_text", read), patch.object(subprocess, "run", side_effect=run):
            with self.assertRaises(ValueError):
                backup.backup()
            self.assertEqual(list(Path(directory).glob("*.conf")), [])
            self.assertEqual(list(Path(directory).glob("*.crt")), [])
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[1][len(target.DOCKER):len(target.DOCKER) + 3], ["rm", "-f", "--volumes"])
        self.assertTrue(commands[1][-1].startswith("onesa-scheduled-backup-"))

    def test_cutover_or_resource_drift_preserves_previous_success_receipt(self):
        original_read = Path.read_text
        original_files = copy.deepcopy(self.files)
        original_container = copy.deepcopy(self.container)

        def read(path, *args, **kwargs):
            if path == Path("/etc/onesa/operations.json"):
                return json.dumps({"image": "onesa-portal-worker:" + "a" * 40})
            return original_read(path, *args, **kwargs)

        for change in ("profile", "runtime", "resources_before_upload", "resources_during_upload"):
            self.files = copy.deepcopy(original_files)
            self.container = copy.deepcopy(original_container)
            current = {"profile": copy.deepcopy(self.profile), "uploaded": False}
            commands = []
            pipe = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(b"00000001-00000002-1\nEND\n[]\n"),
                                   returncode=0, wait=lambda **kwargs: 0, poll=lambda: 0)

            def attach_network():
                self.container["NetworkSettings"]["Networks"]["unreviewed-extra-network"] = {
                    "NetworkID": "f" * 64, "Aliases": [],
                }

            def run(argv, **kwargs):
                commands.append(argv)
                output = b"synthetic-client"
                if "pg_dump" in argv:
                    output = b"PGDMPsynthetic-dump"
                    if change == "resources_before_upload":
                        attach_network()
                if "backup.mjs" in argv:
                    self.assertEqual(json.loads(kwargs["input"])["action"], "backup")
                    current["uploaded"] = True
                    if change == "profile":
                        current["profile"]["runtime_sha256"]["api"] = "f" * 64
                    elif change == "runtime":
                        self.files[target.runtime_paths("production")["worker"]] += b"UNREVIEWED=1\n"
                    elif change == "resources_during_upload":
                        attach_network()
                    output = b'{"passed":true,"id":"synthetic-upload"}'
                return subprocess.CompletedProcess(argv, 0, output, b"")

            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                receipt = state / "backup-success.json"
                receipt.write_bytes(b'{"id":"previous-verified-backup"}\n')
                before = receipt.read_bytes()
                with patch.object(backup, "STATE", state), patch.object(backup.os, "geteuid", return_value=0), patch.object(target, "load", side_effect=lambda: copy.deepcopy(current["profile"])), patch.object(target, "private_bytes", side_effect=self.read), patch.object(target, "inspect", side_effect=self.inspect), patch.object(Path, "read_text", read), patch.object(subprocess, "run", side_effect=run), patch.object(subprocess, "Popen", return_value=pipe), patch.object(backup.select, "select", return_value=([pipe.stdout], [], [])):
                    reason = "PRIMARY_NETWORKS" if change.startswith("resources_") else "guard rejected|RUNTIME_CHANGED"
                    with self.assertRaisesRegex(ValueError, reason):
                        backup.backup()
                self.assertEqual(current["uploaded"], change != "resources_before_upload")
                if change.startswith("resources_"):
                    self.assertEqual(current["profile"], self.profile)
                    self.assertEqual(self.files, original_files)
                self.assertEqual(receipt.read_bytes(), before)
                self.assertFalse((state / "backup-success.tmp").exists())
                self.assertEqual(list(state.glob("*.conf")), [])
                self.assertEqual(list(state.glob("*.crt")), [])
                self.assertEqual(commands[-1][len(target.DOCKER):len(target.DOCKER) + 3], ["rm", "-f", "--volumes"])


if __name__ == "__main__":
    unittest.main()
