"""Root-only AI/Robot snapshots using the existing encrypted off-instance transport.

No restore, live SQL mutation, backup deletion, account change or application restart.
"""

import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import backup

STATE = Path("/var/lib/onesa/operations")
CONFIG = Path("/etc/onesa/database-backups.json")
TARGETS = {
    "ai": Path("/etc/onesa/backends/ai-production.env"),
    "robot": Path("/etc/onesa/backends/robot-production.env"),
}
MAX = 64 * 1024 * 1024
TABLES = ("robot_simulation_tasks_v1", "robot_simulation_lease_v1")
ROBOT_SQL = """SELECT
 (SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%') AS schema_count,
 (SELECT sql FROM sqlite_schema WHERE type='table' AND name='robot_simulation_tasks_v1') AS tasks_schema,
 (SELECT json_group_array(json_object('id',id,'owner',owner,'proposal',proposal,'state',state,'reason',reason,'created',created,'position',position)) FROM (SELECT * FROM robot_simulation_tasks_v1 ORDER BY id)) AS tasks_rows,
 (SELECT sql FROM sqlite_schema WHERE type='table' AND name='robot_simulation_lease_v1') AS lease_schema,
 (SELECT json_group_array(json_object('id',id,'owner',owner,'expires',expires)) FROM (SELECT * FROM robot_simulation_lease_v1 ORDER BY id)) AS lease_rows"""


def private_json(path):
    info = path.lstat()
    if (
        not path.is_file()
        or path.is_symlink()
        or info.st_uid != 0
        or info.st_mode & 0o077
    ):
        raise ValueError("Private root-owned configuration required")
    return json.loads(path.read_text())


def settings_for(product, config):
    if product not in TARGETS or config.get("schema") != 1:
        raise ValueError("Unsupported snapshot profile")
    profile = config["products"][product]
    path = TARGETS[product]
    info = path.lstat()
    if (
        path.is_symlink()
        or not path.is_file()
        or info.st_uid != 0
        or info.st_mode & 0o077
    ):
        raise ValueError("Private runtime configuration required")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != profile["runtime_sha256"]:
        raise ValueError("Runtime configuration changed; review binding before backup")
    values = dict(
        line.split("=", 1) for line in raw.decode().splitlines() if "=" in line
    )
    environment_key = (
        "ONESA_ENVIRONMENT" if product == "ai" else "ROBOT_DEPLOYMENT_ENVIRONMENT"
    )
    if values.get(environment_key) != "production":
        raise ValueError("Production binding mismatch")
    uri = urllib.parse.urlsplit(
        values["ONESA_DATABASE_URL" if product == "ai" else "ROBOT_TURSO_DATABASE_URL"]
    )
    identity = f"{uri.scheme}|{uri.hostname}|{uri.port or (5432 if product == 'ai' else 443)}|{uri.username or ''}|{uri.path}"
    if hashlib.sha256(identity.encode()).hexdigest() != profile["target_sha256"]:
        raise ValueError("Database target mismatch")
    return values, uri


def pg_snapshot(uri):
    if uri.scheme not in ("postgresql", "postgresql+psycopg") or uri.path != "/neondb":
        raise ValueError("Unsupported PostgreSQL target")
    uid = uuid.uuid4().hex
    service = STATE / ("snapshot-pg-" + uid + ".conf")
    fields = {
        "host": uri.hostname,
        "port": str(uri.port or 5432),
        "user": urllib.parse.unquote(uri.username),
        "password": urllib.parse.unquote(uri.password),
        "dbname": "neondb",
        "sslmode": "verify-full",
        "sslrootcert": "/etc/ssl/certs/ca-certificates.crt",
        "channel_binding": "require",
        "options": "-c default_transaction_read_only=on",
    }
    if any(any(c in value for c in "\r\n\x00") for value in fields.values()):
        raise ValueError("Invalid connection configuration")
    with os.fdopen(
        os.open(service, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600),
        "w",
    ) as stream:
        stream.write(
            "[snapshot]\n" + "\n".join(k + "=" + v for k, v in fields.items()) + "\n"
        )
    client = "onesa-ai-snapshot-" + uid
    pipe = None
    deadline = time.monotonic() + 120

    def remaining(maximum):
        value = min(maximum, deadline - time.monotonic())
        if value <= 0:
            raise ValueError("Snapshot observation deadline")
        return value

    def checked(command, maximum):
        result = subprocess.run(
            command, capture_output=True, timeout=remaining(maximum), check=False
        )
        if result.returncode:
            raise ValueError("Snapshot command failed")
        return result.stdout

    try:
        checked(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--pull=never",
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
                "PGSERVICE=snapshot",
                "--entrypoint",
                "sleep",
                backup.PG,
                "180",
            ],
            15,
        )
        pipe = subprocess.Popen(
            ["docker", "exec", "-i", client, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        buffered = bytearray()

        def line():
            while b"\n" not in buffered:
                if not select.select([pipe.stdout], [], [], remaining(30))[0]:
                    raise ValueError("Snapshot read deadline")
                chunk = os.read(pipe.stdout.fileno(), 65536)
                if not chunk or len(buffered) + len(chunk) > MAX:
                    raise ValueError("Snapshot read bound")
                buffered.extend(chunk)
            index = buffered.index(b"\n")
            value = bytes(buffered[:index])
            del buffered[: index + 1]
            if not value:
                raise ValueError("Empty snapshot response")
            return value.decode().strip()

        pipe.stdin.write(
            b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n"
        )
        pipe.stdin.flush()
        snapshot = line()
        if not re.fullmatch("[A-Fa-f0-9-]{3,100}", snapshot):
            raise ValueError("Invalid snapshot identity")
        sql = "SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''),''UTF8'')),''hex'')) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\nSELECT 'END';\n"
        pipe.stdin.write(sql.encode())
        pipe.stdin.flush()
        manifest = []
        while True:
            value = line()
            if value == "END":
                break
            manifest.append(json.loads(value))
            if len(manifest) > 100:
                raise ValueError("Table bound exceeded")
        dump = checked(
            [
                "docker",
                "exec",
                client,
                "pg_dump",
                "-Fc",
                "--no-owner",
                "--no-acl",
                "--snapshot=" + snapshot,
            ],
            90,
        )
        if not dump.startswith(b"PGDMP") or len(dump) > MAX:
            raise ValueError("Invalid bounded PostgreSQL snapshot")
        pipe.stdin.write(b"ROLLBACK;\n")
        pipe.stdin.close()
        pipe.wait(timeout=15)
        if pipe.returncode:
            raise ValueError("Snapshot transaction failed")
        return dump, manifest
    finally:
        try:
            if pipe and pipe.poll() is None:
                pipe.kill()
                pipe.wait(timeout=15)
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


def robot_snapshot(values, uri):
    if (
        uri.scheme != "libsql"
        or uri.hostname != "onesa-ai-robot-backend-druhustle.aws-eu-west-1.turso.io"
        or uri.path not in ("", "/")
    ):
        raise ValueError("Unsupported Robot production target")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    request = urllib.request.Request(
        "https://" + uri.hostname + "/v2/pipeline",
        data=json.dumps(
            {
                "requests": [
                    {"type": "execute", "stmt": {"sql": ROBOT_SQL}},
                    {"type": "close"},
                ]
            }
        ).encode(),
        headers={
            "Authorization": "Bearer " + values["ROBOT_TURSO_AUTH_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "OnesaReadOnlySnapshot/1.0",
        },
    )
    with urllib.request.build_opener(NoRedirect()).open(
        request, timeout=25
    ) as response:
        raw = response.read(MAX + 1)
    if len(raw) > MAX:
        raise ValueError("Robot snapshot exceeds bound")
    results = json.loads(raw)["results"]
    if not all(r["type"] == "ok" for r in results):
        raise ValueError("Robot snapshot read failed")
    result = results[0]["response"]["result"]
    if len(result["rows"]) != 1:
        raise ValueError("Unexpected Robot snapshot shape")
    row = dict(
        zip(
            [x["name"] for x in result["cols"]],
            [c.get("value") for c in result["rows"][0]],
            strict=True,
        )
    )
    if int(row["schema_count"]) != 2:
        raise ValueError(
            "Robot schema changed; explicit backup coverage review required"
        )
    tables, manifest = [], []
    for prefix, name in zip(("tasks", "lease"), TABLES, strict=True):
        text = row[prefix + "_rows"]
        rows = json.loads(text)
        schema = row[prefix + "_schema"]
        if (
            not isinstance(rows, list)
            or not schema.startswith("CREATE TABLE ")
            or len(rows) > 10000
        ):
            raise ValueError("Invalid Robot table snapshot")
        tables.append({"name": name, "schema": schema, "rows_json": text})
        manifest.append(
            {
                "table": name,
                "count": len(rows),
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
    return json.dumps(
        {"format": "onesa-robot-snapshot-v1", "tables": tables}, separators=(",", ":")
    ).encode(), manifest


def main(product):
    if os.geteuid() != 0:
        raise ValueError("Root-only backup")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = private_json(CONFIG)
    values, uri = settings_for(product, config)
    with (STATE / ("database-backup-" + product + ".lock")).open("w") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        dump, manifest = (
            pg_snapshot(uri) if product == "ai" else robot_snapshot(values, uri)
        )
        backup.checked_env()
        transport = private_json(Path("/etc/onesa/operations.json"))["image"]
        if not re.fullmatch(r"onesa-portal-worker:[a-f0-9]{40}", transport):
            raise ValueError("Unreviewed backup transport image")
        scripts = Path(__file__).parents[3] / "scripts"
        payload = {
            "action": "database-backup",
            "product": product,
            "id": uuid.uuid4().hex,
            "snapshot": base64.b64encode(dump).decode(),
            "manifest": manifest,
        }
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-i",
                "--pull=never",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--memory",
                "256m",
                "--cpus",
                "0.1",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--env-file",
                str(backup.ENV),
                "-v",
                "/etc/onesa/recovery-public.pem:/recovery/public.pem:ro",
                "-v",
                str(scripts / "oracle_backup_store.mjs") + ":/app/backup.mjs:ro",
                "-v",
                str(scripts / "oracle_backup_payload.mjs")
                + ":/app/oracle_backup_payload.mjs:ro",
                "--entrypoint",
                "node",
                transport,
                "backup.mjs",
            ],
            input=json.dumps(payload).encode(),
            capture_output=True,
            timeout=90,
            check=False,
        )
        if result.returncode:
            raise ValueError("Encrypted transport failed")
        receipt = json.loads(result.stdout)
        if (
            not receipt["passed"]
            or receipt["product"] != product
            or receipt["id"] != payload["id"]
        ):
            raise ValueError("Backup verification failed")
        receipt.update(
            verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            consistent_snapshot=True,
            schedule_verified=False,
            automatic_deletion=False,
        )
        temp = STATE / ("database-backup-" + product + "-success.tmp")
        temp.write_text(json.dumps(receipt, indent=2))
        temp.chmod(0o600)
        temp.replace(STATE / ("database-backup-" + product + "-success.json"))
        (STATE / ("database-backup-" + product + "-failure.json")).unlink(
            missing_ok=True
        )
        print(
            json.dumps(
                {
                    "event": "database_backup_success",
                    "product": product,
                    "id": receipt["id"],
                }
            )
        )


if __name__ == "__main__":

    def terminated(_signum, _frame):
        raise TimeoutError("Snapshot service stopped")

    signal.signal(signal.SIGTERM, terminated)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", required=True, choices=tuple(TARGETS))
    args = parser.parse_args()
    try:
        main(args.product)
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        failure = STATE / ("database-backup-" + args.product + "-failure.json")
        failure.write_text(
            json.dumps(
                {
                    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "event": "database_backup_failed",
                    "product": args.product,
                }
            )
        )
        failure.chmod(0o600)
        print(
            "database_backup_failed; restricted diagnostics required",
            file=__import__("sys").stderr,
        )
        raise SystemExit(1) from None
