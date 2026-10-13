"""Production preparation and bounded synthetic qualification, never release approval.

Reuse the existing private scanner. Do not start an unrestricted production worker
or transfer staging secrets. Real-data processing requires the normal release gate.
"""

import argparse
import json
import os
import shlex
import subprocess
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import oracle_worker as worker

API = "srv-db4j1igm7kps73c13s4g"
STAGING_API = "srv-db5k5had0e5s73fos4g0"
LEGACY_WORKER = "srv-db4jar7avr4c73ffcvpg"
DATABASE_HOST = "ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech"
BUCKET_HOST = "br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech"
ENV_FILE = "/etc/onesa/portal-production.env"
SOCKET_VOLUME = "onesa-portal-oracle-staging_scanner_socket"
NAMES = {
    "DATABASE_URL",
    "PUBLIC_ORIGIN",
    "SESSION_KEY",
    "PROXY_SHARED_KEY",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "MAIL_PROVIDER",
    "RESEND_API_KEY",
    "MAIL_FROM",
    "MAIL_REPLY_TO",
    "NOTIFY_EMAIL",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "COMPANY_ORIGIN",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def provider(path):
    token = os.environ.get("RENDER_API_KEY", "")
    worker.require(bool(token), "Private owner Render access required")
    request = urllib.request.Request(
        "https://api.render.com/v1/" + path,
        headers={"Authorization": "Bearer " + token},
    )
    with urllib.request.build_opener(NoRedirect()).open(
        request, timeout=30
    ) as response:
        return json.load(response)


def inventory(entries):
    worker.require(
        isinstance(entries, list) and len(entries) < 100,
        "Complete private environment inventory required",
    )
    result = {}
    for entry in entries:
        item = entry["envVar"]
        worker.require(
            item["key"] not in result and isinstance(item["value"], str),
            "Duplicate or invalid environment configuration",
        )
        result[item["key"]] = item["value"]
    return result


def production_values(service, values, staging):
    worker.require(
        service.get("id") == API
        and service.get("branch") == "main"
        and service.get("repo", "").removesuffix(".git")
        == "https://github.com/DruHustle/onesa-company-portal"
        and service.get("autoDeployTrigger") == "off",
        "Existing production Portal target with auto-deploy off required",
    )
    database = urlsplit(values.get("DATABASE_URL", ""))
    bucket = urlsplit(values.get("S3_ENDPOINT", ""))
    origin = urlsplit(values.get("PUBLIC_ORIGIN", ""))
    worker.require(
        database.hostname == DATABASE_HOST
        and database.path == "/neondb"
        and database.username == "onesa_portal_app"
        and bool(database.password),
        "Verified restricted production database binding required",
    )
    tls = parse_qs(database.query)
    worker.require(
        tls.get("sslmode") == ["verify-full"]
        and tls.get("channel_binding") == ["require"],
        "Certificate-verified production database TLS required",
    )
    worker.require(
        bucket.scheme == "https"
        and bucket.hostname == BUCKET_HOST
        and bool(values.get("S3_BUCKET")),
        "Existing private production bucket required",
    )
    worker.require(
        origin.scheme == "https"
        and origin.netloc
        and not origin.path
        and not origin.username
        and not origin.query
        and not origin.fragment,
        "Exact production HTTPS origin required",
    )
    for name, minimum in [
        ("SESSION_KEY", 48),
        ("PROXY_SHARED_KEY", 32),
        ("AWS_ACCESS_KEY_ID", 1),
        ("AWS_SECRET_ACCESS_KEY", 1),
    ]:
        worker.require(
            len(values.get(name, "")) >= minimum, "Missing production " + name
        )
        worker.require(
            values[name] != staging.get(name),
            "Staging/production credential collision: " + name,
        )
    worker.require(
        database.hostname != urlsplit(staging.get("DATABASE_URL", "")).hostname
        and bucket.hostname != urlsplit(staging.get("S3_ENDPOINT", "")).hostname,
        "Staging data namespaces must remain separate",
    )
    result = {name: value for name, value in values.items() if name in NAMES and value}
    worker.require(
        not any(
            "\n" in value or "\r" in value or "\x00" in value
            for value in result.values()
        ),
        "Unsafe multiline runtime value",
    )
    return result


def legacy_mail_profile(service, values, staging):
    worker.require(
        service.get("id") == LEGACY_WORKER
        and service.get("branch") == "main"
        and service.get("repo", "").removesuffix(".git")
        == "https://github.com/DruHustle/onesa-company-portal"
        and service.get("autoDeployTrigger") == "off",
        "Existing production worker identity required before mail reuse",
    )
    worker.require(
        values.get("MAIL_PROVIDER") == "resend"
        and values.get("RESEND_API_KEY", "").startswith("re_")
        and len(values.get("RESEND_API_KEY", "")) >= 25
        and bool(values.get("MAIL_FROM")),
        "Configured existing production Resend profile required",
    )
    worker.require(
        values["RESEND_API_KEY"] != staging.get("RESEND_API_KEY"),
        "Staging mail credential reuse refused",
    )
    return {
        name: values[name]
        for name in ["MAIL_PROVIDER", "RESEND_API_KEY", "MAIL_FROM", "MAIL_REPLY_TO"]
        if values.get(name)
    }


def run(command, *, data=None, timeout=90):
    result = subprocess.run(
        worker.ssh() + [command],
        input=data,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    worker.require(
        result.returncode == 0,
        "Oracle production operation failed; provider bodies and credentials redacted",
    )
    return result.stdout


def container(sha):
    # No service loop is started. A separate process reads only the production file.
    return (
        "sudo docker run --rm -i --read-only --tmpfs /tmp --cap-drop ALL "
        "--security-opt no-new-privileges --pids-limit 128 --memory 512m --cpus 0.1 "
        "--group-add 3000 --env-file "
        + ENV_FILE
        + " -e NODE_ENV=production -e PUBLISH_ENABLED=false "
        "-e CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock "
        "-v " + SOCKET_VOLUME + ":/run/onesa-scanner:ro "
        "--entrypoint node onesa-portal-worker:" + sha + " --input-type=module"
    )


INSPECT = r"""
import {db} from './dist/src/services/db.js';
import {databaseReady} from './dist/src/services/database-readiness.js';
import {S3Client,HeadBucketCommand} from '@aws-sdk/client-s3';
import {env} from './dist/src/config/env.js';
try{
 if(new URL(env.DATABASE_URL).hostname!=='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech'||new URL(env.S3_ENDPOINT).hostname!=='br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech')throw Error('Target');
 await databaseReady(db,true);
 const counts=(await db.query("SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM files) AS files,(SELECT count(*)::int FROM applications) AS applications,(SELECT count(*)::int FROM enquiries) AS enquiries,(SELECT count(*)::int FROM jobs WHERE status IN ('pending','running')) AS pending_jobs,(SELECT count(*)::int FROM storage_deletions WHERE status IN ('pending','running')) AS pending_deletions")).rows[0];
 const s3=new S3Client({region:env.S3_REGION,endpoint:env.S3_ENDPOINT,forcePathStyle:true});
 await s3.send(new HeadBucketCommand({Bucket:env.S3_BUCKET}));
 console.log(JSON.stringify({production_schema_and_role_verified:true,production_bucket_authenticated:true,row_counts:counts,document_contents_accessed:false,data_mutated:false}));
}catch{console.log(JSON.stringify({passed:false,reason:'production_database_or_bucket_preflight_failed',document_contents_accessed:false}));process.exitCode=1;}finally{await db.end();}
"""


def prepare(sha, *, github=None, call=provider, reuse_production_mail=False):
    refs = worker.qualified_source(sha, github or worker.evidence.GitHub())
    build = json.loads((worker.PRIVATE / "deployment.json").read_text())
    worker.require(
        build.get("commit") == sha
        and build.get("scope") == "staging"
        and build.get("action") == "prepare",
        "Exact ARM64 image/security preparation required",
    )
    service = call("services/" + API)
    values = inventory(call("services/" + API + "/env-vars?limit=100"))
    staging = inventory(call("services/" + STAGING_API + "/env-vars?limit=100"))
    selected = production_values(service, values, staging)
    previous = dict(selected)
    if reuse_production_mail:
        worker.require(
            not selected.get("SMTP_HOST") and not selected.get("RESEND_API_KEY"),
            "Preserve already configured API mail profile",
        )
        mail = legacy_mail_profile(
            call("services/" + LEGACY_WORKER),
            inventory(call("services/" + LEGACY_WORKER + "/env-vars?limit=100")),
            staging,
        )
        selected = production_values(service, {**values, **mail}, staging)

    # Newlines/dollar expansion are not passed through a shell. Values stay on SSH stdin.
    def encoded(values):
        return (
            "\n".join(name + "=" + value for name, value in sorted(values.items()))
            + "\n"
        )

    data = json.dumps(
        {
            "previous": encoded(previous),
            "selected": encoded(selected),
            "reconcile_mail": reuse_production_mail,
        }
    ).encode()
    install = r"""import os,sys,pathlib
import json,tempfile
x=json.load(sys.stdin);data=x['selected'].encode()
p=pathlib.Path('/etc/onesa/portal-production.env')
assert len(data)<65536 and not p.is_symlink()
parent=p.parent
assert parent.is_dir() and parent.stat().st_uid==0 and parent.stat().st_mode&0o077==0
if p.exists():
 assert p.stat().st_uid==0 and p.stat().st_mode&0o077==0
 old=p.read_bytes()
 if old!=data:
  assert x['reconcile_mail'] is True and old==x['previous'].encode()
  fd,name=tempfile.mkstemp(prefix='.portal-production-',dir=parent)
  try:
   os.fchmod(fd,0o600)
   with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
   os.replace(name,p)
  finally:
   if os.path.exists(name):os.unlink(name)
else:
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
print('production_configuration_installed_without_displaying_values')
"""
    run("sudo python3 -c " + shlex.quote(install), data=data)
    run(
        "sudo docker volume inspect " + SOCKET_VOLUME + " >/dev/null\n"
        "test \"$(sudo docker inspect --format '{{.State.Health.Status}}' "
        'onesa-portal-oracle-staging-scanner-1)" = healthy'
    )
    inspection = json.loads(run(container(sha), data=INSPECT.encode(), timeout=120))
    worker.require(
        inspection.get("production_schema_and_role_verified")
        and inspection.get("production_bucket_authenticated"),
        "Production dependency inspection incomplete",
    )
    record = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "commit": sha,
        "scope": "production-preparation",
        "source_checks": refs,
        "environment_file": ENV_FILE,
        "configured_names": sorted(selected),
        "existing_production_mail_profile_reused": reuse_production_mail,
        "credential_values_disclosed": False,
        "staging_credentials_reused": False,
        "worker_processing_enabled": False,
        "production_release_qualified": False,
        "checks": inspection,
    }
    path = worker.PRIVATE / "production-preparation.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(0o600)
    return record


def qualify(sha, *, github=None):
    refs = worker.qualified_source(sha, github or worker.evidence.GitHub())
    preparation = json.loads(
        (worker.PRIVATE / "production-preparation.json").read_text()
    )
    worker.require(
        preparation.get("commit") == sha
        and preparation.get("scope") == "production-preparation"
        and preparation.get("checks", {}).get("production_bucket_authenticated") is True
        and preparation.get("checks", {}).get("production_schema_and_role_verified")
        is True
        and set(preparation.get("checks", {}).get("row_counts", {}))
        == {
            "users",
            "files",
            "applications",
            "enquiries",
            "pending_jobs",
            "pending_deletions",
        }
        and all(value == 0 for value in preparation["checks"]["row_counts"].values()),
        "Matching empty production namespace inspection required",
    )
    program = (worker.ROOT / "scripts/oracle_production_acceptance.mjs").read_bytes()
    output = run(container(sha), data=program, timeout=180)
    # The worker emits fixed structured event lines; only the final summary is retained.
    checks = json.loads(output.decode().splitlines()[-1])
    worker.require(
        checks.get("passed") is True
        and checks.get("run_owned_records_and_objects_removed") is True,
        "Actual synthetic production worker checks did not all pass",
    )
    import hashlib

    record = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "commit": sha,
        "scope": "bounded-synthetic-production-runtime",
        "source_checks": refs,
        "test_program_sha256": hashlib.sha256(program).hexdigest(),
        "checks": checks,
        "production_release_qualified": False,
        "remaining_operational_checks": [
            "production mail delivery",
            "target backup/restore",
            "target rollback",
            "monitoring and alert delivery",
            "long-running production restart and capacity",
        ],
        "unrestricted_worker_enabled": False,
    }
    path = worker.PRIVATE / "production-synthetic-qualification.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(0o600)
    return record


def recover(sha, *, github=None):
    refs = worker.qualified_source(sha, github or worker.evidence.GitHub())
    qualification = json.loads(
        (worker.PRIVATE / "production-synthetic-qualification.json").read_text()
    )
    worker.require(
        qualification.get("commit") == sha
        and qualification.get("checks", {}).get("passed") is True
        and qualification.get("checks", {}).get("run_owned_records_and_objects_removed")
        is True,
        "Matching successful bounded qualification required before recovery probe",
    )
    name = "onesa-portal-production-qualification-" + uuid.uuid4().hex
    program = (worker.ROOT / "scripts/oracle_production_restart.mjs").read_text()
    # The program is public source; credentials are never interpolated into arguments.
    prefix = container(sha).replace(
        "sudo docker run --rm -i",
        "sudo docker run -d --name "
        + name
        + " --restart unless-stopped --health-cmd 'node dist/src/jobs/health.js'"
        + " --health-interval 5s --health-timeout 15s --health-start-period 5s",
    )
    created = False
    try:
        run("sudo systemctl is-enabled docker.service >/dev/null")
        run(prefix + " -e " + shlex.quote(program))
        created = True

        def healthy():
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status = (
                    run(
                        "sudo docker inspect --format '{{.State.Status}}:{{.State.Health.Status}}' "
                        + name,
                        timeout=20,
                    )
                    .decode()
                    .strip()
                )
                if status == "running:healthy":
                    return
                worker.require(
                    status.startswith("running:"),
                    "Bounded recovery probe stopped before health",
                )
                time.sleep(2)
            raise ValueError("Bounded recovery probe did not become healthy")

        healthy()
        before = (
            run("sudo docker inspect --format '{{.State.StartedAt}}' " + name)
            .decode()
            .strip()
        )
        run("sudo docker restart -t 30 " + name, timeout=45)
        healthy()
        after = (
            run("sudo docker inspect --format '{{.State.StartedAt}}' " + name)
            .decode()
            .strip()
        )
        worker.require(before != after, "Recovery process restart was not observed")
        stats = json.loads(
            run("sudo docker stats --no-stream --format '{{json .}}' " + name)
        )
        record = {
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "commit": sha,
            "scope": "bounded-empty-production-recovery",
            "source_checks": refs,
            "startup_health_passed": True,
            "restart_health_passed": True,
            "docker_boot_start_enabled": True,
            "restart_policy": "unless-stopped",
            "resource_sample": {
                key: stats.get(key)
                for key in ["CPUPerc", "MemUsage", "MemPerc", "PIDs"]
            },
            "production_vm_reboot_performed": False,
            "long_running_capacity_verified": False,
            "unrestricted_worker_enabled": False,
            "production_release_qualified": False,
        }
    finally:
        if created:
            run("sudo docker stop -t 30 " + name, timeout=45)
            state = json.loads(
                run("sudo docker inspect --format '{{json .State}}' " + name)
            )
            run("sudo docker rm " + name)
    worker.require(
        state.get("ExitCode") == 0 and state.get("OOMKilled") is False,
        "Graceful shutdown or memory qualification failed",
    )
    record.update(
        graceful_shutdown_passed=True, oom_killed=False, test_container_removed=True
    )
    path = worker.PRIVATE / "production-recovery-qualification.json"
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(0o600)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--action", choices=["prepare", "qualify", "recover"], default="prepare"
    )
    parser.add_argument("--reuse-production-mail", action="store_true")
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        worker.require(
            not args.reuse_production_mail or args.action == "prepare",
            "Mail reconciliation is a preparation operation",
        )
        if args.action == "prepare":
            record = prepare(
                args.commit, reuse_production_mail=args.reuse_production_mail
            )
        elif args.action == "qualify":
            record = qualify(args.commit)
        else:
            record = recover(args.commit)
        print(json.dumps(record))
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        print(
            json.dumps(
                {
                    "production_preparation_verified": False,
                    "credentials_disclosed": False,
                    "worker_processing_enabled": False,
                }
            )
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
