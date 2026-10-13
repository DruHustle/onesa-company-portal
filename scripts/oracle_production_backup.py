"""Empty-business production recovery rehearsal; no destructive source operations."""

import argparse
import base64
import datetime
import hashlib
import json
import os
import secrets
import select
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import oracle_production as p

require = p.worker.require
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--commit", required=True)
args = parser.parse_args()
SHA = args.commit
IMAGE = (
    "postgres@sha256:89f747171c4b0af0eacf5984550060be79786dbe286eb60cfa691d79d1e8b23f"
)
NODE = shutil.which("node")
require(NODE, "Node runtime required for authenticated backup encryption")
p.worker.qualified_source(SHA, p.worker.evidence.GitHub())
prep = json.loads((p.worker.PRIVATE / "production-preparation.json").read_text())
require(
    prep["commit"] == SHA
    and all(n == 0 for n in prep["checks"]["row_counts"].values()),
    "Private production recovery guard rejected",
)
RUN = uuid.uuid4().hex
client = "onesa-portal-backup-client-" + RUN
restore = "onesa-portal-backup-restore-" + RUN
service = "/etc/onesa/.portal-backup-" + RUN + ".conf"
socket = None
created = []
started = time.monotonic()


def remote(command, data=None, timeout=120):
    r = subprocess.run(
        p.worker.ssh() + [command],
        input=data,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if r.returncode:
        raise ValueError("Private recovery command failed; output redacted")
    return r.stdout


def query(container, sql):
    return remote(
        "sudo docker exec -i "
        + container
        + " psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d portal_restore",
        sql.encode(),
    )


crypto = "import fs from 'node:fs';import crypto from 'node:crypto';\ntry{const x=JSON.parse(fs.readFileSync(0,'utf8')),key=Buffer.from(x.key,'base64'),input=Buffer.from(x.data,'base64');\nif(key.length!==32||input.length>32*1024*1024)throw Error('Bounds');\nif(x.decrypt){const nonce=input.subarray(0,12),tag=input.subarray(12,28),d=crypto.createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(tag);fs.writeFileSync(1,Buffer.concat([d.update(input.subarray(28)),d.final()]));}\nelse{const nonce=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,nonce),body=Buffer.concat([c.update(input),c.final()]);fs.writeFileSync(1,Buffer.concat([nonce,c.getAuthTag(),body]));}}catch{process.exit(1);}"


def crypt(key, data, decrypt=False):
    r = subprocess.run(
        [NODE, "--input-type=module", "-e", crypto],
        input=json.dumps(
            {
                "key": base64.b64encode(key).decode(),
                "data": base64.b64encode(data).decode(),
                "decrypt": decrypt,
            }
        ).encode(),
        capture_output=True,
        check=False,
    )
    if r.returncode:
        raise ValueError("Authenticated backup crypto failed")
    return r.stdout


key_file = p.worker.PRIVATE / "production-backup-encryption.key"
if key_file.exists():
    require(
        not key_file.is_symlink() and key_file.stat().st_mode & 63 == 0,
        "Private production recovery guard rejected",
    )
    key = key_file.read_bytes()
    require(len(key) == 32, "Private production recovery guard rejected")
else:
    key = secrets.token_bytes(32)
    fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 384)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
        f.flush()
        os.fsync(f.fileno())
probe = crypt(key, b"Synthetic authenticated backup crypto check")
require(
    crypt(key, probe, True) == b"Synthetic authenticated backup crypto check",
    "Private production recovery guard rejected",
)
try:
    crypt(key, probe[:-1] + bytes([probe[-1] ^ 1]), True)
except ValueError:
    tamper_denied = True
else:
    raise ValueError("Tampered backup accepted")
try:
    install = "import pathlib,urllib.parse,os,sys\nif sys.flags.optimize:raise RuntimeError(\"Guarded interpreter required\")\npath=sys.argv[1];p=pathlib.Path('/etc/onesa/portal-production.env')\nassert p.stat().st_uid==0 and p.stat().st_mode&0o077==0 and not p.is_symlink()\nvalues=dict(line.split('=',1) for line in p.read_text().splitlines() if '=' in line)\nu=urllib.parse.urlsplit(values['DATABASE_URL']);assert u.hostname=='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech' and u.username=='onesa_portal_app' and u.path=='/neondb'\nassert urllib.parse.parse_qs(u.query).get('sslmode')==['verify-full']\nfields={'host':u.hostname,'port':'5432','user':u.username,'dbname':'neondb','password':urllib.parse.unquote(u.password),'sslmode':'verify-full','sslrootcert':'/etc/ssl/certs/ca-certificates.crt','channel_binding':'require'}\nassert all('\\n' not in v and '\\r' not in v for v in fields.values())\nfd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,'w') as f:f.write('[production]\\n'+'\\n'.join(k+'='+v for k,v in fields.items())+'\\n')\n"
    remote("sudo python3 -c " + shlex.quote(install) + " " + service)
    remote(
        "sudo docker run -d --name "
        + client
        + " --memory 256m --cpus 0.1 --cap-drop ALL --security-opt no-new-privileges -v "
        + service
        + ":/secrets/service.conf:ro -e PGSERVICEFILE=/secrets/service.conf -e PGSERVICE=production --entrypoint sleep "
        + IMAGE
        + " 240"
    )
    created.append(client)
    command = "sudo docker exec -i " + client + " psql -XqAt -v ON_ERROR_STOP=1"
    socket = subprocess.Popen(
        p.worker.ssh() + [command],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    def line():
        require(
            select.select([socket.stdout], [], [], 30)[0], "Snapshot metadata timeout"
        )
        result = socket.stdout.readline().decode().strip()
        require(result, "Private production recovery guard rejected")
        return result

    socket.stdin.write(
        b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT current_setting('server_version_num');\n"
    )
    socket.stdin.flush()
    version = int(line())
    require(140000 <= version < 190000, "Unsupported production PostgreSQL version")
    socket.stdin.write(
        b"SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM files)+(SELECT count(*) FROM applications)+(SELECT count(*) FROM enquiries)+(SELECT count(*) FROM jobs)+(SELECT count(*) FROM storage_deletions);\n"
    )
    socket.stdin.flush()
    require(line() == "0", "Production business records present; no data copied")
    socket.stdin.write(b"SELECT pg_export_snapshot();\n")
    socket.stdin.flush()
    snapshot = line()
    import re

    require(
        re.fullmatch("[A-Fa-f0-9-]{3,100}", snapshot),
        "Private production recovery guard rejected",
    )
    manifest_sql = "SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM public.%I t;',tablename,tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename\n\\gexec\nSELECT 'MANIFEST_END';\n"
    socket.stdin.write(manifest_sql.encode())
    socket.stdin.flush()
    manifest = []
    while True:
        data = line()
        if data == "MANIFEST_END":
            break
        manifest.append(json.loads(data))
    require(
        len(manifest) >= 17
        and any(
            x["table"] == "schema_migrations" and x["count"] == 7 for x in manifest
        ),
        "Private production recovery guard rejected",
    )
    dump = remote(
        "sudo docker exec "
        + client
        + " pg_dump -Fc --no-owner --no-acl --snapshot="
        + snapshot,
        timeout=120,
    )
    require(
        dump.startswith(b"PGDMP") and len(dump) < 32 * 1024 * 1024,
        "Private production recovery guard rejected",
    )
    socket.stdin.write(b"ROLLBACK;\n")
    socket.stdin.close()
    socket.wait(timeout=20)
    require(socket.returncode == 0, "Private production recovery guard rejected")
    encrypted = crypt(key, dump)
    folder = p.worker.PRIVATE / "production-backups"
    folder.mkdir(mode=448, exist_ok=True)
    folder.chmod(448)
    artifact = folder / ("portal-" + RUN + ".dump.aes256gcm")
    artifact.write_bytes(encrypted)
    artifact.chmod(384)
    vm = "/var/lib/onesa/production-backups/portal-" + RUN + ".dump.aes256gcm"
    remote(
        "sudo install -d -m 700 /var/lib/onesa/production-backups\nsudo sh -c "
        + shlex.quote("umask 077; cat > " + vm),
        encrypted,
    )
    remote(
        "sudo docker run -d --name "
        + restore
        + " --network none --user 70:70 --memory 256m --cpus 0.2 --cap-drop ALL --security-opt no-new-privileges --tmpfs /var/lib/postgresql:uid=70,gid=70,mode=0700,size=128m --tmpfs /var/run/postgresql:uid=70,gid=70,mode=0777 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=portal_restore -e PGDATA=/var/lib/postgresql/data "
        + IMAGE
        + " -c shared_buffers=16MB -c max_connections=10 -c max_worker_processes=2"
    )
    created.append(restore)
    deadline = time.monotonic() + 100
    while True:
        r = subprocess.run(
            p.worker.ssh()
            + [
                "sudo docker exec "
                + restore
                + " pg_isready -U postgres -d portal_restore"
            ],
            capture_output=True,
            timeout=20,
            check=False,
        )
        if r.returncode == 0:
            break
        require(time.monotonic() < deadline, "Isolated restore did not start")
        time.sleep(2)
    decrypted = crypt(key, artifact.read_bytes(), True)
    require(
        hashlib.sha256(decrypted).digest() == hashlib.sha256(dump).digest(),
        "Private production recovery guard rejected",
    )
    remote(
        "sudo docker exec -i "
        + restore
        + " pg_restore --no-owner --no-acl --exit-on-error -U postgres -d portal_restore",
        decrypted,
        timeout=90,
    )
    after = query(restore, manifest_sql).decode().splitlines()
    restored = [json.loads(x) for x in after if x != "MANIFEST_END"]
    require(restored == manifest, "Restored table counts/content hashes differ")
    query(
        restore,
        "CREATE ROLE onesa_portal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO onesa_portal_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO onesa_portal_app; REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM onesa_portal_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO onesa_portal_app;",
    )
    test = "import {randomBytes} from 'node:crypto';\nprocess.env.NODE_ENV='production';process.env.DATABASE_URL='postgresql://onesa_portal_app@127.0.0.1:5432/portal_restore';process.env.PUBLIC_ORIGIN='https://synthetic.example.invalid';process.env.SESSION_KEY=randomBytes(32).toString('hex');process.env.PROXY_SHARED_KEY=randomBytes(32).toString('hex');process.env.PUBLISH_ENABLED='false';\nconst {db}=await import('./dist/src/services/db.js');const {databaseReady}=await import('./dist/src/services/database-readiness.js');const {buildApp}=await import('./dist/src/app.js');\ntry{await databaseReady(db,true);const app=await buildApp({logging:false});const response=await app.inject({method:'GET',url:'/api/v1/ready'});await app.close();if(response.statusCode!==200)throw Error('Readiness');await db.query('BEGIN');await db.query(\"INSERT INTO audit(action) VALUES('synthetic.restore.readiness')\");await db.query('ROLLBACK');console.log(JSON.stringify({restored_application_readiness:true,restricted_role_and_sequence_permissions_verified:true}));}catch{console.log(JSON.stringify({restored_application_readiness:false}));process.exitCode=1;}finally{await db.end();}"
    result = remote(
        "sudo docker run --rm -i --network container:"
        + restore
        + " --read-only --tmpfs /tmp --memory 256m --cpus 0.1 --cap-drop ALL --security-opt no-new-privileges --entrypoint node onesa-portal-worker:"
        + SHA
        + " --input-type=module",
        test.encode(),
        timeout=90,
    )
    checks = json.loads(result.decode().splitlines()[-1])
    require(
        checks["restored_application_readiness"],
        "Private production recovery guard rejected",
    )
    record = {
        "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "commit": SHA,
        "production_database_endpoint": p.DATABASE_HOST,
        "postgres_server_version_num": version,
        "client_image": IMAGE,
        "scope": "actual production database with no business records; encrypted consistent snapshot and isolated restoration",
        "database_snapshot_exported": True,
        "database_tables_verified": len(manifest),
        "table_counts_and_contents_match": True,
        "migration_checksums_verified": 7,
        "crypto": "AES-256-GCM",
        "tampered_ciphertext_rejected": tamper_denied,
        "backup_ciphertext_sha256": hashlib.sha256(encrypted).hexdigest(),
        "encrypted_backup_local_path": str(artifact.relative_to(p.worker.ROOT)),
        "encrypted_backup_vm_path": vm,
        "backup_key_kept_on_owner_machine": True,
        "plaintext_dump_written_to_disk": False,
        "production_business_records_accessed": False,
        "production_source_mutated": False,
        "restore_host_public_ports": False,
        "checks": checks,
        "measured_rehearsal_seconds": round(time.monotonic() - started, 3),
        "production_release_qualified": False,
        "object_restore_verified": False,
        "backup_schedule_and_retention_verified": False,
    }
    path = p.worker.PRIVATE / "production-database-recovery.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(384)
    print(json.dumps(record))
finally:
    if socket and socket.poll() is None:
        if socket.stdin and (not socket.stdin.closed):
            socket.stdin.close()
        socket.wait(timeout=20)
    for name in reversed(created):
        remote("sudo docker rm -f " + name)
    remote("sudo rm -f -- " + service)
