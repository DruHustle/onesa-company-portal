"""Qualified operations installation and recovery, separate from worker cutover."""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import uuid

import oracle_production as production

worker = production.worker
PRIVATE = worker.PRIVATE
PATHS = [
    "infra/oracle/operations",
    "scripts/oracle_backup_store.mjs",
    "scripts/oracle_metrics.mjs",
]


def run(command, data=None, timeout=240):
    return production.run(command, data=data, timeout=timeout)


def node(source, input):
    r = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        input=input,
        capture_output=True,
        timeout=30,
        check=False,
    )
    worker.require(r.returncode == 0, "Private recovery cryptography failed")
    return r.stdout


def public_key():
    key = PRIVATE / "production-recovery-private.pem"
    if not key.exists():
        pair = json.loads(
            node(
                "import crypto from 'node:crypto';const x=crypto.generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});process.stdout.write(JSON.stringify(x));",
                b"",
            )
        )
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(pair["privateKey"])
    worker.require(
        not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
        "Private key ownership required",
    )
    return node(
        "import crypto from 'node:crypto';import fs from 'node:fs';const k=fs.readFileSync(0);process.stdout.write(crypto.createPublicKey(k).export({type:'spki',format:'pem'}));",
        key.read_bytes(),
    )


def seal_key():
    master = PRIVATE / "production-backup-encryption.key"
    worker.require(
        master.is_file()
        and not master.is_symlink()
        and master.stat().st_mode & 0o077 == 0
        and len(master.read_bytes()) == 32,
        "Existing owner-held recovery master required",
    )
    source = "import fs from 'node:fs';import crypto from 'node:crypto';const x=JSON.parse(fs.readFileSync(0,'utf8')),key=Buffer.from(x.key,'base64'),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(Buffer.from(x.private,'base64')),c.final()]);process.stdout.write(Buffer.concat([iv,c.getAuthTag(),b]));"
    return node(
        source,
        json.dumps(
            {
                "key": base64.b64encode(master.read_bytes()).decode(),
                "private": base64.b64encode(
                    (PRIVATE / "production-recovery-private.pem").read_bytes()
                ).decode(),
            }
        ).encode(),
    )


def transport(sha, payload):
    command = production.container(sha).replace(
        " --input-type=module", " /app/backup.mjs"
    )
    command = command.replace(
        " --entrypoint node",
        " -v /etc/onesa/recovery-public.pem:/recovery/public.pem:ro -v /opt/onesa/portal-operations/current/scripts/oracle_backup_store.mjs:/app/backup.mjs:ro --entrypoint node",
    )
    return run(command, json.dumps(payload).encode())


def recovery_fixture(runtime, identifier, cleanup=False):
    worker.require(
        str(uuid.UUID(identifier)) == identifier, "Run-owned recovery UUID required"
    )
    program = (
        "import {db} from './dist/src/services/db.js';import {store,remove} from './dist/src/services/storage.js';import {createHash} from 'node:crypto';const id="
        + json.dumps(identifier)
        + ";try{"
    )
    if cleanup:
        program += "await db.query(\"DELETE FROM files WHERE id=$1 AND storage_key=$2 AND title='Disposable synthetic backup recovery'\",[id,id]);await db.query('DELETE FROM audit WHERE record_id=$1',[id]);await remove(id);"
    else:
        program += "const n=(await db.query('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM files)+(SELECT count(*) FROM applications)+(SELECT count(*) FROM enquiries)+(SELECT count(*) FROM jobs) AS n')).rows[0];if(Number(n.n)!==0)throw Error('Empty production synthetic qualification scope required');const bytes=Buffer.from('%PDF-1.7\\nOnesa synthetic object recovery qualification\\n%%EOF');await store(id,bytes);try{await db.query(\"INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,title) VALUES($1,'synthetic-backup.pdf','application/pdf',$2,$3,$4,'internal','Disposable synthetic backup recovery')\",[id,bytes.length,id,createHash('sha256').update(bytes).digest('hex')]);}catch(e){await remove(id);throw e;}"
    program += "console.log(JSON.stringify({passed:true}));}finally{await db.end();}"
    result = json.loads(run(production.container(runtime), program.encode()))
    worker.require(result.get("passed"), "Synthetic recovery fixture failed")


def install(sha):
    refs = worker.qualified_source(sha, worker.evidence.GitHub())
    runtime = json.loads((PRIVATE / "deployment.json").read_text())["commit"]
    for folder in ["onesa-company-portal-backend", "infra/oracle/clamav"]:
        trees = [
            subprocess.check_output(
                ["git", "rev-parse", c + ":" + folder], cwd=worker.ROOT
            ).strip()
            for c in [sha, runtime]
        ]
        worker.require(
            trees[0] == trees[1], "Qualified runtime tree changed; build and scan first"
        )
    raw = subprocess.check_output(
        ["git", "archive", "--format=tar.gz", sha, "--", *PATHS], cwd=worker.ROOT
    )
    release = "/opt/onesa/portal-operations/releases/" + sha
    run("sudo install -d -m 700 " + release)
    run("sudo tar --no-same-owner -xzf - -C " + release, raw)
    pub = public_key()
    key_id = hashlib.sha256(pub).hexdigest()
    run(
        "sudo sh -c 'umask 022; cat > /etc/onesa/recovery-public.pem; chmod 0444 /etc/onesa/recovery-public.pem'",
        pub,
    )
    run("sudo ln -sfn " + release + " /opt/onesa/portal-operations/current")
    config = {
        "source_commit": sha,
        "image": "onesa-portal-worker:" + runtime,
        "worker_required": False,
        "backup_frequency_seconds": 3600,
        "backup_retention_days": 7,
        "archive_size_limit_bytes": 64 * 1024 * 1024,
        "recovery_key_id": key_id,
        "notification_cooldown_seconds": 1800,
    }
    run(
        "sudo sh -c 'umask 077; cat > /etc/onesa/operations.json'",
        json.dumps(config).encode(),
    )
    escrow = json.loads(
        transport(
            runtime,
            {
                "action": "escrow",
                "key_id": key_id,
                "ciphertext": base64.b64encode(seal_key()).decode(),
            },
        )
    )
    run(
        "sudo install -m 644 "
        + release
        + "/infra/oracle/operations/*.service "
        + release
        + "/infra/oracle/operations/*.timer /etc/systemd/system/\nsudo systemctl daemon-reload\nsudo systemd-analyze verify /etc/systemd/system/onesa-portal-backup.service /etc/systemd/system/onesa-portal-backup.timer /etc/systemd/system/onesa-portal-monitor.service /etc/systemd/system/onesa-portal-monitor.timer"
    )
    # Run before enabling either timer. A failed backup must not be labelled operational.
    fixture = str(uuid.uuid4())
    recovery_fixture(runtime, fixture)
    try:
        run("sudo systemctl start onesa-portal-backup.service", timeout=300)
        success = json.loads(
            run("sudo cat /var/lib/onesa/operations/backup-success.json")
        )
        worker.require(
            success.get("object_count") == 1,
            "Actual associated synthetic object backup required",
        )
    finally:
        recovery_fixture(runtime, fixture, cleanup=True)
    worker.require(
        success.get("passed") is True, "Actual encrypted scheduled backup must succeed"
    )
    run(
        "sudo systemctl start onesa-portal-monitor.service\nsudo systemctl enable --now onesa-portal-backup.timer onesa-portal-monitor.timer"
    )
    timer = run(
        "sudo systemctl show onesa-portal-backup.timer onesa-portal-monitor.timer -p ActiveState -p NextElapseUSecRealtime -p LastTriggerUSec"
    ).decode()
    record = {
        "source_commit": sha,
        "runtime_commit": runtime,
        "source_checks": refs,
        "escrow": escrow,
        "backup": success,
        "timer_readback": timer,
        "worker_processing_activated": False,
        "restore_independent_of_vm_verified": False,
        "synthetic_object_backup_verified": True,
        "synthetic_object_and_database_fixture_removed": True,
    }
    save("production-operations-installation.json", record)
    return {
        "operations_installed": True,
        "backup_execution_verified": True,
        "source_commit": sha,
        "runtime_commit": runtime,
    }


def save(name, data):
    p = PRIVATE / name
    p.write_text(json.dumps(data, indent=2) + "\n")
    p.chmod(0o600)


def simulate(sha):
    worker.qualified_source(sha, worker.evidence.GitHub())
    installed = json.loads(
        (PRIVATE / "production-operations-installation.json").read_text()
    )
    worker.require(
        installed["source_commit"] == sha,
        "Matching qualified operations source required",
    )
    run(
        "sudo python3 /opt/onesa/portal-operations/current/infra/oracle/operations/monitor.py --simulate"
    )
    result = json.loads(run("sudo cat /var/lib/onesa/operations/simulation.json"))
    save("production-monitoring-simulation.json", result)
    return {
        "simulation_rules": result["alerts"],
        "provider_accepted": result["notification"]["provider_accepted"],
        "provider_receipt_id": result["notification"]["provider_receipt_id"],
        "delivery_verified": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "simulate"])
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                install(args.commit)
                if args.action == "install"
                else simulate(args.commit)
            )
        )
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        raise SystemExit(
            "Operations execution failed; private inspection required, no PASS recorded"
        ) from None
