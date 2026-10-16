"""Replay a reviewed erasure ledger only inside a labeled network-isolated restore.

A replay receipt never authorizes service activation or proves the ledger is current.
"""

import datetime
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from uuid import UUID

KINDS = {
    "deleted_enquiries": "enquiries",
    "deleted_applications": "applications",
    "deleted_files": "files",
    "unpublished_content": "content",
    "disabled_users": "users",
}


def ledger(path):
    path = Path(path)
    info = path.lstat()
    if (
        path.is_symlink()
        or not path.is_file()
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > 256 * 1024
    ):
        raise ValueError("Private owned ledger required")
    raw = path.read_bytes()
    value = json.loads(raw)
    required = {
        "schema",
        "product",
        "source_backup_sha256",
        "backup_created_at",
        "reconciled_through",
        "events",
        "legal_holds",
    }
    if (
        set(value) != required
        or value["schema"] != 1
        or value["product"] != "portal"
        or not re.fullmatch("[a-f0-9]{64}", value["source_backup_sha256"])
    ):
        raise ValueError("Invalid replay ledger")
    start = datetime.datetime.fromisoformat(value["backup_created_at"])
    end = datetime.datetime.fromisoformat(value["reconciled_through"])
    if (
        start.tzinfo is None
        or end.tzinfo is None
        or not start <= end <= datetime.datetime.now(datetime.timezone.utc)
    ):
        raise ValueError("Invalid replay watermark")
    if set(value["events"]) != set(KINDS) or set(value["legal_holds"]) != set(KINDS):
        raise ValueError("Incomplete replay event categories")
    for ids in [*value["events"].values(), *value["legal_holds"].values()]:
        if not isinstance(ids, list) or len(ids) > 1000:
            raise ValueError("Replay event bound exceeded")
        for identifier in ids:
            if not isinstance(identifier, str) or str(UUID(identifier)) != identifier:
                raise ValueError("Invalid erased record identity")
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate erased record identity")
    if any(
        set(value["events"][kind]) & set(value["legal_holds"][kind]) for kind in KINDS
    ):
        raise ValueError("An erasure event conflicts with a legal hold")
    return value, hashlib.sha256(raw).hexdigest()


def isolated_target(container, database, inspection, value):
    if not re.fullmatch(
        "onesa-isolated-portal-restore-[a-f0-9]{12,32}", container
    ) or not re.fullmatch("onesa_[a-z0-9_]{1,48}_restore", database):
        raise ValueError("Only isolated named restore targets are supported")
    if len(inspection) != 1:
        raise ValueError("Ambiguous restore target")
    item = inspection[0]
    if not re.fullmatch("[a-f0-9]{64}", item.get("Id", "")):
        raise ValueError("Immutable restore container identity required")
    labels = item.get("Config", {}).get("Labels", {})
    if (
        item.get("Name") != "/" + container
        or item.get("HostConfig", {}).get("NetworkMode") != "none"
        or labels.get("org.onesa.restore-scope") != "isolated"
        or labels.get("org.onesa.product") != "portal"
        or labels.get("org.onesa.restore-snapshot-sha256")
        != value["source_backup_sha256"]
        or not item.get("State", {}).get("Running")
        or item.get("State", {}).get("OOMKilled")
        or item.get("HostConfig", {}).get("PortBindings")
        or any(m.get("Type") != "tmpfs" for m in item.get("Mounts", []))
    ):
        raise ValueError("Restore isolation or snapshot binding rejected")
    return item["Id"]


def replay_sql(value, lockdown_sql):
    def ids(kind, holds=False):
        return ",".join(
            "'" + str(UUID(identifier)) + "'::uuid"
            for identifier in value["legal_holds" if holds else "events"][kind]
        )

    commands = [
        "BEGIN;",
        "SET LOCAL statement_timeout='20s';",
        "SET LOCAL lock_timeout='2s';",
        "CREATE TEMP TABLE restore_deleted_files(id uuid PRIMARY KEY) ON COMMIT DROP;",
    ]
    if ids("deleted_files"):
        commands.append(
            "INSERT INTO restore_deleted_files SELECT id FROM files WHERE id IN ("
            + ids("deleted_files")
            + ") ON CONFLICT DO NOTHING;"
        )
    if ids("deleted_applications"):
        commands.append(
            "INSERT INTO restore_deleted_files SELECT file_id FROM applications WHERE id IN ("
            + ids("deleted_applications")
            + ") ON CONFLICT DO NOTHING;"
        )
    if ids("deleted_files", True):
        commands.append(
            "DO $hold$ BEGIN IF EXISTS(SELECT 1 FROM restore_deleted_files WHERE id IN ("
            + ids("deleted_files", True)
            + ")) THEN RAISE EXCEPTION 'Restored application file has a legal hold'; END IF; END $hold$;"
        )
    checks = []
    for kind in ["deleted_enquiries", "deleted_applications"]:
        if not ids(kind):
            continue
        table = KINDS[kind]
        commands.append(f"DELETE FROM {table} WHERE id IN ({ids(kind)});")
        prefixes = (
            ["enquiry:"]
            if kind == "deleted_enquiries"
            else ["application-notify:", "application-ack:"]
        )
        keys = ",".join(
            "'" + prefix + str(UUID(identifier)) + "'"
            for identifier in value["events"][kind]
            for prefix in prefixes
        )
        commands.append(f"DELETE FROM jobs WHERE dedupe_key IN ({keys});")
        checks.append(
            f"IF EXISTS(SELECT 1 FROM {table} WHERE id IN ({ids(kind)})) THEN RAISE EXCEPTION 'Restore erasure replay incomplete'; END IF;"
        )
    commands.append(
        "DELETE FROM files WHERE id IN (SELECT id FROM restore_deleted_files);"
    )
    checks.append(
        "IF EXISTS(SELECT 1 FROM files WHERE id IN (SELECT id FROM restore_deleted_files)) THEN RAISE EXCEPTION 'Restored erased file remains'; END IF;"
    )
    if ids("unpublished_content"):
        commands.append(
            "UPDATE content SET state='draft',publish_at=NULL WHERE id IN ("
            + ids("unpublished_content")
            + ");"
        )
    # Restore access is quarantined until current account/credential state is reconciled.
    # Preserve user identities and immutable governance/audit foreign keys.
    commands.extend(
        [
            "UPDATE users SET disabled=true,mfa_pending=NULL,enroll_hash=NULL,enroll_expires=NULL;",
            "DELETE FROM mfa_recovery;",
            "DELETE FROM bounded_transfers;",
            "UPDATE content SET publish_at=NULL;",
            "UPDATE files SET scan_status='quarantine' WHERE scan_status='clean';",
            "UPDATE storage_deletions SET status='failed',locked_at=NULL,last_error='Restore quarantine: independent storage reconciliation required' WHERE status IN ('pending','running');",
        ]
    )
    commands.append(lockdown_sql.split("BEGIN;\n", 1)[1].split("COMMIT;\n", 1)[0])
    checks.extend(
        [
            "IF EXISTS(SELECT 1 FROM sessions WHERE expires_at>now()) THEN RAISE EXCEPTION 'Restored session active'; END IF;",
            "IF EXISTS(SELECT 1 FROM recovery_tokens WHERE expires_at>now()) THEN RAISE EXCEPTION 'Restored recovery active'; END IF;",
            "IF EXISTS(SELECT 1 FROM users WHERE NOT disabled) THEN RAISE EXCEPTION 'Restored account enabled'; END IF;",
            "IF EXISTS(SELECT 1 FROM bounded_transfers) THEN RAISE EXCEPTION 'Restored transfer active'; END IF;",
            "IF EXISTS(SELECT 1 FROM content WHERE state='published' OR publish_at IS NOT NULL) THEN RAISE EXCEPTION 'Restored publication active'; END IF;",
            "IF EXISTS(SELECT 1 FROM files WHERE approval='approved' OR scan_status='clean') THEN RAISE EXCEPTION 'Restored file approved'; END IF;",
            "IF EXISTS(SELECT 1 FROM jobs WHERE status IN ('pending','running')) THEN RAISE EXCEPTION 'Restored job active'; END IF;",
            "IF EXISTS(SELECT 1 FROM storage_deletions WHERE status IN ('pending','running')) THEN RAISE EXCEPTION 'Restored storage deletion active'; END IF;",
        ]
    )
    commands.append("DO $restore$ BEGIN " + " ".join(checks) + " END $restore$;")
    commands.extend(
        ["COMMIT;", "SELECT 'ERASURE_REPLAY_AND_CAPABILITY_LOCKDOWN_PASS';"]
    )
    return "\n".join(commands)


def run(container, database, path, apply, lockdown_sql):
    if not apply:
        raise ValueError("Explicit isolated replay switch required")
    value, digest = ledger(path)
    inspect = json.loads(
        subprocess.check_output(["docker", "inspect", container], timeout=10)
    )
    identity = isolated_target(container, database, inspect, value)
    # Address the immutable container ID after validation; a name cannot be swapped.
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            identity,
            "psql",
            "-U",
            "postgres",
            "-d",
            database,
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=replay_sql(value, lockdown_sql),
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if (
        result.returncode
        or result.stdout.strip() != "ERASURE_REPLAY_AND_CAPABILITY_LOCKDOWN_PASS"
    ):
        raise ValueError("Isolated replay failed; no activation authorized")
    return {
        "result": "PASS",
        "scope": "isolated Portal restored-copy erasure/unpublication replay and capability lockdown",
        "ledger_sha256": digest,
        "reconciled_through": value["reconciled_through"],
        "source_backup_sha256": value["source_backup_sha256"],
        "erasure_events": {kind: len(ids) for kind, ids in value["events"].items()},
        "production_touched": False,
        "activation_authorized": False,
        "remaining": "Owner must establish complete authoritative post-snapshot ledger coverage through the required recovery watermark, restore integrity and release approval before any activation.",
    }
