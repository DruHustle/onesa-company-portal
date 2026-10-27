"""Root-only scheduled read-only production backups; ciphertext lives off instance."""

import base64
import datetime
import fcntl
import json
import os
import re
import select
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

STATE = Path("/var/lib/onesa/operations")
ENV = Path("/etc/onesa/portal-production.env")
PG = "postgres@sha256:89f747171c4b0af0eacf5984550060be79786dbe286eb60cfa691d79d1e8b23f"


def require(value):
    if not value:
        raise ValueError("Production backup guard rejected")


def checked_env(path=ENV):
    require(
        path.is_file()
        and not path.is_symlink()
        and path.stat().st_uid == 0
        and path.stat().st_mode & 0o077 == 0
    )
    values = dict(
        line.split("=", 1) for line in path.read_text().splitlines() if "=" in line
    )
    u = urlsplit(values.get("DATABASE_URL", ""))
    require(
        u.hostname == "ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech"
        and u.username == "onesa_portal_app"
        and u.path == "/neondb"
        and parse_qs(u.query).get("sslmode") == ["verify-full"]
    )
    return values, u


def run(command, data=None):
    r = subprocess.run(
        command, input=data, capture_output=True, timeout=180, check=False
    )
    require(r.returncode == 0)
    return r.stdout


def backup():
    require(os.geteuid() == 0)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "backup.lock").open("w") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _values, u = checked_env()
        config = json.loads(Path("/etc/onesa/operations.json").read_text())
        require(re.fullmatch(r"onesa-portal-worker:[a-f0-9]{40}", config["image"]))
        service = STATE / ("pg-" + uuid.uuid4().hex + ".conf")
        fields = {
            "host": u.hostname,
            "user": u.username,
            "password": unquote(u.password),
            "dbname": "neondb",
            "sslmode": "verify-full",
            "sslrootcert": "/etc/ssl/certs/ca-certificates.crt",
            "channel_binding": "require",
        }
        require(all(not any(c in v for c in "\n\r\x00") for v in fields.values()))
        descriptor = os.open(service, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as f:
            f.write(
                "[production]\n"
                + "\n".join(k + "=" + v for k, v in fields.items())
                + "\n"
            )
        client = "onesa-scheduled-backup-" + uuid.uuid4().hex
        pipe = None
        try:
            run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--name",
                    client,
                    "--memory",
                    "256m",
                    "--cpus",
                    "0.1",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "-v",
                    str(service) + ":/secrets/pg.conf:ro",
                    "-e",
                    "PGSERVICEFILE=/secrets/pg.conf",
                    "-e",
                    "PGSERVICE=production",
                    "--entrypoint",
                    "sleep",
                    PG,
                    "180",
                ]
            )
            pipe = subprocess.Popen(
                [
                    "docker",
                    "exec",
                    "-i",
                    client,
                    "psql",
                    "-XqAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )

            def line():
                require(select.select([pipe.stdout], [], [], 30)[0])
                value = pipe.stdout.readline().decode().strip()
                require(value)
                return value

            pipe.stdin.write(
                b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n"
            )
            pipe.stdin.flush()
            snapshot = line()
            require(re.fullmatch("[A-Fa-f0-9-]{3,100}", snapshot))
            sql = "SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\nSELECT 'END';\n"
            pipe.stdin.write(sql.encode())
            pipe.stdin.flush()
            manifest = []
            while True:
                row = line()
                if row == "END":
                    break
                manifest.append(json.loads(row))
            pipe.stdin.write(
                b"SELECT coalesce(json_agg(json_build_object('storage_key',storage_key,'size',size,'sha256',sha256) ORDER BY storage_key),'[]'::json) FROM files;\n"
            )
            pipe.stdin.flush()
            files = json.loads(line())
            dump = run(
                [
                    "docker",
                    "exec",
                    client,
                    "pg_dump",
                    "-Fc",
                    "--no-owner",
                    "--no-acl",
                    "--snapshot=" + snapshot,
                ]
            )
            require(dump.startswith(b"PGDMP") and len(dump) < 64 * 1024 * 1024)
            payload = json.dumps(
                {
                    "action": "backup",
                    "id": uuid.uuid4().hex,
                    "dump": base64.b64encode(dump).decode(),
                    "files": files,
                    "manifest": manifest,
                }
            ).encode()
            result = run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-i",
                    "--read-only",
                    "--tmpfs",
                    "/tmp",
                    "--memory",
                    "512m",
                    "--cpus",
                    "0.1",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--env-file",
                    str(ENV),
                    "-v",
                    "/etc/onesa/recovery-public.pem:/recovery/public.pem:ro",
                    "-v",
                    str(Path(__file__).parents[3] / "scripts/oracle_backup_store.mjs")
                    + ":/app/backup.mjs:ro",
                    "--entrypoint",
                    "node",
                    config["image"],
                    "backup.mjs",
                ],
                payload,
            )
            receipt = json.loads(result)
            require(receipt["passed"])
            pipe.stdin.write(b"ROLLBACK;\n")
            pipe.stdin.close()
            pipe.wait(timeout=20)
            require(pipe.returncode == 0)
            receipt.update(
                verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                database_tables=len(manifest),
                consistent_snapshot=True,
                scheduled=True,
            )
            temporary = STATE / "backup-success.tmp"
            temporary.write_text(json.dumps(receipt, indent=2) + "\n")
            temporary.chmod(0o600)
            temporary.replace(STATE / "backup-success.json")
            (STATE / "backup-failure.json").unlink(missing_ok=True)
            print(
                json.dumps(
                    {"event": "portal_backup_success", "backup_id": receipt["id"]}
                )
            )
        finally:
            try:
                if pipe and pipe.poll() is None:
                    pipe.kill()
                    pipe.wait(timeout=20)
            finally:
                try:
                    subprocess.run(
                        ["docker", "rm", "-f", "--volumes", client],
                        capture_output=True,
                        timeout=20,
                        check=False,
                    )
                finally:
                    service.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        backup()
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        f = STATE / "backup-failure.json"
        f.write_text(
            json.dumps(
                {
                    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "event": "portal_backup_failed",
                }
            )
        )
        f.chmod(0o600)
        print("portal_backup_failed; private diagnostics required", file=sys.stderr)
        raise SystemExit(1) from None
