"""Authenticated scanner dependency observations; never an authorization issuer."""

import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from uuid import UUID

import oracle_portal as r

NODE_FILES = (
    "oracle_portal_worker_fixture.mjs",
    "oracle_portal_worker_probe.mjs",
    "oracle_portal_worker_smtp.mjs",
    "oracle_portal_scanner_workflows.mjs",
)
TOOL_FILES = (*NODE_FILES, "oracle_portal_scanner_workflow.py")
STAGE = "onesa-portal-oracle-api-staging-1"
PRODUCTION_WORKER = "onesa-portal-production-worker-1"
S3_KEYS = {
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
}


def validate_plan(binding, plan):
    profile = plan["workflow"]
    r.require(
        isinstance(profile, dict)
        and set(profile)
        == {
            "application_binding",
            "fixture_id",
            "expires_at",
            "runtime_sha256",
            "certificate_sha256",
            "private_key_sha256",
            "owner_custody_sha256",
            "application_scan_sha256",
        },
        "SCANNER_WORKFLOW_PLAN_SCHEMA",
    )
    application = profile["application_binding"]
    r.require(
        isinstance(application, dict)
        and set(application) == set(binding)
        and application["component"] == "worker"
        and all(
            application[key] == binding[key]
            for key in [
                "repository",
                "candidate_commit",
                "source_tree",
                "source_sha256",
                "target_environment",
            ]
        ),
        "SCANNER_WORKFLOW_SOURCE_SCOPE",
    )
    r.require(
        re.fullmatch(r"sha256:[a-f0-9]{64}", application["artifact_digest"])
        and application["artifact_digest"] != binding["artifact_digest"]
        and re.fullmatch(r"[a-f0-9]{64}", application["build_sha256"])
        and application["build_sha256"] != binding["build_sha256"],
        "SEPARATE_SCANNER_APPLICATION_ARTIFACTS_REQUIRED",
    )
    r.require(
        set(application["configuration_sha256"]) == {"staging", "production"}
        and all(
            re.fullmatch(r"[a-f0-9]{64}", value)
            for value in application["configuration_sha256"].values()
        ),
        "SCANNER_WORKFLOW_CONFIGURATION_SCOPE",
    )
    for name in [
        "runtime_sha256",
        "certificate_sha256",
        "private_key_sha256",
        "owner_custody_sha256",
        "application_scan_sha256",
    ]:
        r.require(
            isinstance(profile[name], str)
            and re.fullmatch(r"[a-f0-9]{64}", profile[name]),
            "SCANNER_WORKFLOW_FILE_PIN",
        )
    r.require(
        profile["runtime_sha256"] == application["configuration_sha256"]["staging"]
        and str(UUID(profile["fixture_id"])) == profile["fixture_id"],
        "SCANNER_WORKFLOW_FIXTURE_SCOPE",
    )
    # Historical production inspection does not need live fixture credentials.
    expiry = dt.datetime.fromisoformat(profile["expires_at"].replace("Z", "+00:00"))
    r.require(
        profile["expires_at"].endswith("Z") and expiry.utcoffset() == dt.timedelta(),
        "SCANNER_WORKFLOW_EXPIRY_FORMAT",
    )
    return profile


def verify_application(binding, plan, folder):
    profile = validate_plan(binding, plan)
    application = profile["application_binding"]
    source = r.private(folder / "source.tar")
    r.require(
        r.sha(source) == binding["source_sha256"],
        "SCANNER_WORKFLOW_SOURCE_ARCHIVE_CHANGED",
    )
    _, files = r.source_inventory(source, binding)
    tool = r.trusted_toolchain(plan)
    expected = {
        "scripts/release/" + name: files["scripts/release/" + name]
        for name in TOOL_FILES
    }
    r.require(
        tool["workflow_files"] == expected, "SCANNER_WORKFLOW_TOOL_SOURCE_CHANGED"
    )
    for name in TOOL_FILES:
        r.pinned_public_file(
            Path(__file__).with_name(name), expected["scripts/release/" + name]
        )
    build = r.read(folder / "worker-build.json")
    r.require(
        r.sha(folder / "worker-build.json") == application["build_sha256"]
        and all(
            build.get(key) == application[key]
            for key in [
                "repository",
                "component",
                "candidate_commit",
                "source_tree",
                "source_sha256",
                "artifact_digest",
            ]
        )
        and build.get("architecture") == "arm64"
        and build.get("dockerfile_sha256")
        == files["onesa-company-portal-backend/Dockerfile"],
        "SCANNER_WORKFLOW_APPLICATION_BUILD_CHANGED",
    )
    image = json.loads(r.docker("image", "inspect", application["artifact_digest"]))[0]
    labels = image["Config"].get("Labels", {})
    environment = dict(value.split("=", 1) for value in image["Config"]["Env"])
    r.require(
        image["Id"] == application["artifact_digest"]
        and image["Os"] == "linux"
        and image["Architecture"] == "arm64"
        and image["Config"]["User"] == "node"
        and labels.get("org.opencontainers.image.revision")
        == binding["candidate_commit"]
        and labels.get("org.onesa.source-sha256") == binding["source_sha256"],
        "SCANNER_WORKFLOW_ACTUAL_APPLICATION_IDENTITY",
    )
    r.require(
        set(environment)
        <= {
            "PATH",
            "NODE_VERSION",
            "YARN_VERSION",
            "NODE_ENV",
            "PORT",
            "STORAGE_DIR",
            "NODE_OPTIONS",
        }
        and environment["NODE_ENV"] == "production"
        and environment["PORT"] == "8300"
        and environment["STORAGE_DIR"] == "/app/storage"
        and environment.get("NODE_VERSION", "24.22.1") == "24.22.1"
        and environment["NODE_OPTIONS"]
        == "--import=/app/dist/src/security/tls-trust.js",
        "SCANNER_WORKFLOW_APPLICATION_TRUST_CONFIGURATION",
    )
    r.require(
        r.sha(folder / "worker-scan.json") == profile["application_scan_sha256"],
        "SCANNER_WORKFLOW_APPLICATION_SCAN_CHANGED",
    )
    r.image_security(
        r.read(folder / "worker-scan.json"), application["artifact_digest"]
    )
    prefix = "onesa-company-portal-backend/"
    names = [
        name[len(prefix) :]
        for name in files
        if name.startswith(prefix)
        and (
            name[len(prefix) :] in {"package.json", "package-lock.json"}
            or re.fullmatch(r"migrations/[A-Za-z0-9_.-]+\.sql", name[len(prefix) :])
        )
    ]
    r.require(len(names) >= 3, "SCANNER_WORKFLOW_APPLICATION_FILES_REQUIRED")
    actual = r.docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--memory",
        "64m",
        "--cpus",
        "0.1",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "sha256sum",
        application["artifact_digest"],
        *["/app/" + name for name in sorted(names)],
    )
    observed = {}
    for row in actual.decode().splitlines():
        checksum, name = row.split("  ", 1)
        r.require(name not in observed, "SCANNER_WORKFLOW_DUPLICATE_APPLICATION_FILE")
        observed[name] = checksum
    r.require(
        observed == {"/app/" + name: files[prefix + name] for name in names},
        "SCANNER_WORKFLOW_APPLICATION_FILES_CHANGED",
    )
    version = r.docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--memory",
        "64m",
        "--cpus",
        "0.1",
        "--entrypoint",
        "node",
        application["artifact_digest"],
        "--version",
    ).strip()
    r.require(version == b"v24.22.1", "SCANNER_WORKFLOW_NODE_RUNTIME_CHANGED")
    return application


def private_input(binding, plan, folder, context_id, records):
    profile = validate_plan(binding, plan)
    path = folder / "workflow"
    for name, pin in [
        ("runtime.env", "runtime_sha256"),
        ("cert.pem", "certificate_sha256"),
        ("key.pem", "private_key_sha256"),
        ("owner.json", "owner_custody_sha256"),
    ]:
        r.require(
            r.sha(r.private(path / name)) == profile[pin],
            "SCANNER_WORKFLOW_PRIVATE_INPUT_CHANGED",
        )
    owner = r.read(path / "owner.json")
    r.require(
        set(owner)
        == {
            "schema_version",
            "state",
            "candidate_commit",
            "source_tree",
            "artifact_digest",
            "owner_uri",
            "runtime_password",
            "created_at",
            "expires_at",
        }
        and owner["schema_version"] == 1
        and owner["state"] == "STAGING_CUSTODY_NOT_AUTHORIZATION"
        and all(
            owner[key] == binding[key]
            for key in ["candidate_commit", "source_tree", "artifact_digest"]
        )
        and owner["expires_at"] == profile["expires_at"],
        "SCANNER_WORKFLOW_OWNER_CUSTODY_SCOPE",
    )
    expiry = dt.datetime.fromisoformat(owner["expires_at"].replace("Z", "+00:00"))
    created = dt.datetime.fromisoformat(owner["created_at"].replace("Z", "+00:00"))
    r.require(
        created <= r.now() < expiry
        and dt.timedelta(0) < expiry - created <= dt.timedelta(hours=1),
        "SCANNER_WORKFLOW_OWNER_CUSTODY_EXPIRED",
    )
    stage = json.loads(r.docker("inspect", STAGE))[0]
    r.require(
        r.summary(stage) == plan["baseline"][STAGE] and r.healthy(stage),
        "SCANNER_WORKFLOW_STAGING_DEPENDENCY_CHANGED",
    )
    expected = dict(value.split("=", 1) for value in stage["Config"]["Env"])
    runtime = r.runtime_values(path / "runtime.env")
    allowed = S3_KEYS | {
        "NODE_ENV",
        "PUBLISH_ENABLED",
        "SESSION_KEY",
        "PROXY_SHARED_KEY",
        "PUBLIC_ORIGIN",
        "DATABASE_URL",
        "CLAMAV_SOCKET",
        "WORKER_PROFILE",
        "WORKER_IDLE_MAX_MS",
        "MAIL_PROVIDER",
        "SMTP_HOST",
        "SMTP_PORT",
        "MAIL_FROM",
        "NODE_EXTRA_CA_CERTS",
    }
    r.require(
        set(runtime) <= allowed
        and all(
            runtime.get(key) and expected.get(key)
            for key in [
                "S3_ENDPOINT",
                "S3_BUCKET",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
            ]
        ),
        "SCANNER_WORKFLOW_RUNTIME_KEYS_OR_STORAGE_CUSTODY",
    )
    r.require(
        {key: value for key, value in runtime.items() if key in S3_KEYS}
        == {key: value for key, value in expected.items() if key in S3_KEYS},
        "SCANNER_WORKFLOW_PRIVATE_STORAGE_TARGET_CHANGED",
    )
    application = profile["application_binding"]
    r.require(
        r.sha(r.private(Path("/etc/onesa/portal-production.env")))
        == application["configuration_sha256"]["production"],
        "RETAINED_WORKER_CONFIGURATION_CHANGED",
    )
    contexts = [
        record
        for record in records
        if record["kind"] == "context" and record["id"] == context_id
    ]
    r.require(
        len(contexts) == 1 and contexts[0]["binding"] == binding,
        "SCANNER_WORKFLOW_SIGNED_CONTEXT_REQUIRED",
    )
    runs = contexts[0]["details"]["ci"]
    r.require(
        runs
        and all(type(row.get("run_id")) is int and row["run_id"] > 0 for row in runs),
        "SCANNER_WORKFLOW_GENUINE_CI_REQUIRED",
    )
    rollback = plan["baseline"][PRODUCTION_WORKER]
    fixture = {
        "action": "provision",
        "owner_uri": owner["owner_uri"],
        "runtime_password": owner["runtime_password"],
        "source": binding["candidate_commit"],
        "context_id": context_id,
        "fixture_id": profile["fixture_id"],
        "expires_at": profile["expires_at"],
    }
    probe = {
        "binding": application,
        "operation_id": context_id,
        "environment": "staging",
        "ci_run_id": runs[0]["run_id"],
        "fixture_id": profile["fixture_id"],
        "expires_at": profile["expires_at"],
        "runtime_sha256": profile["runtime_sha256"],
        "certificate_sha256": profile["certificate_sha256"],
        "rollback": {
            "source": rollback["source"],
            "artifact_digest": rollback["image"],
        },
    }
    return {"scanner_binding": binding, "fixture": fixture, "worker_probe": probe}


def private_probe(*arguments, data, observations):
    try:
        result = subprocess.run(
            ["/usr/bin/docker", *arguments],
            input=data,
            capture_output=True,
            timeout=300,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired as error:
        r.write_raw(observations / "workflow-command.stdout", error.stdout or b"")
        r.write_raw(observations / "workflow-command.stderr", error.stderr or b"")
        r.write(
            observations / "workflow-command-result.json",
            {
                "state": "INTERRUPTED_INSPECT_OWNED_FIXTURE_ONLY",
                "automatic_retry": False,
            },
        )
        raise r.Refused("SCANNER_WORKFLOW_INTERRUPTED_INSPECT_ONLY") from None
    r.write_raw(observations / "workflow-command.stdout", result.stdout)
    r.write_raw(observations / "workflow-command.stderr", result.stderr)
    r.write(
        observations / "workflow-command-result.json",
        {"returncode": result.returncode, "automatic_retry": False},
    )
    r.require(
        result.returncode == 0 and len(result.stdout) <= 1024 * 1024,
        "SCANNER_WORKFLOW_COMMAND_FAILED_INSPECT_ONLY",
    )
    return result.stdout


def observe(
    binding, plan, folder, context_id, records, network, socket_volume, observations
):
    application = verify_application(binding, plan, folder)
    request = private_input(binding, plan, folder, context_id, records)
    r.require(
        re.fullmatch(r"onesa-sq-[a-f0-9]{16}-candidate_scanner_socket", socket_volume),
        "SCANNER_WORKFLOW_SOCKET_VOLUME_SCOPE",
    )
    for kind, name in [("network", network), ("volume", socket_volume)]:
        row = json.loads(r.docker(kind, "inspect", name))[0]
        r.require(
            row["Labels"].get("org.onesa.scanner-qualification") == context_id,
            "SCANNER_WORKFLOW_OWNED_NAMESPACE_REQUIRED",
        )
    target = observations / "workflow-client"
    target.mkdir(mode=0o700)
    mounts = []
    tool = r.trusted_toolchain(plan)
    for name in NODE_FILES:
        source = r.pinned_public_file(
            Path(__file__).with_name(name),
            tool["workflow_files"]["scripts/release/" + name],
        )
        copy = target / name
        r.write_raw(copy, source.read_bytes())
        copy.chmod(0o444)
        mounts += ["-v", str(copy) + ":/app/release/" + name + ":ro"]
    for name in ["cert.pem", "key.pem", "runtime.env"]:
        source = folder / "workflow" / name
        destination = target / name
        r.write_raw(destination, r.private(source).read_bytes())
        os.chown(destination, 1000, 1000)
        destination.chmod(0o600)
        dest = (
            "/private/runtime.env" if name == "runtime.env" else "/private/tls/" + name
        )
        mounts += ["-v", str(destination) + ":" + dest + ":ro"]
    name = "onesa-scanner-workflows-" + context_id
    r.write(
        observations / "workflow-request-started.json",
        {
            "context_id": context_id,
            "scanner_binding": binding,
            "application_binding": application,
            "fixture_id": plan["workflow"]["fixture_id"],
            "ci_run_id": request["worker_probe"]["ci_run_id"],
            "automatic_retry": False,
            "owner_custody_exported": False,
        },
    )
    try:
        raw = private_probe(
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--label",
            "org.onesa.scanner-qualification=" + context_id,
            "-i",
            "--user",
            "1000:1000",
            "--group-add",
            "3000",
            "--read-only",
            "--network",
            network,
            "--tmpfs",
            "/tmp:rw,mode=700,uid=1000,gid=1000,size=64m",
            "--tmpfs",
            "/private:rw,mode=700,uid=1000,gid=1000,size=8m",
            "--memory",
            "768m",
            "--cpus",
            "0.25",
            "--pids-limit",
            "128",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--env-file",
            str(target / "runtime.env"),
            "-e",
            "NODE_EXTRA_CA_CERTS=/private/tls/cert.pem",
            *mounts,
            "-v",
            socket_volume + ":/run/onesa-scanner:ro",
            "--entrypoint",
            "node",
            application["artifact_digest"],
            "/app/release/oracle_portal_scanner_workflows.mjs",
            data=r.canonical(request),
            observations=observations,
        )
        value = json.loads(raw)
        r.require(
            value["state"] == "SCANNER_DEPENDENCY_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION"
            and value["scanner_binding"] == binding
            and value["application_binding"] == application
            and value["ci_run_id"] == request["worker_probe"]["ci_run_id"]
            and isinstance(value["checks"], dict)
            and len(value["checks"]) == 19
            and all(
                type(passed) is bool and passed for passed in value["checks"].values()
            )
            and value["existing_application_databases_changed"] is False
            and value["global_tick_imported"] is False
            and value["inbox_delivery_verified"] is False
            and type(value["disposable_fixture_migrations"]) is int
            and value["disposable_fixture_migrations"] > 0
            and value["production_schema_migrations"] == 0
            and value["worker_deployed"] is False
            and value["release_records_issued"] == 0,
            "SCANNER_AUTHENTICATED_WORKFLOWS_INCOMPLETE",
        )
        r.write(observations / "authenticated-workflows.json", value)
        return value
    finally:
        result = subprocess.run(
            ["/usr/bin/docker", "inspect", name],
            capture_output=True,
            timeout=15,
            check=False,
        )
        if result.returncode == 0:
            row = json.loads(result.stdout)[0]
            r.require(
                row["Config"]["Labels"].get("org.onesa.scanner-qualification")
                == context_id,
                "SCANNER_WORKFLOW_CLEANUP_OWNERSHIP",
            )
            r.docker("rm", "-f", name, timeout=30)
        # Interrupted observations retain the exact marked fixture identity for
        # inspection/cleanup; the consumed qualification is never restarted.
