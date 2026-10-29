"""Private scanner operations invoked only by the commissioned Oracle verifier.

No caller receipt is authorization. The existing verifier reserves its signed
context/intent before this module runs. Each provider operation is journalled
before execution; production inspection never creates or restarts a container.
The shared scanner has no database, storage, mail or application credentials.
"""

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_portal as r
import oracle_portal_scanner_workflow as workflows

PLAN = Path("/etc/onesa/oracle-portal-scanner-release.json")
ROOT = Path("/var/lib/onesa/release-verification/portal/scanner")
TARGET = "onesa-portal-oracle-staging-scanner-1"
REPOSITORY = "DruHustle/onesa-company-portal"
PREFIX = "infra/oracle/clamav/"
SHIPPED = {
    "clamd.conf": "/etc/clamav/clamd.conf",
    "freshclam.conf": "/etc/clamav/freshclam.conf",
    "start.sh": "/usr/local/bin/onesa-clamav",
    "health.sh": "/usr/local/bin/onesa-scanner-health",
}
STAGING_PROFILE = {
    "memory_bytes": 2560 * 1024**2,
    "nano_cpus": 250000000,
    "pids_limit": 64,
    "published_ports": False,
    "application_credentials": False,
    "application_data": False,
    "signatures": "copy-public-definitions-preserve-mtime",
    "socket": "separate-owned-directory",
}
CHECKS = {
    "staging": {
        "source_build_image_identity",
        "configuration_and_isolation",
        "authentication_and_authorization",
        "persistence",
        "affected_workflows",
        "schema_and_migrations",
        "rollback_readiness",
        "security_and_contracts",
    },
    "operations": {
        "backup_restore",
        "monitoring_and_capacity",
        "privacy_publication_controls",
        "preservation_baseline",
        "rollback_readiness",
    },
    "deploy": {
        "exact_authorized_artifact",
        "configuration_preserved",
        "independent_components_preserved",
        "provider_receipt",
    },
    "production": {
        "source_build_image_identity",
        "health_readiness",
        "authentication_and_authorization",
        "affected_workflows",
        "persistence_preserved",
        "independent_components_preserved",
        "configuration_preserved",
        "no_unapproved_processing_or_actuation",
    },
}


def exact(value, fields, code):
    r.require(isinstance(value, dict) and set(value) == set(fields), code)


def identifier(value):
    r.require(
        isinstance(value, str) and str(UUID(value)) == value, "SCANNER_OPERATION_ID"
    )
    return value


@contextmanager
def component_lock():
    path = ROOT / "component.lock"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        r.private(path)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def profile(row):
    """Only stable configuration; no environment values leave this process."""
    config, host = row["Config"], row["HostConfig"]
    return {
        "host_configuration_sha256": hashlib.sha256(r.canonical(host)).hexdigest(),
        "image_configuration_sha256": hashlib.sha256(
            r.canonical(
                {
                    key: value
                    for key, value in config.items()
                    if key not in {"Hostname", "Image", "Labels"}
                }
            )
        ).hexdigest(),
        "environment_sha256": hashlib.sha256(
            r.canonical(sorted(config["Env"]))
        ).hexdigest(),
        "user": config["User"],
        "entrypoint": config["Entrypoint"],
        "command": config["Cmd"],
        "healthcheck": config["Healthcheck"],
        "read_only": host["ReadonlyRootfs"],
        "privileged": host["Privileged"],
        "cap_add": host["CapAdd"],
        "cap_drop": host["CapDrop"],
        "security_opt": host["SecurityOpt"],
        "group_add": host["GroupAdd"],
        "memory": host["Memory"],
        "nano_cpus": host["NanoCpus"],
        "pids_limit": host["PidsLimit"],
        "restart_policy": host["RestartPolicy"],
        "init": host["Init"],
        "tmpfs": host["Tmpfs"],
        "port_bindings": host["PortBindings"],
        "network_mode": host["NetworkMode"],
        "networks": sorted(row["NetworkSettings"]["Networks"]),
        "mounts": sorted(
            [
                {k: mount[k] for k in ["Type", "Name", "Source", "Destination", "RW"]}
                for mount in row["Mounts"]
            ],
            key=lambda mount: mount["Destination"],
        ),
    }


def configuration(plan, environment):
    r.require(environment in {"staging", "production"}, "SCANNER_ENVIRONMENT")
    return {
        "schema_version": 1,
        "component": "scanner",
        "environment": environment,
        "baseline": plan["baseline"],
        "runtime": plan["runtime"],
        "recipe": plan["recipe"],
        "rollback": plan["rollback"],
        "legacy_backup": plan["legacy_backup"],
        "workflow": plan["workflow"],
        "staging_profile": STAGING_PROFILE,
        "processing_scope": "existing-private-malware-scanning-no-new-processing",
        "publication_controls_unchanged": True,
        "physical_hardware_authorized": False,
    }


def validate_plan(binding, plan):
    exact(
        plan,
        [
            "schema_version",
            "verifier_store",
            "baseline",
            "runtime",
            "recipe",
            "rollback",
            "legacy_backup",
            "workflow",
        ],
        "SCANNER_PLAN_SCHEMA",
    )
    r.require(
        plan["schema_version"] == 1
        and binding["repository"] == REPOSITORY
        and binding["component"] == "scanner"
        and binding["target_environment"] == "production"
        and re.fullmatch(r"[a-f0-9]{40}", binding["source_tree"])
        and re.fullmatch(r"[a-f0-9]{40}", binding["candidate_commit"]),
        "SCANNER_COMPONENT_SCOPE",
    )
    workflows.validate_plan(binding, plan)
    r.require(
        isinstance(plan["baseline"], dict)
        and TARGET in plan["baseline"]
        and len(plan["baseline"]) >= 11,
        "COMPLETE_SCANNER_PRESERVATION_BASELINE",
    )
    runtime = plan["runtime"]
    r.require(
        runtime["user"] == "clamav"
        and runtime["entrypoint"] == ["/usr/local/bin/onesa-clamav"]
        and runtime["command"] is None
        and runtime["read_only"] is True
        and runtime["privileged"] is False
        and not runtime["cap_add"]
        and runtime["cap_drop"] == ["ALL"]
        and runtime["security_opt"] == ["no-new-privileges:true"]
        and runtime["group_add"] == ["3000"]
        and not runtime["port_bindings"]
        and runtime["memory"] == 4 * 1024**3
        and runtime["nano_cpus"] == 800000000
        and runtime["pids_limit"] == 128
        and runtime["init"] is True
        and len(runtime["mounts"]) == 2
        and {v["Destination"] for v in runtime["mounts"]}
        == {"/var/lib/clamav", "/run/onesa-scanner"}
        and all(v["Type"] == "volume" and v["RW"] is True for v in runtime["mounts"]),
        "PRIVATE_SCANNER_RUNTIME_REQUIRED",
    )
    recipe = plan["recipe"]
    artifact_folder = ROOT / "artifacts" / binding["source_tree"]
    exact(recipe, ["project", "directory", "files"], "SCANNER_RECIPE_SCHEMA")
    r.require(
        recipe["project"] == "onesa-portal-oracle-staging"
        and isinstance(recipe["files"], list)
        and len(recipe["files"]) == 1
        and recipe["directory"] == str(artifact_folder),
        "EXISTING_SCANNER_COMPOSE_ONLY",
    )
    for item in recipe["files"]:
        exact(item, ["path", "sha256"], "SCANNER_COMPOSE_PIN_SCHEMA")
        r.require(
            item["path"] == str(artifact_folder / "compose.oracle-staging.yaml")
            and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]),
            "SCANNER_COMPOSE_PIN",
        )
    r.require(
        len({v["path"] for v in recipe["files"]}) == len(recipe["files"]),
        "SCANNER_COMPOSE_DUPLICATE",
    )
    exact(plan["rollback"], ["artifact_digest", "automatic"], "SCANNER_ROLLBACK_SCHEMA")
    r.require(
        plan["rollback"]["automatic"] is False
        and plan["rollback"]["artifact_digest"] == plan["baseline"][TARGET]["image"]
        and plan["rollback"]["artifact_digest"] != binding["artifact_digest"],
        "RETAINED_SCANNER_ROLLBACK_REQUIRED",
    )
    for environment in ["staging", "production"]:
        r.require(
            hashlib.sha256(r.canonical(configuration(plan, environment))).hexdigest()
            == binding["configuration_sha256"][environment],
            "SCANNER_CONFIGURATION_CHANGED",
        )
    return artifact_folder


def retained(plan, *, replacement=False):
    observed = r.inventory()
    r.require(set(observed) == set(plan["baseline"]), "PERSISTENT_WORKLOAD_SET_CHANGED")
    for name, row in observed.items():
        r.require(r.healthy(row), "PERSISTENT_WORKLOAD_UNHEALTHY")
        if name != TARGET or not replacement:
            r.require(
                r.summary(row) == plan["baseline"][name], "INDEPENDENT_WORKLOAD_CHANGED"
            )
    r.require(
        profile(observed[TARGET]) == plan["runtime"],
        "SCANNER_RUNTIME_CONFIGURATION_CHANGED",
    )
    return observed


def image(binding, folder):
    """Reconstruct source, inspect actual bytes, require a current complete scan."""
    source = r.private(folder / "source.tar")
    r.require(
        r.sha(source) == binding["source_sha256"], "SCANNER_SOURCE_ARCHIVE_CHANGED"
    )
    _, files = r.source_inventory(source, binding)
    r.require(
        r.sha(r.private(folder / "compose.oracle-staging.yaml"))
        == files["compose.oracle-staging.yaml"],
        "SCANNER_RECIPE_DIFFERS_FROM_SOURCE",
    )
    build = r.read(folder / "build.json")
    r.require(
        r.sha(folder / "build.json") == binding["build_sha256"], "SCANNER_BUILD_CHANGED"
    )
    r.require(
        all(
            build.get(k) == binding[k]
            for k in [
                "repository",
                "component",
                "candidate_commit",
                "source_tree",
                "source_sha256",
                "artifact_digest",
            ]
        )
        and build.get("architecture") == "arm64"
        and build.get("dockerfile_sha256") == files[PREFIX + "Dockerfile"],
        "SCANNER_BUILD_SOURCE_MISMATCH",
    )
    row = json.loads(r.docker("image", "inspect", binding["artifact_digest"]))[0]
    labels = row["Config"].get("Labels", {})
    r.require(
        row["Id"] == binding["artifact_digest"]
        and row["Os"] == "linux"
        and row["Architecture"] == "arm64"
        and row["Config"]["User"] == "clamav"
        and row["Config"]["Entrypoint"] == ["/usr/local/bin/onesa-clamav"]
        and row["Config"].get("Cmd") is None
        and row["Config"]["Env"]
        == ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
        and labels.get("org.opencontainers.image.revision")
        == binding["candidate_commit"]
        and labels.get("org.onesa.source-sha256") == binding["source_sha256"],
        "ACTUAL_SCANNER_IMAGE_SOURCE_MISMATCH",
    )
    paths = list(SHIPPED.values())
    raw = r.docker(
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
        binding["artifact_digest"],
        *paths,
    )
    actual = {}
    for line in raw.decode().splitlines():
        checksum, path = line.split("  ", 1)
        r.require(path not in actual, "SCANNER_IMAGE_DUPLICATE_FILE")
        actual[path] = checksum
    r.require(
        actual == {path: files[PREFIX + name] for name, path in SHIPPED.items()},
        "ACTUAL_SCANNER_FILES_DIFFER_FROM_SOURCE",
    )
    r.image_security(r.read(folder / "scan.json"), binding["artifact_digest"])
    return {
        "build_sha256": binding["build_sha256"],
        "files": actual,
        "image": row["Id"],
        "scan_sha256": r.sha(folder / "scan.json"),
    }


def protocol(directory):
    path = Path(directory) / "clamd.sock"
    info, parent = path.stat(), path.parent.stat()
    r.require(
        stat.S_ISSOCK(info.st_mode)
        and info.st_gid == 3000
        and stat.S_IMODE(info.st_mode) == 0o660
        and parent.st_gid == 3000
        and stat.S_IMODE(parent.st_mode) == 0o2770,
        "SCANNER_SOCKET_ACCESS_BOUNDARY",
    )

    def exchange(command, payload=b""):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(20)
            client.connect(str(path))
            client.sendall(command + payload)
            value = bytearray()
            while not value.endswith(b"\0"):
                block = client.recv(1024)
                r.require(
                    block and len(value) + len(block) <= 4096, "SCANNER_RESPONSE_BOUND"
                )
                value.extend(block)
            return bytes(value)

    def scan(data):
        return exchange(b"zINSTREAM\0", len(data).to_bytes(4, "big") + data + b"\0" * 4)

    r.require(exchange(b"zPING\0") == b"PONG\0", "SCANNER_PING_FAILED")
    version = exchange(b"zVERSION\0").decode().rstrip("\0")
    r.require(
        re.fullmatch(r"ClamAV 1\.4\.6/[0-9]+/[^\r\n\0]{1,100}", version),
        "SCANNER_LOADED_ENGINE_IDENTITY",
    )
    r.require(
        scan(b"%PDF-1.7\nOnesa disposable scanner qualification\n%%EOF")
        == b"stream: OK\0",
        "SCANNER_BENIGN_STREAM_REJECTED",
    )
    eicar = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    result = scan(eicar)
    r.require(
        result.startswith(b"stream: ") and result.endswith(b" FOUND\0"),
        "SCANNER_MALWARE_STREAM_NOT_REJECTED",
    )
    marker = int((Path(directory) / "scanner-ready").read_text())
    r.require(0 <= time.time() - marker < 90, "SCANNER_HEALTH_MARKER_STALE")
    return {
        "loaded_engine": version,
        "benign": "PASS",
        "eicar": "PASS",
        "socket_access": "PASS",
        "fresh_health_marker": "PASS",
    }


def wait_healthy(name, expected):
    deadline = time.monotonic() + 240
    while True:
        row = json.loads(r.docker("inspect", name))[0]
        r.require(
            row["Image"] == expected and row["State"]["Running"],
            "SCANNER_STARTUP_EXITED",
        )
        if r.healthy(row):
            return row
        r.require(time.monotonic() < deadline, "SCANNER_HEALTH_TIMEOUT")
        time.sleep(1)


def staging_resources(row):
    """Read back enforced limits and isolation, including after a restart."""
    host = row["HostConfig"]
    r.require(
        type(host["Memory"]) is int
        and host["Memory"] == STAGING_PROFILE["memory_bytes"]
        and type(host["NanoCpus"]) is int
        and host["NanoCpus"] == STAGING_PROFILE["nano_cpus"]
        and type(host["PidsLimit"]) is int
        and host["PidsLimit"] == STAGING_PROFILE["pids_limit"],
        "SCANNER_STAGING_RESOURCE_LIMITS_DIFFER",
    )
    r.require(
        host["ReadonlyRootfs"] is True
        and host["Privileged"] is False
        and not host["PortBindings"]
        and not host["CapAdd"]
        and host["CapDrop"] == ["ALL"]
        and host["SecurityOpt"] == ["no-new-privileges:true"]
        and not host.get("DeviceRequests")
        and not host.get("Devices")
        and len(row["Mounts"]) == 2,
        "SCANNER_STAGING_ISOLATION",
    )
    return {
        "memory_bytes": host["Memory"],
        "nano_cpus": host["NanoCpus"],
        "pids_limit": host["PidsLimit"],
    }


def socket_directory(row):
    mounts = [v for v in row["Mounts"] if v["Destination"] == "/run/onesa-scanner"]
    r.require(
        len(mounts) == 1 and mounts[0]["Type"] == "volume", "SCANNER_SOCKET_VOLUME"
    )
    path = Path(mounts[0]["Source"])
    r.require(
        str(path).startswith("/var/lib/docker/volumes/") and not path.is_symlink(),
        "SCANNER_SOCKET_VOLUME_PATH",
    )
    return path


def access_probe(image_id, directory):
    for group, allowed in [(3000, True), (65534, False)]:
        command = (
            "clamdscan --config-file=/etc/clamav/clamd.conf --ping=1 >/dev/null 2>&1"
        )
        shell = command if allowed else "if " + command + "; then exit 1; fi"
        r.docker(
            "run",
            "--rm",
            "--pull=never",
            "--network",
            "none",
            "--read-only",
            "--user",
            "65534:" + str(group),
            "--memory",
            "64m",
            "--cpus",
            "0.1",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "-v",
            str(directory) + ":/run/onesa-scanner:ro",
            "--entrypoint",
            "/bin/sh",
            image_id,
            "-c",
            shell,
        )
    return {"authorized_group_ping": "PASS", "unrelated_group_denied": "PASS"}


def public_definition_files(row):
    mounts = [v for v in row["Mounts"] if v["Destination"] == "/var/lib/clamav"]
    r.require(
        len(mounts) == 1 and mounts[0]["Type"] == "volume", "SCANNER_DEFINITIONS_VOLUME"
    )
    source = Path(mounts[0]["Source"])
    r.require(
        str(source).startswith("/var/lib/docker/volumes/") and not source.is_symlink(),
        "SCANNER_DEFINITIONS_PATH",
    )
    entries = [
        p
        for p in source.iterdir()
        if re.fullmatch(r"(?:main|daily|bytecode)\.(?:cvd|cld)|freshclam\.dat", p.name)
    ]
    r.require(
        2 <= len(entries) <= 7
        and all(p.is_file() and not p.is_symlink() for p in entries),
        "PUBLIC_SIGNATURE_FILES_ONLY",
    )
    size = sum(p.stat().st_size for p in entries)
    r.require(0 < size < 512 * 1024**2, "PUBLIC_SIGNATURE_SIZE_BOUND")
    return entries


def definition_reserve(entries, *, copies):
    r.require(type(copies) is int and copies in {1, 2}, "SIGNATURE_COPY_COUNT")
    size = sum(p.stat().st_size for p in entries)
    fs = os.statvfs("/")
    r.require(
        fs.f_bavail * fs.f_frsize - copies * size > 12 * 1024**3,
        "SCANNER_DISK_RESERVE",
    )


def public_definitions(row, destination, uid, gid):
    entries = public_definition_files(row)
    definition_reserve(entries, copies=1)
    destination.mkdir(mode=0o700)
    os.chown(destination, uid, gid)
    values = {}
    for source_file in entries:
        target = destination / source_file.name
        shutil.copy2(source_file, target)  # Never manufacture definition freshness.
        os.chown(target, uid, gid)
        target.chmod(0o644)
        values[source_file.name] = {
            "bytes": target.stat().st_size,
            "sha256": r.sha(target),
            "mtime_ns": target.stat().st_mtime_ns,
        }
    return values


def stage_one(image_id, baseline, folder, operation, suffix, workflow=None):
    """Only disposable containers; production volumes are never mounted here."""
    name = "onesa-scanner-qualification-" + operation + "-" + suffix
    label = "org.onesa.scanner-qualification=" + operation
    uid = int(
        r.docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--entrypoint",
            "id",
            image_id,
            "-u",
        )
    )
    gid = int(
        r.docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--entrypoint",
            "id",
            image_id,
            "-g",
        )
    )
    r.require(0 < uid < 65535 and 0 < gid < 65535, "UNPRIVILEGED_SCANNER_REQUIRED")
    definitions = folder / (suffix + "-definitions")
    copied = public_definitions(baseline, definitions, uid, gid)
    socket_volume = (
        "onesa-sq-" + operation.replace("-", "")[:16] + "-" + suffix + "_scanner_socket"
    )
    existing = r.docker(
        "volume",
        "ls",
        "--filter",
        "name=^" + socket_volume + "$",
        "--format",
        "{{.Name}}",
    )
    r.require(not existing.strip(), "SCANNER_OWNED_SOCKET_ALREADY_EXISTS_INSPECT_ONLY")
    r.docker("volume", "create", "--label", label, socket_volume)
    volume = json.loads(r.docker("volume", "inspect", socket_volume))[0]
    r.require(
        volume["Driver"] == "local"
        and volume["Labels"].get("org.onesa.scanner-qualification") == operation,
        "SCANNER_OWNED_SOCKET_VOLUME_REQUIRED",
    )
    directory = Path(volume["Mountpoint"])
    r.require(
        str(directory).startswith("/var/lib/docker/volumes/")
        and not directory.is_symlink()
        and len(str(directory / "clamd.sock").encode()) < 104,
        "SCANNER_OWNED_SOCKET_PATH",
    )
    os.chown(directory, uid, 3000)
    os.chmod(directory, 0o2770)
    network = name + "-network"
    network_created = False
    try:
        r.docker("network", "create", "--driver", "bridge", "--label", label, network)
        network_created = True
        r.docker(
            "run",
            "-d",
            "--pull=never",
            "--name",
            name,
            "--label",
            label,
            "--network",
            network,
            "--read-only",
            "--memory",
            str(STAGING_PROFILE["memory_bytes"]),
            "--cpus",
            "0.25",
            "--pids-limit",
            "64",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--tmpfs",
            "/tmp:rw,mode=1777,size=16m",
            "-v",
            str(definitions) + ":/var/lib/clamav:rw",
            "-v",
            socket_volume + ":/run/onesa-scanner:rw",
            image_id,
        )
        actual = wait_healthy(name, image_id)
        observations = {
            "before_restart_resources": staging_resources(actual),
            "before_restart": protocol(directory),
            "access": access_probe(image_id, directory),
        }
        r.docker("restart", "--time", "10", name, timeout=30)
        actual = wait_healthy(name, image_id)
        observations["after_restart_resources"] = staging_resources(actual)
        observations["after_restart"] = protocol(directory)
        if workflow is not None:
            observations["authenticated_workflows"] = workflow(network, socket_volume)
        observations.update(
            image=image_id,
            public_signature_copies=copied,
            application_credentials_mounted=False,
            application_data_mounted=False,
        )
        return observations
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
                == operation,
                "SCANNER_CLEANUP_OWNERSHIP",
            )
            logs = subprocess.run(
                ["/usr/bin/docker", "logs", name],
                capture_output=True,
                timeout=15,
                check=False,
            )
            r.write_raw(folder / (suffix + "-stdout.log"), logs.stdout)
            r.write_raw(folder / (suffix + "-stderr.log"), logs.stderr)
            r.docker("rm", "-f", name, timeout=60)
        if network_created:
            row = json.loads(r.docker("network", "inspect", network))[0]
            r.require(
                row["Labels"].get("org.onesa.scanner-qualification") == operation,
                "SCANNER_NETWORK_CLEANUP_OWNERSHIP",
            )
            r.docker("network", "rm", network)
        owned = json.loads(r.docker("volume", "inspect", socket_volume))[0]
        r.require(
            owned["Labels"].get("org.onesa.scanner-qualification") == operation,
            "SCANNER_SOCKET_CLEANUP_OWNERSHIP",
        )
        r.docker("volume", "rm", socket_volume)


def capacity(*, staging=False):
    metrics = r.read(Path("/var/lib/onesa/operations/metrics.json"))
    r.require(
        metrics["simulation"] is False
        and not metrics["alerts"]
        and not metrics.get("notification_pending")
        and not metrics.get("notification_reconciliation_required"),
        "SCANNER_OPERATIONS_ALERT",
    )
    age = r.now() - dt.datetime.fromisoformat(metrics["checked_at"])
    r.require(
        dt.timedelta(0) <= age < dt.timedelta(minutes=5), "SCANNER_OPERATIONS_STALE"
    )
    values = metrics["metrics"]
    r.require(
        values["database_available"]
        and not values["database_backup_failed"]
        and values["memory_available_bytes"] > (3 if staging else 2) * 1024**3
        and values["disk_used_percent"] < 80,
        "SCANNER_OPERATIONS_CAPACITY",
    )
    return metrics


def staging_capacity():
    metrics = capacity(staging=True)
    # Only scanner qualification copies signatures. Keep independent API/worker
    # callers of capacity free of this scanner-specific disk requirement.
    current = json.loads(r.docker("inspect", TARGET))
    r.require(len(current) == 1, "SCANNER_CURRENT_DEFINITION_SOURCE_REQUIRED")
    definition_reserve(public_definition_files(current[0]), copies=2)
    return metrics


def staging(binding, plan, context, folder, records):
    with component_lock():
        return staging_once(binding, plan, context, folder, records)


def staging_once(binding, plan, context, folder, records):
    staging_capacity()
    before = retained(plan)
    observations = ROOT / "observations"
    observations.mkdir(mode=0o700, exist_ok=True)
    r.private(observations, directory=True)
    target = observations / identifier(context["context_id"])
    target.mkdir(mode=0o700)  # A failed or interrupted attempt is never repeated.
    r.write(
        target / "intent.json",
        {
            "binding": binding,
            "context_id": context["context_id"],
            "state": "RESERVED_STAGING_STARTED",
        },
    )
    try:
        identity = image(binding, folder)
        candidate = stage_one(
            binding["artifact_digest"],
            before[TARGET],
            target,
            context["context_id"],
            "candidate",
            workflow=lambda network, volume: workflows.observe(
                binding,
                plan,
                folder,
                context["context_id"],
                records,
                network,
                volume,
                target,
            ),
        )
        rollback = stage_one(
            plan["rollback"]["artifact_digest"],
            before[TARGET],
            target,
            context["context_id"],
            "rollback",
        )
        retained(plan)
        receipt = {
            "binding": binding,
            "context_id": context["context_id"],
            "status": "PASS",
            "identity": identity,
            "candidate": candidate,
            "rollback": rollback,
            "production_schema_migrations": 0,
            "existing_application_data_unchanged": True,
            "observed_at": r.now().isoformat(),
        }
        r.write(target / "receipt.json", receipt)
        return {"receipt_sha256": r.sha(target / "receipt.json"), "receipt": receipt}
    finally:
        retained(plan)


def operations(binding, plan, records):
    retained(plan)
    capacity()
    for timer in ["onesa-portal-backup.timer", "onesa-portal-monitor.timer"]:
        r.require(
            r.command(["/usr/bin/systemctl", "is-active", timer]).strip() == b"active",
            "SCANNER_PRESERVED_TIMER_INACTIVE",
        )
    backup = r.read(Path("/var/lib/onesa/operations/backup-success.json"))
    r.require(
        backup["consistent_snapshot"] is True
        and backup["passed"] is True
        and dt.timedelta(0)
        <= r.now() - dt.datetime.fromisoformat(backup["verified_at"])
        < dt.timedelta(hours=36),
        "SCANNER_RECOVERY_BACKUP_STALE",
    )
    transport = plan["legacy_backup"]
    r.require(
        transport["transport_image"] == r.trusted_toolchain(plan)["transport_image"]
        and transport["transport_env"] == "/etc/onesa/portal-production.env"
        and r.sha(r.private(Path(transport["transport_env"])))
        == transport["transport_runtime_sha256"],
        "SCANNER_RECOVERY_TRANSPORT_CUSTODY_CHANGED",
    )
    readback = r.inspect_database_backup(backup, plan)
    contexts = [v for v in records if v["kind"] == "context"]
    r.require(len(contexts) == 1, "SCANNER_SIGNED_STAGING_CONTEXT_REQUIRED")
    receipt_path = ROOT / "observations" / contexts[0]["id"] / "receipt.json"
    stage = r.read(receipt_path)
    r.require(
        stage["binding"] == binding
        and stage["status"] == "PASS"
        and stage["production_schema_migrations"] == 0
        and stage["existing_application_data_unchanged"] is True
        and stage["candidate"]["authenticated_workflows"]["state"]
        == "SCANNER_DEPENDENCY_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION",
        "SCANNER_STAGING_EVIDENCE_MISSING",
    )
    for qualified in [v for v in records if v["kind"] == "qualification"]:
        r.require(
            qualified["details"]["staging"]["observations"]["receipt_sha256"]
            == r.sha(receipt_path),
            "SIGNED_SCANNER_STAGING_RECEIPT_CHANGED",
        )
    r.require(
        json.loads(r.docker("image", "inspect", plan["rollback"]["artifact_digest"]))[
            0
        ]["Id"]
        == plan["rollback"]["artifact_digest"],
        "SCANNER_ROLLBACK_ARTIFACT_MISSING",
    )
    return {
        "backup_readback": readback,
        "staging_receipt_sha256": r.sha(receipt_path),
        "rollback_mode": "explicit-owner-only-shared-scanner-image-restore",
        "application_schema_or_processing_changed": False,
    }


def recipe_command(plan, override):
    value = plan["recipe"]
    args = [
        "/usr/bin/docker",
        "compose",
        "--project-directory",
        value["directory"],
        "--project-name",
        value["project"],
    ]
    for item in value["files"]:
        r.pinned_public_file(Path(item["path"]), item["sha256"])
        args += ["-f", item["path"]]
    return args + ["-f", str(override)]


def deployment_folder(operation):
    return ROOT / "deployments" / identifier(operation)


def previous_operations():
    """A new installation cannot hide an older uncertain provider request."""
    parent = ROOT / "deployments"
    if not parent.exists():
        return
    r.private(parent, directory=True)
    paths = list(parent.iterdir())
    r.require(len(paths) < 1000, "SCANNER_DEPLOYMENT_HISTORY_BOUND")
    for path in paths:
        r.private(path, directory=True)
        identifier(path.name)
        if not (path / "request.json").exists():
            continue  # No request could precede its durable exclusive journal.
        request = r.read(path / "request.json")
        binding = request["binding"]
        r.require(
            binding["repository"] == REPOSITORY
            and binding["component"] == "scanner"
            and request["context"]["operation_id"] == path.name,
            "SCANNER_PREVIOUS_OPERATION_SCOPE",
        )
        # Verify the signature chain, binding, revocations and accepted index.
        r.verify_invocation(
            binding,
            {"operation_id": path.name, "read_only": True},
            "production",
            {"verifier_store": request["verifier_store"]},
            dependency=True,
        )


def composed_recipe(value, binding, plan, labels):
    """Reject every unreviewed scanner setting before a production request."""
    expected = {
        "build": {
            "context": plan["recipe"]["directory"] + "/infra/oracle/clamav",
            "dockerfile": "Dockerfile",
        },
        "cap_drop": ["ALL"],
        "cpus": 0.8,
        "command": None,
        "entrypoint": None,
        "group_add": ["3000"],
        "image": binding["artifact_digest"],
        "init": True,
        "labels": labels,
        "logging": {
            "driver": "json-file",
            "options": {"max-file": "3", "max-size": "10m"},
        },
        "mem_limit": str(4 * 1024**3),
        "networks": {"signature_updates": None},
        "pids_limit": 128,
        "platform": "linux/arm64",
        "read_only": True,
        "restart": "unless-stopped",
        "security_opt": ["no-new-privileges:true"],
        "stop_grace_period": "3m0s",
        "tmpfs": ["/tmp"],
        "volumes": [
            {
                "type": "volume",
                "source": "staging_signatures",
                "target": "/var/lib/clamav",
                "volume": {},
            },
            {
                "type": "volume",
                "source": "scanner_socket",
                "target": "/run/onesa-scanner",
                "volume": {},
            },
        ],
    }
    r.require(
        value["services"]["scanner"] == expected, "SCANNER_COMPOSE_RENDER_MISMATCH"
    )
    for alias, destination in [
        ("staging_signatures", "/var/lib/clamav"),
        ("scanner_socket", "/run/onesa-scanner"),
    ]:
        actual = [
            v for v in plan["runtime"]["mounts"] if v["Destination"] == destination
        ]
        r.require(
            len(actual) == 1 and value["volumes"][alias]["name"] == actual[0]["Name"],
            "SHARED_SCANNER_VOLUME_WOULD_CHANGE",
        )
    r.require(
        value["networks"]["signature_updates"]["name"] in plan["runtime"]["networks"]
        and len(plan["runtime"]["networks"]) == 1,
        "SCANNER_EXISTING_NETWORK_REQUIRED",
    )


def deploy(binding, plan, context, folder):
    with component_lock():
        return deploy_once(binding, plan, context, folder)


def deploy_once(binding, plan, context, folder):
    if deployment_folder(context["operation_id"]).exists():
        raise FileExistsError("SCANNER_OPERATION_EXISTS_INSPECT_ONLY")
    previous_operations()
    retained(plan)
    image(binding, folder)
    parent = ROOT / "deployments"
    parent.mkdir(mode=0o700, exist_ok=True)
    target = deployment_folder(context["operation_id"])
    target.mkdir(
        mode=0o700
    )  # Exclusive reservation; even an interrupted command cannot replay.
    override = target / "scanner-override.json"
    labels = {
        "org.onesa.source-commit": binding["candidate_commit"],
        "org.onesa.release-operation": context["operation_id"],
    }
    r.write(
        override,
        {
            "services": {
                "scanner": {"image": binding["artifact_digest"], "labels": labels}
            }
        },
    )
    args = recipe_command(plan, override)
    # Render the full configuration before the sole request. Inspect only this
    # service; do not export the composed environment of the independent worker.
    composed = json.loads(r.command(args + ["config", "--format", "json"]))
    composed_recipe(composed, binding, plan, labels)
    r.write(
        target / "request.json",
        {
            "binding": binding,
            "context": context,
            "verifier_store": plan["verifier_store"],
            "request_budget": 1,
            "automatic_retry": False,
            "override_sha256": r.sha(override),
            "recorded_at": r.now().isoformat(),
        },
    )
    try:
        result = subprocess.run(
            args
            + [
                "up",
                "--no-deps",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "240",
                "scanner",
            ],
            capture_output=True,
            timeout=300,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired as error:
        r.write_raw(target / "provider-command.stdout", error.stdout or b"")
        r.write_raw(target / "provider-command.stderr", error.stderr or b"")
        r.write(
            target / "provider-command-result.json",
            {
                "operation_id": context["operation_id"],
                "state": "TIMED_OUT_OUTCOME_UNCERTAIN",
                "automatic_retry": False,
                "observed_at": r.now().isoformat(),
            },
        )
        raise r.Refused("SCANNER_REQUEST_INTERRUPTED_INSPECT_ONLY") from None
    r.write_raw(target / "provider-command.stdout", result.stdout)
    r.write_raw(target / "provider-command.stderr", result.stderr)
    r.write(
        target / "provider-command-result.json",
        {
            "operation_id": context["operation_id"],
            "returncode": result.returncode,
            "observed_at": r.now().isoformat(),
            "automatic_retry": False,
        },
    )
    r.require(result.returncode == 0, "SCANNER_REQUEST_FAILED_INSPECT_ONLY")
    # Do not repeat up if this read fails. The recorded intent is observed instead.
    result = production(binding, plan, context)
    r.write(target / "provider-receipt.json", result)
    return result


def production(binding, plan, context):
    target = deployment_folder(context["operation_id"])
    request = r.read(target / "request.json")
    r.require(
        request["binding"] == binding
        and request["context"]["operation_id"] == context["operation_id"]
        and request["request_budget"] == 1
        and request["automatic_retry"] is False,
        "SCANNER_DURABLE_REQUEST_REQUIRED",
    )
    observed = retained(plan, replacement=True)
    row = observed[TARGET]
    labels = row["Config"].get("Labels", {})
    r.require(
        row["Id"] != plan["baseline"][TARGET]["container_id"]
        and row["Image"] == binding["artifact_digest"]
        and labels.get("org.onesa.release-operation") == context["operation_id"]
        and labels.get("org.onesa.source-commit") == binding["candidate_commit"],
        "ACTUAL_RUNNING_SCANNER_REVISION_MISMATCH",
    )
    r.require(
        r.sha(target / "scanner-override.json") == request["override_sha256"],
        "SCANNER_DEPLOYMENT_OVERRIDE_CHANGED",
    )
    checks = protocol(socket_directory(row))
    checks["access"] = access_probe(binding["artifact_digest"], socket_directory(row))
    retained(plan, replacement=True)
    return {
        "operation_id": context["operation_id"],
        "deployment_id": row["Id"],
        "artifact_digest": row["Image"],
        "source_commit": binding["candidate_commit"],
        "protocol": checks,
        "production_schema_migrations": 0,
        "new_real_data_processing": False,
        "physical_hardware_authorized": False,
    }


def runner(phase, binding, context):
    r.require(phase in CHECKS, "SCANNER_PHASE_SCOPE")
    plan = r.read(PLAN)
    folder = validate_plan(binding, plan)
    records = r.verify_invocation(binding, context, phase, plan)
    if phase == "staging":
        details = staging(binding, plan, context, folder, records)
    elif phase == "operations":
        details = operations(binding, plan, records)
    elif phase == "deploy":
        details = deploy(binding, plan, context, folder)
    else:
        details = production(binding, plan, context)
    return {
        **details,
        "binding": binding,
        "environment": "staging" if phase == "staging" else "production",
        "workflow_run_id": 0,
        "observed_at": r.now().isoformat(),
        "checks": {key: "PASS" for key in CHECKS[phase]},
    }


def record_failure(phase, request, error, *, component="scanner"):
    """Private diagnostics only; never success, authority or permission to retry."""
    try:
        if not isinstance(request, dict) or not isinstance(
            request.get("context"), dict
        ):
            return
        binding = request["binding"]
        r.require(
            component in {"scanner", "api", "worker"}
            and phase in CHECKS
            and binding["repository"] == REPOSITORY
            and binding["component"] == component
            and re.fullmatch(r"[a-f0-9]{40}", binding["candidate_commit"]),
            "SCANNER_DIAGNOSTIC_SCOPE",
        )
        ids = {
            key: identifier(value)
            for key, value in request["context"].items()
            if key
            in {"context_id", "operation_id", "authorization_id", "qualification_id"}
        }
        code = (
            str(error)
            if isinstance(error, r.Refused)
            and re.fullmatch(r"[A-Z0-9_]{1,120}", str(error))
            else type(error).__name__
        )
        component_root = r.private(ROOT.parent / component, directory=True)
        folder = component_root / "failures"
        folder.mkdir(mode=0o700, exist_ok=True)
        r.private(folder, directory=True)
        r.write(
            folder / (phase + "-" + str(time.time_ns()) + ".json"),
            {
                "candidate_commit": binding["candidate_commit"],
                "component": component,
                "phase": phase,
                "record_ids": ids,
                "failure_code": code,
                "observed_at": r.now().isoformat(),
                "provider_retry_allowed": False,
                "diagnostic_only_not_authorization": True,
            },
        )
    except (r.Refused, KeyError, ValueError, TypeError, OSError):
        pass


def main():
    request = None
    try:
        r.require(
            os.geteuid() == 0
            and os.getenv("SUDO_USER") == "ubuntu"
            and not os.getenv("GITHUB_ACTIONS"),
            "EXISTING_OWNER_SSH_REQUIRED",
        )
        r.require(len(sys.argv) == 2, "SCANNER_PHASE_REQUIRED")
        raw = sys.stdin.buffer.read(128 * 1024 + 1)
        r.require(len(raw) <= 128 * 1024, "SCANNER_REQUEST_BOUND")
        request = json.loads(raw)
        exact(request, ["binding", "context"], "SCANNER_REQUEST_SCHEMA")
        value = runner(sys.argv[1], request["binding"], request["context"])
        print(json.dumps(value, sort_keys=True))
    except Exception as error:  # noqa: BLE001 -- redact private input at the CLI boundary
        # Arbitrary Docker/JSON/configuration errors must never export a secret.
        record_failure(sys.argv[1] if len(sys.argv) == 2 else None, request, error)
        print(json.dumps({"state": "SCANNER_OBSERVATION_FAILED_INSPECT_WITHOUT_RETRY"}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
