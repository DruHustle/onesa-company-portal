"""Synthetic signed-ledger and optional-route checks; no host or provider access."""

import base64
import copy
import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import test_oracle_monitor_envelope as mail

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "onesa_drone_acceptance_test", ROOT / "infra/oracle/operations/drone_monitoring.py"
)
drone = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drone)
monitor = mail.monitor


def runtime():
    return {
        "Id": "1" * 64, "Image": "sha256:" + "2" * 64,
        "Name": "/" + drone.TARGET["container"],
        "Config": {"Labels": {"org.onesa.source-commit": "3" * 40, "org.onesa.mode": "simulation"}},
        "HostConfig": {"PortBindings": {"8400/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18540"}]}},
        "Mounts": [], "NetworkSettings": {"Networks": {"synthetic": {"NetworkID": "4" * 64}}},
        "State": {"Running": True, "OOMKilled": False, "Health": {"Status": "healthy"}},
        "RestartCount": 2,
    }


def accepted_runtime(row=None):
    row = row or runtime()
    fingerprint = {key: row[key] for key in ("Config", "HostConfig", "Mounts")}
    fingerprint["Networks"] = {key: value["NetworkID"] for key, value in row["NetworkSettings"]["Networks"].items()}
    return {
        "container_id": row["Id"], "image_id": row["Image"],
        "source_commit": row["Config"]["Labels"]["org.onesa.source-commit"],
        "configuration_sha256": drone.digest(drone.canonical(fingerprint)),
    }


class SignedAcceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = self.root / "issuer"
        self.store.mkdir(mode=0o700)
        self.ledger = self.store / "records.sqlite"
        self.signing = self.root / "fixture-signing.pem"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.signing)],
                       check=True, capture_output=True)
        self.public = subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(self.signing), "-pubout"],
                                     check=True, capture_output=True).stdout
        self.ids = {key: str(uuid4()) for key in ("context", "qualification", "attempt", "authorization",
                                                "operation", "receipt", "accepted")}
        self.profile = {
            "schema_version": 1, "issuer_store": str(self.store),
            "verifier_file": str(self.root / "fixture-verifier.py"),
            "verification_record": self.ids["accepted"], "operation_id": self.ids["operation"],
            "container_name": drone.TARGET["container"], "loopback_port": 18540,
            **accepted_runtime(),
        }
        self.component = {
            "qualification_attempt_limit": 2,
            "runners": {phase: {"path": str(self.root / "fixture-runner.py"),
                                 "sha256": "5" * 64, "timeout_seconds": 30} for phase in drone.CHECKS},
            "required_checks": {phase: sorted(names) for phase, names in drone.CHECKS.items()},
        }
        self.policy = {"components": {drone.SCOPE: self.component}}
        self.trust = {
            "installation_id": str(uuid4()), "key_id": drone.digest(self.public),
            "verifier_sha256": drone.digest(b"synthetic verifier"),
            "policy_sha256": drone.digest(drone.canonical(self.policy)),
            "openssl_sha256": drone.digest(Path("/usr/bin/openssl").read_bytes()),
        }
        self.anchor = {"schema_version": 1, "installations": {str(self.store): {"active": True, **self.trust}}}
        self.binding = {
            "repository": "DruHustle/onesa-drone", "component": "backend", "target_environment": "production",
            "candidate_commit": self.profile["source_commit"], "source_tree": "6" * 40,
            "source_sha256": "7" * 64, "build_sha256": "8" * 64,
            "artifact_digest": "sha256:" + "9" * 64,
            "configuration_sha256": {"staging": "a" * 64, "production": "b" * 64},
        }
        self.records = {}
        self.record("context", "context", None, {"qualification_environment": "staging"})
        self.record("qualification", "qualification", "context", {
            "staging": self.observation("staging"), "operations": self.observation("operations"),
        })
        self.record("attempt", "authorization-attempt", "qualification", {"decision": "PENDING"})
        self.record("authorization", "authorization", "qualification", {
            "decision": "approve", "physical_hardware_authorized": False, "attempt_id": self.ids["attempt"],
            "operations": self.observation("operations"),
        })
        self.record("operation", "deployment-intent", "authorization", {
            "authorization": self.ids["authorization"], "provider_request_budget": 1, "automatic_retry": False,
        })
        for key, kind, phase in (("receipt", "deployment-receipt", "deploy"),
                                 ("accepted", "production-verification", "production")):
            self.record(key, kind, "operation", {
                "runner_sha256": "5" * 64,
                "observations": {
                    "binding": self.binding, "environment": "production", "workflow_run_id": 0,
                    "operation_id": self.ids["operation"], "deployment_id": self.profile["image_id"],
                    "physical_authority": False, "qualification_profile": "shared-identity-v1",
                    "backend_runtime": accepted_runtime(),
                    "checks": {name: "PASS" for name in drone.CHECKS[phase]},
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                },
            })
        self.write(drone.PROFILE.name, self.profile)
        self.write(drone.ANCHOR.name, self.anchor)
        self.write("fixture-verifier.py", b"synthetic verifier")
        for name, value in (("trust.json", self.trust), ("policy.json", self.policy), ("public.pem", self.public)):
            self.write(self.store / name, value)
        with sqlite3.connect(self.ledger) as db:
            db.executescript("""
                CREATE TABLE records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,kind TEXT,
                    scope TEXT,envelope TEXT,parent TEXT,created TEXT,revoked INTEGER DEFAULT 0);
                CREATE TABLE contexts(id TEXT PRIMARY KEY,state TEXT);
                CREATE TABLE deployments(id TEXT PRIMARY KEY,state TEXT,authorization TEXT,qualification TEXT);
            """)
            db.execute("INSERT INTO contexts VALUES(?, 'consumed')", (self.ids["context"],))
            db.execute("INSERT INTO deployments VALUES(?, 'accepted', ?, ?)",
                       (self.ids["operation"], self.ids["authorization"], self.ids["qualification"]))
        self.ledger.chmod(0o600)
        for key in self.records:
            self.persist(key)
        # Synthetic custody lives under TemporaryDirectory on non-root CI runners.
        # Cryptographic/ledger verification is real; real path rejection is tested separately.
        for patcher in (
            patch.object(drone, "PROFILE", self.root / drone.PROFILE.name),
            patch.object(drone, "ANCHOR", self.root / drone.ANCHOR.name),
            patch.object(drone.os, "geteuid", return_value=0),
            patch.object(drone, "private_path", side_effect=self.fixture_private),
        ):
            patcher.start(); self.addCleanup(patcher.stop)

    def fixture_private(self, path, *, directory=False, public=False):
        path = Path(path)
        if path == Path("/usr/bin/openssl"):
            return path.stat()
        self.assertTrue(path.is_relative_to(self.root))
        info = path.lstat()
        self.assertFalse(path.is_symlink())
        self.assertFalse(info.st_mode & 0o077)
        self.assertTrue(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        self.assertNotEqual(path, self.signing, "Consumer must never read a signing key")
        return info

    def write(self, path, value):
        path = path if isinstance(path, Path) else self.root / path
        path.write_bytes(value if isinstance(value, bytes) else drone.canonical(value))
        path.chmod(0o600)

    def record(self, key, kind, parent, details):
        now = datetime.now(timezone.utc)
        self.records[key] = {
            "schema_version": 1, "id": self.ids[key], "kind": kind,
            "binding": self.binding, "workflow_run_id": 0,
            "execution_context": "owner-operated-oracle-staging" if kind in {"context", "qualification"}
                else "owner-operated-oracle-release",
            "issued_at": now.isoformat(), "expires_at": (now + timedelta(hours=1)).isoformat(),
            "parent": self.ids[parent] if parent else None,
            "owner_provenance": {"owner": "DruHustle",
                "mechanism": "commissioned-pinned-OpenSSH-and-authenticated-owner",
                "installation_id": self.trust["installation_id"], "verifier_sha256": self.trust["verifier_sha256"]},
            "details": details,
        }

    def observation(self, phase):
        return {"runner_sha256": self.component["runners"][phase]["sha256"], "observations": {
            "binding": self.binding, "environment": "staging" if phase == "staging" else "production",
            "workflow_run_id": 0, "physical_authority": False, "operation_id": None,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "checks": {name: "PASS" for name in self.component["required_checks"][phase]},
        }}

    def persist(self, key):
        record = self.records[key]
        source = self.root / "signature-input"
        self.write(source, record)
        sig = subprocess.run(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(self.signing),
                              "-in", str(source)], check=True, capture_output=True).stdout
        envelope = {"record": record, "signature": {"algorithm": "Ed25519", "key_id": self.trust["key_id"],
                                                     "value": base64.b64encode(sig).decode()}}
        with sqlite3.connect(self.ledger) as db:
            db.execute("INSERT INTO records(id,kind,scope,envelope,parent,created) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope,created=excluded.created",
                       (record["id"], record["kind"], drone.SCOPE, drone.canonical(envelope).decode(),
                        record["parent"], record["issued_at"]))

    def test_real_signed_accepted_chain_returns_only_runtime_binding(self):
        result = drone.accepted_profile()
        self.assertEqual(set(result), set(accepted_runtime()) | {"acceptance_sha256"})
        self.assertEqual({key: result[key] for key in accepted_runtime()}, accepted_runtime())
        self.assertTrue(drone.sha(result["acceptance_sha256"]))

    def test_configured_profile_without_current_commission_is_not_acceptance(self):
        self.anchor["installations"][str(self.store)]["active"] = False
        self.write(drone.ANCHOR, self.anchor)
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_malformed_commission_index_is_a_hold(self):
        self.anchor["installations"] = []
        self.write(drone.ANCHOR, self.anchor)
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_revoked_record_or_owner_attempt_cannot_activate(self):
        for key in ("accepted", "operation", "authorization", "attempt", "qualification", "context", "receipt"):
            with self.subTest(key=key), sqlite3.connect(self.ledger) as db:
                db.execute("UPDATE records SET revoked=1 WHERE id=?", (self.ids[key],))
                db.commit()
                with self.assertRaises(drone.ActivationHold): drone.accepted_profile()
                db.execute("UPDATE records SET revoked=0")

    def test_unaccepted_or_newer_operation_holds(self):
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE deployments SET state='deployed-unverified'")
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE deployments SET state='accepted'")
            db.execute("INSERT INTO records(id,kind,scope,envelope) VALUES(?, 'deployment-intent', ?, '{}')",
                       (str(uuid4()), drone.SCOPE))
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_signed_source_only_or_missing_runtime_is_not_acceptance(self):
        self.records["accepted"]["details"]["observations"].pop("backend_runtime")
        self.persist("accepted")
        with self.assertRaises((drone.ActivationHold, KeyError)): drone.accepted_profile()

    def test_signed_failed_check_or_wrong_runtime_holds(self):
        original = copy.deepcopy(self.records["accepted"])
        mutations = (
            lambda r: r["details"]["observations"]["checks"].update(health_readiness="FAIL"),
            lambda r: r["details"]["observations"]["backend_runtime"].update(image_id="sha256:" + "c" * 64),
            lambda r: r["details"]["observations"].update(physical_authority=True),
            lambda r: r["details"]["observations"].update(qualification_profile="legacy-password-v1"),
            lambda r: r["binding"].update(configuration_sha256=["staging", "production"]),
        )
        for mutate in mutations:
            self.records["accepted"] = copy.deepcopy(original)
            mutate(self.records["accepted"])
            self.persist("accepted")
            with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_tampered_signature_and_changed_source_pin_hold(self):
        with sqlite3.connect(self.ledger) as db:
            text = db.execute("SELECT envelope FROM records WHERE id=?", (self.ids["accepted"],)).fetchone()[0]
            envelope = json.loads(text)
            envelope["record"]["details"]["observations"]["physical_authority"] = True
            db.execute("UPDATE records SET envelope=? WHERE id=?", (json.dumps(envelope), self.ids["accepted"]))
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()
        self.persist("accepted")
        self.write("fixture-verifier.py", b"changed synthetic verifier")
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_revocation_during_signature_verification_fails_fresh_readback(self):
        original = drone.verify_signature
        changed = False
        def verify(record, *args):
            nonlocal changed
            original(record, *args)
            if record["kind"] == "deployment-receipt" and not changed:
                changed = True
                # WAL lets a concurrent owner revoke while this consumer keeps
                # its initial read snapshot. The final read must see the change.
                with sqlite3.connect(self.ledger) as db:
                    db.execute("UPDATE records SET revoked=1 WHERE id=?", (self.ids["accepted"],))
        with sqlite3.connect(self.ledger) as db: db.execute("PRAGMA journal_mode=WAL")
        with patch.object(drone, "verify_signature", side_effect=verify):
            with self.assertRaises(drone.ActivationHold): drone.accepted_profile()
        self.assertTrue(changed)

    def test_empty_failed_or_foreign_qualification_observations_cannot_activate(self):
        original = copy.deepcopy(self.records["qualification"])
        mutations = (
            lambda r: r.update(details={}),
            lambda r: r["details"]["staging"]["observations"]["checks"].update(authentication_and_authorization="FAIL"),
            lambda r: r["details"]["operations"]["observations"]["checks"].pop("backup_restore"),
            lambda r: r["details"]["operations"]["observations"].update(checks=[]),
            lambda r: r["details"]["staging"].update(runner_sha256="0" * 64),
            lambda r: r["details"]["staging"]["observations"].update(environment="production"),
            lambda r: r["details"]["operations"]["observations"].update(physical_authority=True),
            lambda r: r["details"]["staging"]["observations"].update(observed_at="2000-01-01T00:00:00Z"),
        )
        for mutate in mutations:
            self.records["qualification"] = copy.deepcopy(original)
            mutate(self.records["qualification"])
            self.persist("qualification")
            with self.assertRaises((drone.ActivationHold, KeyError)): drone.accepted_profile()

    def test_authorization_operations_and_parent_chronology_are_required(self):
        self.records["authorization"]["details"]["operations"]["observations"]["checks"]["monitoring_and_capacity"] = "FAIL"
        self.persist("authorization")
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()
        self.records["authorization"]["details"]["operations"]["observations"]["checks"]["monitoring_and_capacity"] = "PASS"
        self.records["authorization"]["issued_at"] = "2000-01-01T00:00:00Z"
        self.records["authorization"]["expires_at"] = "2000-01-01T01:00:00Z"
        self.persist("authorization")
        with self.assertRaises(drone.ActivationHold): drone.accepted_profile()

    def test_oversized_ledger_record_is_refused_before_python_materialization(self):
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE records SET envelope=? WHERE id=?", ("x" * (2 * 1024 * 1024), self.ids["accepted"]))
        with self.assertRaises(sqlite3.DataError): drone.accepted_profile()


class OptionalObservation(unittest.TestCase):
    def setUp(self):
        self.profile = {**accepted_runtime(), "acceptance_sha256": "d" * 64}
        self.reader = SimpleNamespace(NAME=drone.NAME, TARGET=drone.TARGET,
                                      accepted_profile=lambda: self.profile, runtime_matches=drone.runtime_matches)

    def test_default_disabled_and_invalid_selection_never_read_or_probe_drone(self):
        with patch.object(monitor, "drone_reader", side_effect=AssertionError("No custody read")), \
             patch.object(monitor.subprocess, "run", side_effect=AssertionError("No host call")):
            self.assertEqual(monitor.sample_drone({}, {}), {})
            self.assertEqual(monitor.sample_drone({"drone_monitoring_enabled": False}, {})["drone_monitoring"]["status"], "disabled")
            self.assertEqual(monitor.sample_drone({"drone_monitoring_enabled": "true"}, {})["drone_monitoring"]["status"], "activation-held")

    def test_uncommissioned_selection_never_observes_container_or_public_url(self):
        self.reader.accepted_profile = lambda: (_ for _ in ()).throw(drone.ActivationHold("held"))
        with patch.object(monitor, "drone_reader", return_value=self.reader), \
             patch.object(monitor.subprocess, "run", side_effect=AssertionError("No host call")), \
             patch.object(monitor, "probe_backend", side_effect=AssertionError("No public probe")):
            self.assertEqual(monitor.sample_drone({"drone_monitoring_enabled": True}, {})["drone_monitoring"]["status"], "activation-held")

    def test_deeply_nested_bounded_json_holds_without_drone_observation(self):
        raw = '{"x":' * 1500 + '0' + '}' * 1500
        self.assertLess(len(raw.encode()), 16384)
        self.reader.accepted_profile = lambda: drone.decode(raw)
        # Use the stdlib recursive scanner so this exception path remains
        # reproducible on C decoders with different stack-limit behavior.
        with patch.object(json.scanner, "make_scanner", json.scanner.py_make_scanner), \
             patch.object(monitor, "drone_reader", return_value=self.reader), \
             patch.object(monitor.subprocess, "run", side_effect=AssertionError("No host call")), \
             patch.object(monitor, "probe_backend", side_effect=AssertionError("No URL probe")):
            self.assertEqual(monitor.sample_drone({"drone_monitoring_enabled": True}, {}),
                             {"drone_monitoring": {"status": "activation-held"}})

    def sample(self, row):
        with patch.object(monitor, "drone_reader", return_value=self.reader), \
             patch.object(monitor.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps([row]).encode())), \
             patch.object(monitor, "probe_backend", return_value={"http_healthy": True, "http_status": 200}) as probe:
            result = monitor.sample_drone({"drone_monitoring_enabled": True}, {drone.NAME: 1})
            return result, probe.call_count

    def test_exact_accepted_runtime_is_observed_without_changing_six_legacy_targets(self):
        result, count = self.sample(runtime())
        self.assertEqual(count, 1)
        self.assertTrue(result["backends"][drone.NAME]["container_healthy"])
        self.assertTrue(result["backends"][drone.NAME]["restarted"])
        self.assertEqual(set(monitor.BACKENDS), {f"{p}-{s}" for p in ("portal", "ai", "robot") for s in ("staging", "production")})

    def test_runtime_source_image_name_port_simulation_or_configuration_drift_fails(self):
        changes = (
            lambda r: r.update(Id="e" * 64), lambda r: r.update(Image="sha256:" + "f" * 64),
            lambda r: r.update(Name="/unrelated"),
            lambda r: r["Config"]["Labels"].update({"org.onesa.source-commit": "0" * 40}),
            lambda r: r["Config"]["Labels"].update({"org.onesa.mode": "physical"}),
            lambda r: r["HostConfig"]["PortBindings"]["8400/tcp"][0].update(HostIp="0.0.0.0"),
            lambda r: r["Config"].update(Env=["MODE=changed"]),
        )
        for change in changes:
            row = runtime(); change(row)
            result, count = self.sample(row)
            self.assertEqual(count, 0)
            self.assertFalse(result["backends"][drone.NAME]["container_healthy"])

    def test_drone_health_requires_simulation_in_response(self):
        for mode in (None, "physical", "simulation"):
            value = {"status": "ok", **({"mode": mode} if mode else {})}
            with patch.object(monitor.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(value).encode() + b"\n200"
            )):
                self.assertEqual(monitor.probe_backend_attempt(drone.NAME)["http_healthy"], mode == "simulation")

    def test_acceptance_change_during_sample_discards_drone_health(self):
        with patch.object(self.reader, "accepted_profile", side_effect=[self.profile, {**self.profile, "acceptance_sha256": "e" * 64}]):
            result, _ = self.sample(runtime())
        self.assertEqual(result, {"drone_monitoring": {"status": "activation-held"}})

    def test_missing_accepted_container_is_an_incident_without_an_unbound_http_probe(self):
        result, calls = self.sample({})
        self.assertEqual(result["drone_monitoring"]["status"], "accepted-profile")
        self.assertFalse(result["backends"][drone.NAME]["container_healthy"])
        self.assertEqual(calls, 0)


class OptionalMail(unittest.TestCase):
    def setUp(self):
        self.fixture = mail.DurableMailTests("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = '{"drone":"Onesa Drone <notifications-drone@onesa.eu>"}'
        self.proof = patch.object(monitor, "accepted_drone_profile", return_value={"acceptance_sha256": "d" * 64})
        self.proof.start(); self.addCleanup(self.proof.stop)

    def metrics(self, *other, failed=True):
        value = mail.metrics(*other)
        value["drone_monitoring"] = {"status": "accepted-profile", "acceptance_sha256": "d" * 64}
        value["backends"][drone.NAME] = {
            "container_healthy": True, "http_healthy": not failed,
            "http_status": 503 if failed else 200, "restarted": False,
        }
        value["backend_api_healthy"] = not (failed or other)
        return value

    def test_single_drone_sender_and_mixed_portal_sender(self):
        self.fixture.tick(self.metrics())
        self.assertEqual(self.fixture.body()["from"], "Onesa Drone <notifications-drone@onesa.eu>")
        self.fixture.tick(self.metrics("robot-production"), elapsed=1801)
        self.assertEqual(self.fixture.body()["from"], self.fixture.values["MAIL_FROM"])

    def test_optional_mapping_does_not_block_existing_product_without_activation(self):
        self.fixture.tick(mail.metrics("robot-production"))
        self.assertEqual(self.fixture.body()["from"], self.fixture.values["MAIL_FROM"])

    def test_ambiguous_drone_delivery_retries_identical_envelope(self):
        self.fixture.failures = 1
        with self.assertRaises(TimeoutError): self.fixture.tick(self.metrics())
        pending = copy.deepcopy(self.fixture.read()["notification_pending"])
        first = self.fixture.requests[0]
        self.fixture.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = '{"drone":"alerts-drone@onesa.eu"}'
        self.fixture.tick(self.metrics())
        self.assertEqual(self.fixture.requests[-1].data, first.data)
        self.assertEqual(self.fixture.requests[-1].headers, first.headers)
        self.assertEqual(pending["drone_acceptance_sha256"], "d" * 64)

    def test_revoked_or_disabled_acceptance_holds_pending_without_new_send(self):
        self.fixture.failures = 1
        with self.assertRaises(TimeoutError): self.fixture.tick(self.metrics())
        pending = copy.deepcopy(self.fixture.read()["notification_pending"])
        with patch.object(monitor, "accepted_drone_profile", side_effect=ValueError("revoked")):
            self.fixture.tick(self.metrics())
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertEqual(self.fixture.read()["notification_pending"], pending)
        self.assertTrue(self.fixture.read()["notification_pending_policy_hold"])
        self.fixture.tick(self.metrics())
        self.assertEqual(len(self.fixture.requests), 1, "Restored config cannot silently clear a reconciliation hold")

    def test_missing_enrollment_never_sends_a_new_drone_event(self):
        value = self.metrics()
        value["drone_monitoring"] = {"status": "activation-held"}
        self.fixture.tick(value)
        self.assertEqual(self.fixture.requests, [])
        self.assertTrue(self.fixture.read()["notification_pending_policy_hold"])

    def test_new_acceptance_cannot_silently_recover_an_old_drone_incident(self):
        self.fixture.tick(self.metrics())
        healthy = self.metrics(failed=False)
        healthy["drone_monitoring"]["acceptance_sha256"] = "e" * 64
        with patch.object(monitor, "accepted_drone_profile", return_value={"acceptance_sha256": "e" * 64}):
            for _ in range(7): self.fixture.tick(healthy)
        self.assertEqual(len(self.fixture.requests), 1)
        self.assertTrue(self.fixture.read()["notification_pending_policy_hold"])
        self.assertEqual(self.fixture.read()["notification_pending"]["drone_acceptance_sha256"], "d" * 64)


class CustodyBoundary(unittest.TestCase):
    def test_private_file_rejects_alias_owner_mode_and_hardlink_drift(self):
        path = Path("/etc/onesa/synthetic-profile.json")
        def metadata(selected, **changes):
            return SimpleNamespace(st_mode=(stat.S_IFREG | 0o600) if selected == path else (stat.S_IFDIR | 0o700),
                                   st_uid=0, st_nlink=1, **changes)
        with patch.object(Path, "lstat", autospec=True, side_effect=lambda selected: metadata(selected)):
            drone.private_path(path)
        for field, value in (("st_mode", stat.S_IFLNK | 0o600), ("st_mode", stat.S_IFREG | 0o644),
                             ("st_uid", 1001), ("st_nlink", 2)):
            def observed(selected):
                result = metadata(selected)
                if selected == path: setattr(result, field, value)
                return result
            with patch.object(Path, "lstat", autospec=True, side_effect=observed):
                with self.assertRaises(drone.ActivationHold): drone.private_path(path)

    def test_private_file_rejects_writable_or_aliased_ancestor(self):
        path = Path("/etc/onesa/synthetic-profile.json")
        for mode in (stat.S_IFDIR | 0o777, stat.S_IFLNK | 0o700):
            def observed(selected):
                return SimpleNamespace(st_mode=mode if selected == path.parent else stat.S_IFDIR | 0o755,
                                       st_uid=0, st_nlink=1)
            with patch.object(Path, "lstat", autospec=True, side_effect=observed):
                with self.assertRaises(drone.ActivationHold): drone.private_path(path)

    def test_duplicate_and_nonfinite_profile_values_fail_closed(self):
        for raw in ('{"enabled":true,"enabled":false}', '{"value":NaN}'):
            with self.assertRaises(drone.ActivationHold): drone.decode(raw)

    def test_ledger_descriptor_does_not_open_a_substituted_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.sqlite"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE test(value INTEGER)")
                db.execute("INSERT INTO test VALUES(1)")
            original = sqlite3.connect
            observed = []
            def connect(database, **kwargs):
                path.rename(path.with_name("retained.sqlite"))
                with original(path) as replacement:
                    replacement.execute("CREATE TABLE test(value INTEGER)")
                    replacement.execute("INSERT INTO test VALUES(9)")
                return original(database, **kwargs)
            with patch.object(drone, "private_path", side_effect=lambda p, **_: Path(p).stat()), \
                 patch.object(drone.sqlite3, "connect", side_effect=connect):
                with self.assertRaises(drone.ActivationHold):
                    with drone.readonly_ledger(path, time.monotonic() + 3) as db:
                        observed.append(db.execute("SELECT value FROM test").fetchone()[0])
            self.assertEqual(observed, [1])

    def test_descriptor_reader_observes_delete_journal_commits(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.sqlite"
            with sqlite3.connect(path) as writer:
                self.assertEqual(writer.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
                writer.execute("CREATE TABLE test(value INTEGER)")
                writer.execute("INSERT INTO test VALUES(1)")
            with patch.object(drone, "private_path", side_effect=lambda p, **_: Path(p).stat()):
                with drone.readonly_ledger(path, time.monotonic() + 3) as reader:
                    self.assertEqual(reader.execute("SELECT value FROM test").fetchone(), (1,))
                with sqlite3.connect(path) as writer:
                    writer.execute("UPDATE test SET value=2")
                with drone.readonly_ledger(path, time.monotonic() + 3) as reader:
                    self.assertEqual(reader.execute("SELECT value FROM test").fetchone(), (2,))
            self.assertFalse(path.with_name(path.name + "-wal").exists())

    def test_descriptor_reader_uses_live_wal_and_fresh_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.sqlite"
            writer = sqlite3.connect(path)
            try:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE test(value INTEGER)")
                writer.execute("INSERT INTO test VALUES(1)")
                writer.commit()
                writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                writer.execute("UPDATE test SET value=9")
                writer.commit()
                self.assertGreater(path.with_name(path.name + "-wal").stat().st_size, 0)
                companions = {item.name for item in path.parent.iterdir()}
                with patch.object(drone, "private_path", side_effect=lambda p, **_: Path(p).stat()):
                    with drone.readonly_ledger(path, time.monotonic() + 3) as reader:
                        self.assertEqual(reader.execute("PRAGMA journal_mode").fetchone()[0], "wal")
                        self.assertEqual(reader.execute("SELECT value FROM test").fetchone(), (9,))
                        writer.execute("UPDATE test SET value=10")
                        writer.commit()
                        self.assertEqual(reader.execute("SELECT value FROM test").fetchone(), (9,))
                    with drone.readonly_ledger(path, time.monotonic() + 3) as reader:
                        self.assertEqual(reader.execute("SELECT value FROM test").fetchone(), (10,))
                self.assertEqual({item.name for item in path.parent.iterdir()}, companions)
            finally:
                writer.close()

    def test_verifier_timeout_or_process_failure_is_a_fixed_activation_hold(self):
        signature = {"algorithm": "Ed25519", "value": base64.b64encode(bytes(64)).decode()}
        for failure, code in (
            (subprocess.TimeoutExpired("synthetic", 0.01), "drone_acceptance_observation_timeout"),
            (OSError("private synthetic path"), "drone_signature_invalid"),
        ):
            with patch.object(drone.subprocess, "run", side_effect=failure):
                with self.assertRaisesRegex(drone.ActivationHold, "^" + code + "$"):
                    drone.verify_signature({}, signature, b"synthetic public key", 0.01)

    def test_ledger_progress_handler_interrupts_expired_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.sqlite"
            sqlite3.connect(path).close()
            with patch.object(drone, "private_path", side_effect=lambda p, **_: Path(p).stat()):
                with self.assertRaises(sqlite3.OperationalError):
                    with drone.readonly_ledger(path, time.monotonic() - 1) as db:
                        db.execute("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n").fetchone()


if __name__ == "__main__":
    unittest.main()
