"""Independent owner-host DB/object/key recovery. Never write production data."""

import argparse
import base64
import datetime
import hmac
import json
import os
import subprocess
import time
import uuid
from urllib.parse import urlsplit

import oracle_operations as ops

PG = "postgres@sha256:89f747171c4b0af0eacf5984550060be79786dbe286eb60cfa691d79d1e8b23f"


def run(command, data=None, timeout=120, cwd=None):
    r = subprocess.run(
        command, input=data, capture_output=True, timeout=timeout, cwd=cwd, check=False
    )
    ops.worker.require(
        r.returncode == 0, "Independent recovery command failed; output redacted"
    )
    return r.stdout


def recover(sha):
    ops.worker.qualified_source(sha, ops.worker.evidence.GitHub())
    record = json.loads(
        (ops.PRIVATE / "production-operations-installation.json").read_text()
    )
    ops.worker.require(
        record["source_commit"] == sha, "Current qualified operations source required"
    )
    values = ops.production.inventory(
        ops.production.provider(
            "services/" + ops.production.SERVICE + "/env-vars?limit=100"
        )
    )
    ops.worker.require(
        urlsplit(values["DATABASE_URL"]).hostname == ops.production.DATABASE_HOST
        and urlsplit(values["S3_ENDPOINT"]).hostname == ops.production.BUCKET_HOST,
        "Existing production namespace required",
    )
    master = ops.PRIVATE / "production-backup-encryption.key"
    ops.worker.require(
        not master.is_symlink() and master.stat().st_mode & 0o077 == 0,
        "Private owner recovery master required",
    )
    backup = record["backup"]
    ops.worker.require(
        backup.get("object_count", 0) > 0,
        "Associated object recovery needs an actual synthetic object backup",
    )
    request = {
        "object_key": backup["object_key"],
        "key_id": backup["key_id"],
        "ciphertext_sha256": backup["ciphertext_sha256"],
        "endpoint": values["S3_ENDPOINT"],
        "region": values["S3_REGION"],
        "bucket": values["S3_BUCKET"],
        "access": values["AWS_ACCESS_KEY_ID"],
        "secret": values["AWS_SECRET_ACCESS_KEY"],
        "master": base64.b64encode(master.read_bytes()).decode(),
    }
    source = (ops.worker.ROOT / "scripts/oracle_backup_open.mjs").read_text()
    recovered = json.loads(
        run(
            ["node", "--input-type=module", "-e", source],
            json.dumps(request).encode(),
            cwd=ops.worker.ROOT / "onesa-company-portal-backend",
        )
    )
    ops.worker.require(
        hmac.compare_digest(recovered["session_key"], values["SESSION_KEY"]),
        "Recovered application key differs from the approved runtime key",
    )
    name = "onesa-independent-restore-" + uuid.uuid4().hex
    folder = ops.PRIVATE / ("independent-restore-" + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    started = time.monotonic()
    try:
        run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                "none",
                "--user",
                "70:70",
                "--memory",
                "256m",
                "--cpus",
                "0.2",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--tmpfs",
                "/var/lib/postgresql:uid=70,gid=70,mode=0700,size=128m",
                "--tmpfs",
                "/var/run/postgresql:uid=70,gid=70,mode=0777",
                "-e",
                "POSTGRES_HOST_AUTH_METHOD=trust",
                "-e",
                "POSTGRES_DB=portal_restore",
                "-e",
                "PGDATA=/var/lib/postgresql/data",
                PG,
                "-c",
                "shared_buffers=16MB",
                "-c",
                "max_connections=10",
                "-c",
                "max_worker_processes=2",
            ]
        )
        deadline = time.monotonic() + 90
        while subprocess.run(
            [
                "docker",
                "exec",
                name,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                "postgres",
                "-d",
                "portal_restore",
            ],
            capture_output=True,
            check=False,
        ).returncode:
            ops.worker.require(
                time.monotonic() < deadline, "Isolated recovery startup timed out"
            )
            time.sleep(1)
        run(
            [
                "docker",
                "exec",
                "-i",
                name,
                "pg_restore",
                "--no-owner",
                "--no-acl",
                "--exit-on-error",
                "-U",
                "postgres",
                "-d",
                "portal_restore",
            ],
            base64.b64decode(recovered["dump"]),
        )
        sql = "SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\n"
        rows = run(
            [
                "docker",
                "exec",
                "-i",
                name,
                "psql",
                "-XqAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "portal_restore",
            ],
            sql.encode(),
        )
        manifest = [json.loads(line) for line in rows.decode().splitlines()]
        ops.worker.require(
            manifest == recovered["manifest"], "Independent restored database differs"
        )
        for item in recovered["objects"]:
            target = folder / item["storage_key"]
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(base64.b64decode(item["bytes"]))
        # Recovered SESSION_KEY is verified against an actual encryption/decryption roundtrip in memory.
        crypto = "import fs from 'node:fs';import crypto from 'node:crypto';const x=JSON.parse(fs.readFileSync(0,'utf8')),key=crypto.createHash('sha256').update(x.key).digest(),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update('synthetic restored application-key check'),c.final()]),d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(c.getAuthTag());if(Buffer.concat([d.update(b),d.final()]).toString()!=='synthetic restored application-key check')process.exit(1);"
        run(
            ["node", "--input-type=module", "-e", crypto],
            json.dumps({"key": recovered["session_key"]}).encode(),
        )
        result = {
            "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_commit": sha,
            "backup_id": backup["id"],
            "database_tables_restored": len(manifest),
            "database_contents_match": True,
            "objects_recovered": len(recovered["objects"]),
            "session_encryption_key_recovered": True,
            "oracle_ssh_or_instance_used": False,
            "local_restore_network": "none",
            "public_ports": False,
            "restore_seconds": round(time.monotonic() - started, 3),
            "checks": recovered["checks"],
            "production_data_written": False,
            "production_release_qualified": False,
        }
        ops.save("production-independent-recovery.json", result)
        return result
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], capture_output=True, timeout=20, check=False
        )
        for path in folder.iterdir():
            path.unlink()
        folder.rmdir()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(recover(args.commit)))
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        raise SystemExit(
            "Independent recovery failed; output redacted, no PASS recorded"
        ) from None
