"""Actual encrypted-backup restore proof in a disposable, offline PostgreSQL.

The commissioned identity plan pins existing owner recovery custody and a reviewed
erasure replay ledger. This code reads the real off-instance encrypted archive,
checks its recovered contents, restores into RAM without a network or host mount,
and quarantines every restored capability. It cannot activate a restored service.
"""

import base64
import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import subprocess
import time
from pathlib import Path

import oracle_portal as r
import oracle_portal_identity as identity
import restore_lockdown
import restore_replay

BACKUP = Path("/var/lib/onesa/operations/backup-success.json")
MANIFEST_SQL = "SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\n"

# Executed only inside the source-bound candidate image, sharing the network
# namespace of the already quarantined, networkless restore. All accounts and
# credentials below are synthetic and exist only for the lifetime of that copy.
FALLBACK_PROGRAM = r"""
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const {db} = await import('./dist/src/services/db.js');
const {passwordHash,encrypt,totp} = await import('./dist/src/auth/crypto.js');
const {buildApp} = await import('./dist/src/app.js');
const owner=randomUUID(), member=randomUUID();
const ownerEmail='onesa-fallback-'+owner+'@example.invalid';
const memberEmail='onesa-fallback-'+member+'@example.invalid';
const password='Synthetic offline fallback password';
const secret='JBSWY3DPEHPK3PXP';
let app, worker;
try {
  await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,NULL)',
    [owner,ownerEmail,passwordHash(password),'owner',encrypt(secret),member,memberEmail,passwordHash(password),'member']);
  await db.query("INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,'Synthetic member',now())",[member]);
  await db.query("INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'ai','user','active')",[member]);
  const before=(await db.query('SELECT id,email,password_hash,role,disabled FROM users WHERE id=$1',[member])).rows[0];
  app=await buildApp({logging:false}); await app.ready();
  const config=await app.inject({url:'/api/v1/account/config'});
  assert.equal(config.statusCode,200); assert.equal(config.json().enabled,false);
  const ready=await app.inject({url:'/api/v1/ready'}); assert.equal(ready.statusCode,200);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:ownerEmail,password,code:totp(secret)}});
  assert.equal(login.statusCode,200); assert.equal(login.json().user.id,owner);
  const cookie=login.cookies.filter(c=>c.value).map(c=>c.name+'='+c.value).join('; ');
  const list=await app.inject({url:'/api/v1/admin/users?search='+encodeURIComponent(ownerEmail),headers:{cookie}});
  assert.equal(list.statusCode,200); assert.ok(list.json().items.some(u=>u.id===owner && u.role==='owner'));
  const members=await app.inject({url:'/api/v1/admin/users?search='+encodeURIComponent(memberEmail),headers:{cookie}});
  assert.equal(members.statusCode,200); assert.equal(members.json().items.length,0);
  const deny=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:memberEmail,password,code:''}});
  assert.equal(deny.statusCode,401);
  const start=(await db.query('SELECT clock_timestamp()::text AS started')).rows[0].started;
  worker=spawn(process.execPath,['dist/src/jobs/worker.js'],{stdio:'ignore'});
  let observed=false;
  for(let i=0;i<100;i++) {
    if(worker.exitCode!==null) break;
    const result=await db.query("SELECT updated_at >= $1::timestamptz AS updated FROM operational_state WHERE key='worker_success'",[start]);
    if(result.rows[0]?.updated===true) {observed=true; break;}
    await delay(300);
  }
  assert.equal(observed,true);
  assert.equal(worker.exitCode,null); assert.equal(worker.kill('SIGTERM'),true);
  const stopped=await Promise.race([new Promise(resolve=>worker.once('exit',()=>resolve(true))),delay(10000).then(()=>false)]);
  assert.equal(stopped,true); worker=undefined;
  assert.deepEqual((await db.query('SELECT id,email,password_hash,role,disabled FROM users WHERE id=$1',[member])).rows[0],before);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM identity_product_access WHERE user_id=$1 AND product='ai' AND role='user' AND status='active'",[member])).rows[0].n,1);
  process.stdout.write(JSON.stringify({representative_member_present:true,account_serialization:true,native_authentication:true,api_behavior:true,worker_behavior:true}));
} finally {
  if(worker && worker.exitCode===null) worker.kill('SIGKILL');
  if(app) await app.close();
  await db.end();
}
"""


def validate(plan):
    value = plan["restore"]
    identity.exact(
        value, ["recovery_file", "ledger_file"], "IDENTITY_RESTORE_PLAN_SCHEMA"
    )
    identity.pinned(value["recovery_file"])
    identity.pinned(value["ledger_file"])
    tool = r.trusted_toolchain(plan)
    for name in [
        "oracle_portal_identity_restore.py",
        "restore_lockdown.py",
        "restore_replay.py",
        "oracle_backup_open.mjs",
    ]:
        upstream = (
            "scripts/" if name == "oracle_backup_open.mjs" else "scripts/release/"
        ) + name
        r.pinned_public_file(
            Path(__file__).with_name(name), tool["workflow_files"][upstream]
        )
    return value, tool


def backup_current():
    backup = r.read(BACKUP)
    r.require(
        backup["passed"] is True
        and backup["consistent_snapshot"] is True
        and backup["off_instance_storage_verified"] is True
        and dt.timedelta()
        <= r.now() - dt.datetime.fromisoformat(backup["verified_at"])
        < dt.timedelta(hours=36)
        and re.fullmatch(
            r"\.onesa-portal-backups/v1/[a-f0-9]{32}\.json", backup["object_key"]
        )
        and all(
            identity.pin(backup[key])
            for key in ["key_id", "ciphertext_sha256", "dump_sha256"]
        ),
        "IDENTITY_CURRENT_BACKUP_REQUIRED",
    )
    return backup


def verify_retained(plan, proof):
    value, _ = validate(plan)
    backup = backup_current()
    identity.private_bytes(value["ledger_file"])
    replay, checksum = restore_replay.ledger(value["ledger_file"]["path"])
    r.require(
        proof["state"] == "ISOLATED_IDENTITY_RESTORE_OBSERVED_NOT_AUTHORIZATION"
        and proof["backup_ciphertext_sha256"] == backup["ciphertext_sha256"]
        and proof["backup_dump_sha256"] == backup["dump_sha256"]
        and proof["ledger_sha256"] == checksum == value["ledger_file"]["sha256"]
        and proof["database_contents_match"] is True
        and proof["capability_lockdown"] is True
        and proof["isolated_container_removed"] is True
        and proof["activation_authorized"] is False
        and replay["source_backup_sha256"] == backup["dump_sha256"]
        and dt.timedelta()
        <= r.now() - dt.datetime.fromisoformat(proof["observed_at"])
        < dt.timedelta(hours=1),
        "IDENTITY_RESTORE_PROOF_STALE_OR_CHANGED",
    )
    return backup


def verify_fallback(proof, binding):
    """Refuse rollout until the isolated restored-data fallback was observed.

    A restored schema and a healthy old container alone are not evidence that a
    member account can coexist with the native API and worker.  The observation
    must be produced by the restore operation, not supplied by an operator.
    """
    fallback = proof.get("compatible_fallback")
    r.require(
        isinstance(fallback, dict)
        and fallback.get("image") == binding["artifact_digest"]
        and fallback.get("source_commit") == binding["candidate_commit"]
        and fallback.get("identity_enabled") is False
        and fallback.get("representative_member_present") is True
        and fallback.get("account_serialization") is True
        and fallback.get("native_authentication") is True
        and fallback.get("api_behavior") is True
        and fallback.get("worker_behavior") is True
        and fallback.get("operation_resources_removed") is True,
        "IDENTITY_COMPATIBLE_FALLBACK_REHEARSAL_REQUIRED",
    )


def verify_container_removed(container):
    """Confirm the exact operation-owned container is absent from Docker."""
    r.require(
        re.fullmatch(r"[a-f0-9]{64}", container) is not None,
        "IDENTITY_RESTORE_CONTAINER_IDENTITY",
    )
    remaining = r.docker(
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "id=" + container,
        "--format",
        "{{.ID}}",
        timeout=20,
    )
    r.require(not remaining.strip(), "IDENTITY_RESTORE_CLEANUP_NOT_CONFIRMED")


def private_capture(args, data, timeout=180):
    # The reviewed decryptor bounds the response to the existing 128 MiB archive
    # format. Recovered bytes stay in memory and are never logged or persisted.
    result = subprocess.run(
        args,
        input=data,
        capture_output=True,
        timeout=timeout,
        check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    r.require(
        result.returncode == 0 and len(result.stdout) <= 128 * 1024 * 1024,
        "IDENTITY_BACKUP_RECOVERY_FAILED",
    )
    return result.stdout


def payload_valid(payload, backup, session_key):
    identity.exact(
        payload,
        ["dump", "objects", "manifest", "session_key", "checks"],
        "IDENTITY_RECOVERED_PAYLOAD_SCHEMA",
    )
    dump = base64.b64decode(payload["dump"], validate=True)
    r.require(
        dump.startswith(b"PGDMP")
        and len(dump) < 64 * 1024 * 1024
        and hashlib.sha256(dump).hexdigest() == backup["dump_sha256"],
        "IDENTITY_RECOVERED_DUMP_CHANGED",
    )
    r.require(
        isinstance(payload["session_key"], str)
        and hmac.compare_digest(payload["session_key"], session_key),
        "IDENTITY_RECOVERED_APPLICATION_KEY_CHANGED",
    )
    r.require(
        isinstance(payload["manifest"], list)
        and 17 <= len(payload["manifest"]) <= 200
        and all(
            isinstance(row, dict)
            and set(row) == {"table", "count", "hash"}
            and re.fullmatch(r"[a-z][a-z0-9_]{0,62}", row["table"])
            and type(row["count"]) is int
            and row["count"] >= 0
            and re.fullmatch(r"[a-f0-9]{32}", row["hash"])
            for row in payload["manifest"]
        )
        and len({row["table"] for row in payload["manifest"]})
        == len(payload["manifest"]),
        "IDENTITY_BACKUP_MANIFEST_REQUIRED",
    )
    r.require(
        isinstance(payload["objects"], list)
        and len(payload["objects"]) == backup["object_count"] <= 1000,
        "IDENTITY_BACKUP_OBJECT_COUNT",
    )
    total = len(dump)
    seen = set()
    for item in payload["objects"]:
        r.require(
            isinstance(item, dict)
            and re.fullmatch(
                r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", item["storage_key"]
            )
            and item["storage_key"] not in seen,
            "IDENTITY_BACKUP_OBJECT_IDENTITY",
        )
        seen.add(item["storage_key"])
        raw = base64.b64decode(item["bytes"], validate=True)
        r.require(
            type(item["size"]) is int
            and len(raw) == item["size"]
            and hashlib.sha256(raw).hexdigest() == item["sha256"],
            "IDENTITY_BACKUP_OBJECT_INTEGRITY",
        )
        total += len(raw)
    r.require(
        total < 64 * 1024 * 1024
        and payload["checks"]
        == {
            "key_recovered_from_off_instance_escrow": True,
            "original_private_key_file_not_used": True,
            "ciphertext_integrity_verified": True,
            "tampered_archive_rejected": True,
            "object_count": len(seen),
        },
        "IDENTITY_REAL_ESCROW_AND_ARCHIVE_RECOVERY_REQUIRED",
    )
    return dump


def sql(container, database, text):
    return r.docker(
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-XqAt",
        "-v",
        "ON_ERROR_STOP=1",
        data=text.encode(),
        timeout=120,
    )


def wait_for_restore(container, database):
    """Wait past the postgres image's temporary initialization server."""
    deadline = time.monotonic() + 60
    while True:
        logs = subprocess.run(
            ["/usr/bin/docker", "logs", container],
            capture_output=True,
            timeout=5,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        r.require(
            logs.returncode == 0
            and len(logs.stdout) + len(logs.stderr) <= 2 * 1024 * 1024,
            "IDENTITY_RESTORE_STARTUP_OBSERVATION_FAILED",
        )
        initialized = b"PostgreSQL init process complete" in logs.stdout
        if (
            initialized
            and subprocess.run(
                [
                    "/usr/bin/docker",
                    "exec",
                    container,
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "postgres",
                    "-d",
                    database,
                ],
                capture_output=True,
                timeout=5,
                check=False,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            ).returncode
            == 0
        ):
            return
        r.require(time.monotonic() < deadline, "IDENTITY_RESTORE_STARTUP_FAILED")
        time.sleep(0.5)


def fallback_observe(binding, operation, restore_name, container, database, ledger):
    """Run the candidate API and worker against quarantined restored data.

    The candidate shares only the restore container's empty network namespace.
    The restore, synthetic account data, and limited database role are disposable.
    No real account, provider, storage mount, or network is made available.
    """
    identity.common.identifier(operation)
    r.require(
        restore_name == "onesa-isolated-portal-restore-" + operation.replace("-", "")
        and database == "onesa_identity_restore"
        and re.fullmatch(r"[a-f0-9]{64}", container)
        and re.fullmatch(r"sha256:[a-f0-9]{64}", binding["artifact_digest"])
        and re.fullmatch(r"[a-f0-9]{40}", binding["candidate_commit"]),
        "IDENTITY_FALLBACK_OPERATION_SCOPE",
    )
    inspection = json.loads(r.docker("inspect", container))
    r.require(
        restore_replay.isolated_target(restore_name, database, inspection, ledger)
        == container,
        "IDENTITY_FALLBACK_RESTORE_ISOLATION",
    )
    role = "onesa_fallback_probe"
    r.require(
        sql(
            container,
            database,
            "SELECT count(*) FROM pg_roles WHERE rolname='" + role + "';",
        ).strip()
        == b"0",
        "IDENTITY_FALLBACK_ROLE_EXISTS",
    )
    sql(
        container,
        database,
        r"""
CREATE ROLE onesa_fallback_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO onesa_fallback_probe;
SELECT format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO onesa_fallback_probe;',tablename)
  FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'
\gexec
GRANT SELECT ON public.schema_migrations, public.published_content TO onesa_fallback_probe;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO onesa_fallback_probe;
""",
    )
    name = "onesa-isolated-portal-fallback-" + operation.replace("-", "")
    r.require(
        subprocess.run(
            ["/usr/bin/docker", "container", "inspect", name],
            capture_output=True,
            check=False,
            timeout=20,
        ).returncode
        != 0,
        "IDENTITY_FALLBACK_NAMESPACE_EXISTS",
    )
    probe = None
    checks = None
    try:
        probe = (
            r.docker(
                "create",
                "-i",
                "--name",
                name,
                "--pull=never",
                "--network",
                "container:" + container,
                "--read-only",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,noexec,size=64m",
                "--memory",
                "768m",
                "--cpus",
                "0.5",
                "--pids-limit",
                "64",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--label",
                "org.onesa.restore-scope=isolated-fallback",
                "--label",
                "org.onesa.restore-operation=" + operation,
                "--env",
                "NODE_ENV=production",
                "--env",
                "DATABASE_URL=postgresql://" + role + "@127.0.0.1:5432/" + database,
                "--env",
                "PUBLIC_ORIGIN=https://fallback.example.invalid",
                "--env",
                "SESSION_KEY=" + secrets.token_hex(32),
                "--env",
                "PROXY_SHARED_KEY=" + secrets.token_hex(32),
                "--env",
                "S3_BUCKET=synthetic-offline-fallback",
                "--env",
                "ONESA_IDENTITY_ENABLED=false",
                "--entrypoint",
                "node",
                binding["artifact_digest"],
                "--input-type=module",
                "-",
                timeout=60,
            )
            .decode()
            .strip()
        )
        r.require(
            re.fullmatch(r"[a-f0-9]{64}", probe), "IDENTITY_FALLBACK_CONTAINER_IDENTITY"
        )
        item = json.loads(r.docker("inspect", probe))[0]
        labels = item["Config"].get("Labels") or {}
        r.require(
            item["Id"] == probe
            and item["Name"] == "/" + name
            and item["Image"] == binding["artifact_digest"]
            and item["HostConfig"]["NetworkMode"] == "container:" + container
            and item["HostConfig"]["ReadonlyRootfs"] is True
            and not item["HostConfig"].get("PortBindings")
            and all(m.get("Type") == "tmpfs" for m in item.get("Mounts", []))
            and labels.get("org.onesa.restore-scope") == "isolated-fallback"
            and labels.get("org.onesa.restore-operation") == operation,
            "IDENTITY_FALLBACK_CONTAINER_SCOPE",
        )
        checks = json.loads(
            r.docker(
                "start",
                "--attach",
                "--interactive",
                probe,
                data=FALLBACK_PROGRAM.encode(),
                timeout=120,
            )
        )
        expected = {
            key: True
            for key in [
                "representative_member_present",
                "account_serialization",
                "native_authentication",
                "api_behavior",
                "worker_behavior",
            ]
        }
        r.require(checks == expected, "IDENTITY_FALLBACK_APPLICATION_CHECKS")
    finally:
        if probe:
            item = json.loads(r.docker("inspect", probe))[0]
            labels = item["Config"].get("Labels") or {}
            r.require(
                item["Id"] == probe
                and item["Name"] == "/" + name
                and labels.get("org.onesa.restore-scope") == "isolated-fallback"
                and labels.get("org.onesa.restore-operation") == operation,
                "IDENTITY_FALLBACK_CLEANUP_OWNERSHIP",
            )
            r.docker("rm", "-f", probe)
            verify_container_removed(probe)
    return {
        "image": binding["artifact_digest"],
        "source_commit": binding["candidate_commit"],
        "identity_enabled": False,
        **checks,
        "operation_resources_removed": True,
    }


def observe(binding, plan, operation, target):
    value, tool = validate(plan)
    backup = backup_current()
    legacy = plan["legacy_backup"]
    r.require(
        legacy["transport_image"] == tool["transport_image"]
        and legacy["transport_env"] == "/etc/onesa/portal-production.env"
        and legacy["transport_runtime_sha256"]
        == r.sha(r.private(Path(legacy["transport_env"]))),
        "IDENTITY_EXISTING_BACKUP_CUSTODY_REQUIRED",
    )
    target.mkdir(mode=0o700)
    r.write(
        target / "intent.json",
        {
            "binding": binding,
            "operation_id": operation,
            "backup_ciphertext_sha256": backup["ciphertext_sha256"],
            "automatic_retry": False,
            "production_restore": False,
        },
    )
    readback = r.inspect_database_backup(backup, plan)
    custody = json.loads(identity.private_bytes(value["recovery_file"]))
    identity.exact(custody, ["master"], "IDENTITY_EXISTING_OWNER_RECOVERY_CUSTODY")
    r.require(
        len(base64.b64decode(custody["master"], validate=True)) == 32,
        "IDENTITY_RECOVERY_KEY_FORMAT",
    )
    runtime = r.runtime_values(Path(legacy["transport_env"]))
    request = {
        key: backup[key] for key in ["object_key", "key_id", "ciphertext_sha256"]
    }
    request.update(
        master=custody["master"],
        endpoint=runtime["S3_ENDPOINT"],
        region=runtime["S3_REGION"],
        bucket=runtime["S3_BUCKET"],
        access=runtime["AWS_ACCESS_KEY_ID"],
        secret=runtime["AWS_SECRET_ACCESS_KEY"],
    )
    program = Path(__file__).with_name("oracle_backup_open.mjs").read_text()
    payload = json.loads(
        private_capture(
            [
                "/usr/bin/docker",
                "run",
                "--rm",
                "-i",
                "--pull=never",
                "--read-only",
                "--memory",
                "512m",
                "--cpus",
                "0.1",
                "--pids-limit",
                "32",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--entrypoint",
                "node",
                tool["transport_image"],
                "--input-type=module",
                "-e",
                program,
            ],
            r.canonical(request),
        )
    )
    dump = payload_valid(payload, backup, runtime["SESSION_KEY"])
    identity.private_bytes(value["ledger_file"])
    ledger, ledger_sha = restore_replay.ledger(value["ledger_file"]["path"])
    r.require(
        ledger_sha == value["ledger_file"]["sha256"]
        and ledger["source_backup_sha256"] == backup["dump_sha256"]
        and dt.timedelta()
        <= r.now() - dt.datetime.fromisoformat(ledger["reconciled_through"])
        < dt.timedelta(hours=1),
        "IDENTITY_REVIEWED_REPLAY_LEDGER_REQUIRED",
    )
    image = json.loads(r.docker("image", "inspect", tool["postgres_image"]))[0]
    r.require(
        image["Id"] == tool["postgres_image"]
        and image["Os"] == "linux"
        and image["Architecture"] == "arm64",
        "IDENTITY_PINNED_RESTORE_IMAGE_REQUIRED",
    )
    ids = r.docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "id",
        image["Id"],
        "postgres",
    ).decode()
    uid = re.search(r"uid=(\d+)\(postgres\)", ids)
    gid = re.search(r"gid=(\d+)\(", ids)
    r.require(uid and gid, "IDENTITY_RESTORE_IMAGE_USER_REQUIRED")
    name = "onesa-isolated-portal-restore-" + operation.replace("-", "")
    database = "onesa_identity_restore"
    r.require(
        subprocess.run(
            ["/usr/bin/docker", "container", "inspect", name],
            capture_output=True,
            check=False,
            timeout=20,
        ).returncode
        != 0,
        "IDENTITY_RESTORE_NAMESPACE_EXISTS",
    )
    mount = ":uid=" + uid[1] + ",gid=" + gid[1] + ",mode=0700,size=512m"
    container = None
    try:
        raw = r.docker(
            "run",
            "-d",
            "--name",
            name,
            "--pull=never",
            "--network",
            "none",
            "--read-only",
            "--user",
            uid[1] + ":" + gid[1],
            "--memory",
            "768m",
            "--cpus",
            "0.2",
            "--pids-limit",
            "64",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--tmpfs",
            "/var/lib/postgresql" + mount,
            "--tmpfs",
            "/var/run/postgresql" + mount,
            "--tmpfs",
            "/tmp" + mount,
            "--env",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "--env",
            "POSTGRES_DB=" + database,
            "--env",
            "PGDATA=/var/lib/postgresql/data",
            "--label",
            "org.onesa.restore-scope=isolated",
            "--label",
            "org.onesa.product=portal",
            "--label",
            "org.onesa.restore-snapshot-sha256=" + backup["dump_sha256"],
            image["Id"],
            "-c",
            "shared_buffers=16MB",
            "-c",
            "max_connections=10",
            "-c",
            "max_worker_processes=2",
        )
        container = raw.decode().strip()
        r.require(
            re.fullmatch(r"[a-f0-9]{64}", container),
            "IDENTITY_RESTORE_CONTAINER_IDENTITY",
        )
        inspection = json.loads(r.docker("inspect", container))
        r.require(
            restore_replay.isolated_target(name, database, inspection, ledger)
            == container,
            "IDENTITY_RESTORE_ISOLATION",
        )
        wait_for_restore(container, database)
        r.docker(
            "exec",
            "-i",
            container,
            "pg_restore",
            "--no-owner",
            "--no-acl",
            "--exit-on-error",
            "-U",
            "postgres",
            "-d",
            database,
            data=dump,
            timeout=180,
        )
        manifest = [
            json.loads(line)
            for line in sql(container, database, MANIFEST_SQL).decode().splitlines()
        ]
        r.require(manifest == payload["manifest"], "IDENTITY_RESTORED_DATA_DIFFERS")
        rows = json.loads(
            sql(
                container,
                database,
                "SELECT json_agg(x ORDER BY name) FROM (SELECT name,checksum FROM schema_migrations) x;",
            ).decode()
        )
        source = ROOT_SOURCE(binding)
        _, files = r.source_inventory(source, binding)
        identity.identity_source_files(files)
        migration_names = sorted(
            name for name in files if name.startswith(identity.PREFIX + "migrations/")
        )
        r.require(
            len(rows) in {12, 14, 15, 16}
            and {row["name"]: row["checksum"] for row in rows}
            == {Path(name).name: files[name] for name in migration_names[: len(rows)]},
            "IDENTITY_RESTORE_MIGRATION_BASELINE",
        )
        if len(rows) < 16:
            transaction = "BEGIN;\nSELECT pg_advisory_xact_lock(757830);\n"
            for migration_name, checksum in identity.MIGRATIONS.items():
                if int(migration_name[:3]) <= len(rows):
                    continue
                raw = r.docker(
                    "run",
                    "--rm",
                    "--pull=never",
                    "--network",
                    "none",
                    "--read-only",
                    "--entrypoint",
                    "cat",
                    binding["artifact_digest"],
                    "/app/migrations/" + migration_name,
                )
                r.require(
                    hashlib.sha256(raw).hexdigest() == checksum,
                    "IDENTITY_RESTORE_MIGRATION_BYTES_CHANGED",
                )
                transaction += (
                    raw.decode()
                    + "\nINSERT INTO schema_migrations(name,checksum) VALUES('"
                    + migration_name
                    + "','"
                    + checksum
                    + "');\n"
                )
            sql(container, database, transaction + "COMMIT;\n")
        r.require(
            sql(container, database, "SELECT count(*) FROM schema_migrations;").strip()
            == b"16",
            "IDENTITY_RESTORED_SCHEMA_NOT_016",
        )
        lockdown = sql(
            container, database, restore_replay.replay_sql(ledger, restore_lockdown.SQL)
        )
        r.require(
            lockdown.strip() == b"ERASURE_REPLAY_AND_CAPABILITY_LOCKDOWN_PASS",
            "IDENTITY_RESTORED_CAPABILITIES_NOT_LOCKED",
        )
        fallback = fallback_observe(
            binding, operation, name, container, database, ledger
        )
        proof = {
            "state": "ISOLATED_IDENTITY_RESTORE_OBSERVED_NOT_AUTHORIZATION",
            "source_commit": binding["candidate_commit"],
            "operation_id": operation,
            "backup_ciphertext_sha256": backup["ciphertext_sha256"],
            "backup_dump_sha256": backup["dump_sha256"],
            "ledger_sha256": ledger_sha,
            "database_contents_match": True,
            "database_tables_restored": len(manifest),
            "objects_verified": len(payload["objects"]),
            "schema_016_rehearsed": True,
            "capability_lockdown": True,
            "compatible_fallback": fallback,
            "off_instance_readback": readback,
            "network": "none",
            "host_data_mounts": False,
            "production_data_written": False,
            "activation_authorized": False,
            "observed_at": r.now().isoformat(),
        }
    finally:
        if container:
            inspection = json.loads(r.docker("inspect", container))
            r.require(
                restore_replay.isolated_target(name, database, inspection, ledger)
                == container,
                "IDENTITY_RESTORE_CLEANUP_OWNERSHIP",
            )
            r.docker("rm", "-f", container)
            verify_container_removed(container)
    proof["isolated_container_removed"] = True
    r.write(target / "receipt.json", proof)
    return proof


def ROOT_SOURCE(binding):
    return identity.ROOT / "artifacts" / binding["source_tree"] / "source.tar"
