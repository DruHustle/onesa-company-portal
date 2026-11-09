"""Read existing Drone acceptance before optional, read-only operational monitoring.

This consumer cannot commission an installation, issue a record, run a release
runner or authorize hardware. Unsupported or incomplete acceptance stays held.
"""

import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import tempfile
import time
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

PROFILE = Path("/etc/onesa/operations-drone.json")
ANCHOR = Path("/etc/onesa/oracle-release-trust.json")
OPENSSL = Path("/usr/bin/openssl")
NAME = "drone-production"
TARGET = {
    "container": "onesa-drone-oracle-production-api-1",
    "product": "drone", "environment": "production",
    "url": "https://drone-api.onesa.eu/api/v1/health",
    "status": "ok", "probe": "liveness",
}
SCOPE = "DruHustle/onesa-drone:backend"
CHECKS = {
    "staging": {
        "source_build_image_identity", "configuration_and_isolation",
        "authentication_and_authorization", "persistence", "affected_workflows",
        "schema_and_migrations", "rollback_readiness", "security_and_contracts",
    },
    "operations": {
        "backup_restore", "monitoring_and_capacity", "privacy_publication_controls",
        "preservation_baseline", "rollback_readiness",
    },
    "deploy": {
        "exact_authorized_artifact", "configuration_preserved",
        "independent_components_preserved", "provider_receipt",
    },
    "production": {
        "source_build_image_identity", "health_readiness",
        "authentication_and_authorization", "affected_workflows",
        "persistence_preserved", "independent_components_preserved",
        "configuration_preserved", "no_unapproved_processing_or_actuation",
    },
}


class ActivationHold(ValueError):
    """Fixed codes only: private paths, records and configuration never leave custody."""


def require(condition, code="drone_acceptance_invalid"):
    if not condition:
        raise ActivationHold(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def decode(raw):
    def nonfinite(_):
        raise ActivationHold("drone_acceptance_invalid")
    try:
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite)
    except RecursionError:
        raise ActivationHold("drone_acceptance_invalid") from None
    require(isinstance(value, dict))
    return value


def private_path(path, *, directory=False, public=False):
    path = Path(path)
    require(path.is_absolute() and str(path) == os.path.normpath(path), "drone_custody_invalid")
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "drone_custody_invalid")
    info = path.lstat()
    require(info.st_uid == 0 and not info.st_mode & (0o022 if public else 0o077),
            "drone_custody_invalid")
    require(stat.S_ISDIR(info.st_mode) if directory else
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "drone_custody_invalid")
    return info


def read_bytes(path, *, limit=1024 * 1024, public=False):
    path = Path(path)
    before = private_path(path, public=public)
    require(0 < before.st_size <= limit, "drone_custody_invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
                "drone_custody_changed")
        with os.fdopen(os.dup(fd), "rb") as source:
            raw = source.read(limit + 1)
        after = private_path(path, public=public)
        require(0 < len(raw) <= limit and
                (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                "drone_custody_changed")
        return raw
    finally:
        os.close(fd)


def sha(value, length=64):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{%d}" % length, value) is not None


def identifier(value):
    require(isinstance(value, str) and str(UUID(value)) == value)
    return value


def stamp(value):
    require(isinstance(value, str))
    result = datetime.fromisoformat(value)
    require(result.utcoffset() is not None)
    return result


def validate_profile(value):
    require(set(value) == {
        "schema_version", "issuer_store", "verifier_file", "verification_record",
        "operation_id", "source_commit", "container_id", "image_id",
        "configuration_sha256", "container_name", "loopback_port",
    }, "drone_profile_invalid")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1 and
            value["container_name"] == TARGET["container"] and
            type(value["loopback_port"]) is int and value["loopback_port"] == 18540 and
            sha(value["source_commit"], 40) and sha(value["container_id"]) and
            sha(value["configuration_sha256"]) and
            isinstance(value["image_id"], str) and
            re.fullmatch(r"sha256:[a-f0-9]{64}", value["image_id"]), "drone_profile_invalid")
    identifier(value["verification_record"])
    identifier(value["operation_id"])
    return value


def verify_signature(record, signature, public_key, timeout=1):
    require(signature.get("algorithm") == "Ed25519")
    raw = base64.b64decode(signature["value"], validate=True)
    require(len(raw) == 64)
    # Only temporary public verification inputs are written; never open signing.pem.
    with tempfile.TemporaryDirectory(prefix="onesa-drone-observation-") as directory:
        paths = [Path(directory) / name for name in ("record", "signature", "public.pem")]
        for path, value in zip(paths, (canonical(record), raw, public_key)):
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as output:
                output.write(value)
        try:
            result = subprocess.run(
                [str(OPENSSL), "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(paths[2]),
                 "-sigfile", str(paths[1]), "-in", str(paths[0])],
                capture_output=True, timeout=timeout, check=False,
                env={"PATH": "/usr/bin:/bin", "LANG": "C"},
            )
        except subprocess.TimeoutExpired:
            raise ActivationHold("drone_acceptance_observation_timeout") from None
        except (OSError, subprocess.SubprocessError):
            raise ActivationHold("drone_signature_invalid") from None
        require(result.returncode == 0, "drone_signature_invalid")


@contextmanager
def readonly_ledger(path, deadline):
    """Open the validated inode, not a subsequently substituted pathname."""
    before = private_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
                "drone_custody_changed")
        uri = "file:/proc/self/fd/" + str(fd) + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
            # Bound a record before SQLite materializes it in Python, and abort
            # scans rather than merely checking the deadline after they finish.
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024 + 8192)
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            yield db
            after = private_path(path)
            require((opened.st_dev, opened.st_ino) == (after.st_dev, after.st_ino),
                    "drone_custody_changed")
    finally:
        os.close(fd)


def accepted_profile():
    """Consume the current commissioned ledger in read-only mode; never create authority."""
    require(os.geteuid() == 0, "drone_custody_invalid")
    deadline = time.monotonic() + 3
    now = datetime.now(timezone.utc)
    profile_raw = read_bytes(PROFILE, limit=16384)
    profile = validate_profile(decode(profile_raw))
    store = Path(profile["issuer_store"])
    private_path(store, directory=True)
    files = {
        "anchor": (ANCHOR, False, 256 * 1024), "trust": (store / "trust.json", False, 16384),
        "policy": (store / "policy.json", False, 256 * 1024), "public": (store / "public.pem", False, 16384),
        "verifier": (Path(profile["verifier_file"]), False, 2 * 1024 * 1024),
        "openssl": (OPENSSL, True, 16 * 1024 * 1024),
    }
    raw = {name: read_bytes(path, public=public, limit=limit)
           for name, (path, public, limit) in files.items()}
    anchor, trust, policy = (decode(raw[name]) for name in ("anchor", "trust", "policy"))
    installations = anchor.get("installations")
    require(isinstance(installations, dict), "drone_acceptance_uncommissioned")
    installation = installations.get(str(store))
    require(type(anchor.get("schema_version")) is int and anchor["schema_version"] == 1 and isinstance(installation, dict) and
            installation.get("active") is True and all(installation.get(key) == trust.get(key)
            for key in ("installation_id", "key_id", "verifier_sha256", "policy_sha256")),
            "drone_acceptance_uncommissioned")
    identifier(trust["installation_id"])
    require(all(sha(trust.get(key)) for key in
                ("key_id", "verifier_sha256", "policy_sha256", "openssl_sha256")) and
            digest(raw["public"]) == trust["key_id"] and
            digest(raw["verifier"]) == trust["verifier_sha256"] and
            digest(raw["policy"]) == trust["policy_sha256"] and
            digest(raw["openssl"]) == trust["openssl_sha256"], "drone_acceptance_pin_changed")
    component = policy["components"][SCOPE]
    require(set(component["runners"]) == set(CHECKS) and
            type(component.get("qualification_attempt_limit")) is int and
            1 <= component["qualification_attempt_limit"] <= 100)
    for phase, required in CHECKS.items():
        checks, runner = component["required_checks"][phase], component["runners"][phase]
        require(isinstance(checks, list) and len(checks) == len(set(checks)) and required <= set(checks)
                and sha(runner["sha256"]) and type(runner["timeout_seconds"]) is int and
                1 <= runner["timeout_seconds"] <= 3600)
    ledger = store / "records.sqlite"
    before = private_path(ledger)
    require(0 < before.st_size <= 256 * 1024 * 1024, "drone_custody_invalid")
    records, indexed, active = {}, {}, set()
    binding = None
    with readonly_ledger(ledger, deadline) as db:

        def observation(wrapper, phase, lower, upper, *, operation=None):
            require(isinstance(wrapper, dict) and set(wrapper) == {"runner_sha256", "observations"})
            observed = wrapper["observations"]
            require(isinstance(observed, dict) and
                    wrapper["runner_sha256"] == component["runners"][phase]["sha256"] and
                    observed["binding"] == binding and
                    observed["environment"] == ("staging" if phase == "staging" else "production") and
                    type(observed["workflow_run_id"]) is int and observed["workflow_run_id"] == 0 and
                    observed["physical_authority"] is False and observed["operation_id"] == operation and
                    isinstance(observed["checks"], dict) and
                    all(observed["checks"].get(name) == "PASS" for name in component["required_checks"][phase]) and
                    lower <= stamp(observed["observed_at"]) <= upper)
            return observed

        def get(record_id, kind):
            nonlocal binding
            identifier(record_id)
            require(record_id not in active and len(records) < 12)
            if record_id in records:
                require(records[record_id]["kind"] == kind)
                return records[record_id]
            active.add(record_id)
            row = db.execute("SELECT envelope,revoked,parent,kind,scope,created FROM records WHERE id=?",
                             (record_id,)).fetchone()
            require(row and row[1] == 0 and row[3] == kind and row[4] == SCOPE and
                    isinstance(row[0], str) and len(row[0].encode()) <= 1024 * 1024,
                    "drone_acceptance_missing_or_revoked")
            envelope = decode(row[0])
            require(set(envelope) == {"record", "signature"})
            record, signature = envelope["record"], envelope["signature"]
            require(isinstance(record, dict) and isinstance(signature, dict) and
                    signature.get("key_id") == trust["key_id"])
            remaining = deadline - time.monotonic()
            require(remaining > 0, "drone_acceptance_observation_timeout")
            verify_signature(record, signature, raw["public"], min(1, remaining))
            require(type(record["schema_version"]) is int and record["schema_version"] == 1 and
                    record["id"] == record_id and record["kind"] == kind and
                    record["parent"] == row[2] and record["issued_at"] == row[5] and
                    type(record["workflow_run_id"]) is int and record["workflow_run_id"] == 0 and
                    record["execution_context"] == ("owner-operated-oracle-staging"
                        if kind in {"context", "qualification"} else "owner-operated-oracle-release"))
            issued, expiry = stamp(record["issued_at"]), stamp(record["expires_at"])
            require(issued <= now and timedelta(0) < expiry - issued <= timedelta(hours=24))
            require(record["owner_provenance"] == {
                "owner": "DruHustle", "mechanism": "commissioned-pinned-OpenSSH-and-authenticated-owner",
                "installation_id": trust["installation_id"], "verifier_sha256": trust["verifier_sha256"],
            })
            current = record["binding"]
            require(isinstance(current, dict) and set(current) == {
                "repository", "component", "candidate_commit", "source_tree", "source_sha256",
                "build_sha256", "artifact_digest", "configuration_sha256", "target_environment",
            } and current["repository"] == "DruHustle/onesa-drone" and current["component"] == "backend"
                and current["target_environment"] == "production"
                and current["candidate_commit"] == profile["source_commit"] and sha(current["source_tree"], 40)
                and sha(current["source_sha256"]) and sha(current["build_sha256"])
                and re.fullmatch(r"sha256:[a-f0-9]{64}", current["artifact_digest"])
                and isinstance(current["configuration_sha256"], dict)
                and set(current["configuration_sha256"]) == {"staging", "production"}
                and all(sha(value) for value in current["configuration_sha256"].values()))
            require(binding is None or current == binding)
            binding = current
            details = record["details"]
            require(isinstance(details, dict))
            if kind == "context":
                require(record["parent"] is None and details["qualification_environment"] == "staging")
            elif kind == "qualification":
                context = get(record["parent"], "context")
                stage = observation(details["staging"], "staging", stamp(context["issued_at"]), issued)
                observation(details["operations"], "operations", stamp(stage["observed_at"]), issued)
            elif kind == "authorization-attempt":
                require(details["decision"] == "PENDING")
                get(record["parent"], "qualification")
            elif kind == "authorization":
                require(details["decision"] == "approve" and details["physical_hardware_authorized"] is False)
                get(record["parent"], "qualification")
                attempt = get(details["attempt_id"], "authorization-attempt")
                require(attempt["parent"] == record["parent"])
                observation(details["operations"], "operations", stamp(attempt["issued_at"]), issued)
            elif kind == "deployment-intent":
                require(details["authorization"] == record["parent"] and
                        type(details["provider_request_budget"]) is int and details["provider_request_budget"] == 1
                        and details["automatic_retry"] is False)
                get(record["parent"], "authorization")
            else:
                require(kind in {"production-verification", "deployment-receipt"})
                get(record["parent"], "deployment-intent")
            if record["parent"] is not None:
                require(stamp(records[record["parent"]]["issued_at"]) <= issued)
            records[record_id] = record
            indexed[record_id] = row
            active.remove(record_id)
            return record

        accepted = get(profile["verification_record"], "production-verification")
        require(accepted["parent"] == profile["operation_id"])
        operation = records[profile["operation_id"]]
        authorization = records[operation["parent"]]
        qualification = records[authorization["parent"]]
        require(db.execute("SELECT state,authorization,qualification FROM deployments WHERE id=?",
                           (operation["id"],)).fetchone() ==
                ("accepted", authorization["id"], qualification["id"]), "drone_deployment_not_accepted")
        require(db.execute("SELECT state FROM contexts WHERE id=?", (qualification["parent"],)).fetchone()
                == ("consumed",))
        require(db.execute("SELECT id FROM records WHERE scope=? AND kind='deployment-intent' ORDER BY sequence DESC LIMIT 1",
                           (SCOPE,)).fetchone() == (operation["id"],), "drone_acceptance_superseded")
        require(db.execute("SELECT id FROM records WHERE parent=? AND kind='production-verification' ORDER BY sequence DESC LIMIT 1",
                           (operation["id"],)).fetchone() == (accepted["id"],), "drone_acceptance_superseded")
        receipt_id = db.execute("SELECT id FROM records WHERE parent=? AND kind='deployment-receipt' ORDER BY sequence DESC LIMIT 1",
                                (operation["id"],)).fetchone()
        require(receipt_id, "drone_provider_receipt_missing")
        receipt = get(receipt_id[0], "deployment-receipt")
        for record, phase in ((receipt, "deploy"), (accepted, "production")):
            observations = observation(record["details"], phase, stamp(operation["issued_at"]),
                                       stamp(record["issued_at"]), operation=operation["id"])
            require(stamp(record["issued_at"]) - stamp(observations["observed_at"]) < timedelta(minutes=5))
        observed = accepted["details"]["observations"]
        require(observed["deployment_id"] == receipt["details"]["observations"]["deployment_id"]
                == profile["image_id"] and observed["qualification_profile"] == "shared-identity-v1"
                and observed["backend_runtime"] == {key: profile[key] for key in
                    ("container_id", "image_id", "source_commit", "configuration_sha256")},
                "drone_accepted_runtime_missing")
        after = private_path(ledger)
        require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), "drone_custody_changed")
    # Signatures may take time. A fresh read must still see the same unrevoked
    # chain, accepted operation and selected latest observation before returning.
    with readonly_ledger(ledger, deadline) as db:
        require(all(db.execute(
            "SELECT envelope,revoked,parent,kind,scope,created FROM records WHERE id=?", (key,)
        ).fetchone() == row for key, row in indexed.items()), "drone_acceptance_changed")
        require(db.execute("SELECT state,authorization,qualification FROM deployments WHERE id=?",
                           (operation["id"],)).fetchone() ==
                ("accepted", authorization["id"], qualification["id"]), "drone_acceptance_changed")
        require(db.execute("SELECT state FROM contexts WHERE id=?", (qualification["parent"],)).fetchone()
                == ("consumed",), "drone_acceptance_changed")
        require(db.execute("SELECT id FROM records WHERE scope=? AND kind='deployment-intent' ORDER BY sequence DESC LIMIT 1",
                           (SCOPE,)).fetchone() == (operation["id"],), "drone_acceptance_changed")
        require(db.execute("SELECT id FROM records WHERE parent=? AND kind='production-verification' ORDER BY sequence DESC LIMIT 1",
                           (operation["id"],)).fetchone() == (accepted["id"],), "drone_acceptance_changed")
        require(db.execute("SELECT id FROM records WHERE parent=? AND kind='deployment-receipt' ORDER BY sequence DESC LIMIT 1",
                           (operation["id"],)).fetchone() == receipt_id, "drone_acceptance_changed")
        after = private_path(ledger)
        require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), "drone_custody_changed")
    require(read_bytes(PROFILE, limit=16384) == profile_raw and all(
        read_bytes(path, public=public, limit=limit) == raw[name]
        for name, (path, public, limit) in files.items()), "drone_custody_changed")
    require(time.monotonic() < deadline, "drone_acceptance_observation_timeout")
    return {
        **{key: profile[key] for key in ("container_id", "image_id", "source_commit", "configuration_sha256")},
        "acceptance_sha256": digest(profile_raw + canonical(accepted) + raw["public"]),
    }


def runtime_matches(row, profile):
    """An accepted image alone cannot identify an unrelated or reconfigured container."""
    try:
        fingerprint = {
            "Config": row["Config"], "HostConfig": row["HostConfig"], "Mounts": row["Mounts"],
            "Networks": {name: value["NetworkID"] for name, value in row["NetworkSettings"]["Networks"].items()},
        }
        return (
            row["Id"] == profile["container_id"] and row["Image"] == profile["image_id"] and
            row["Name"] == "/" + TARGET["container"] and
            row["Config"]["Labels"]["org.onesa.source-commit"] == profile["source_commit"] and
            row["Config"]["Labels"]["org.onesa.mode"] == "simulation" and
            row["HostConfig"]["PortBindings"] ==
                {"8400/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18540"}]} and
            digest(canonical(fingerprint)) == profile["configuration_sha256"]
        )
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
