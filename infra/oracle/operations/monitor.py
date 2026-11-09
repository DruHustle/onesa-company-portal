"""Private metrics and bounded notifications. Simulations never stop actual services."""

import argparse
import datetime
import fcntl
import hashlib
import hmac
import html
import importlib.util
import json
import math
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

STATE = Path("/var/lib/onesa/operations")
REMINDER_SECONDS = 6 * 60 * 60
UPDATE_SECONDS = 30 * 60
RECOVERY_SECONDS = 5 * 60
RECOVERY_SAMPLES = 6
MAX_SAMPLE_GAP_SECONDS = 120
TRANSPORT_FAILURE_SECONDS = 120
TRANSPORT_FAILURE_SAMPLES = 3
SCANNER_FALLBACK_SECONDS = 4
PROBE_CLEANUP_COMMAND_SECONDS = 1
PROBE_OWNER_LABEL = "org.onesa.operations-metrics-probe"
PROBE_INSPECT_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},'
    '"command":{{json .Config.Cmd}},"auto_remove":{{json .HostConfig.AutoRemove}},'
    '"read_only":{{json .HostConfig.ReadonlyRootfs}},'
    '"owner":{{json (index .Config.Labels "' + PROBE_OWNER_LABEL + '")}}}'
)
NOTIFICATION_SCOPE = "production-and-shared-v1"
# Provider keys last 24 hours; leave an hour before manual reconciliation is needed.
PENDING_RETRY_SECONDS = 23 * 60 * 60
MAIL_ENVELOPE_VERSION = 2
MAIL_BODY_MAX_BYTES = 32768
MAIL_PRODUCTS = frozenset({"portal", "ai", "robot"})
# Historical recipients remain valid so retained immutable attempts can be
# reconciled. OPERATIONS_NOTIFY_EMAIL separates infrastructure from app mail;
# legacy profiles retain their NOTIFY_EMAIL fallback until explicitly migrated.
MAIL_RECIPIENTS = frozenset({
    "info@onesa.eu", "andrew@onesa.eu", "it-infrastructure@onesa.eu",
})
API_ALERT_RULES = frozenset({"backend-api-unavailable", "backend-api-restarted"})
NOTIFICATION_KINDS = frozenset({"alert", "update", "reminder", "recovery", "simulation"})
RULES = (
    "worker-stopped",
    "job-retry-exhausted",
    "queue-stalled",
    "clamav-unavailable",
    "signature-update-failed",
    "backup-failed",
    "resource-exhaustion",
    "database-unavailable",
    "worker-restarted",
    "backend-api-unavailable",
    "backend-api-restarted",
)

BACKENDS = {
    f"{product}-{environment}": {
        "container": f"onesa-{product}-oracle-api-{environment}-1",
        "product": product,
        "environment": environment,
        "url": "https://"
        + hostname
        + "-api"
        + ("-staging" if environment == "staging" else "")
        + ".onesa.eu"
        + (
            "/health"
            if product == "ai"
            else "/api/v1/ready"
            if product == "robot"
            else "/api/v1/health"
        ),
        "status": "ready" if product == "robot" else "ok",
        "probe": "readiness" if product == "robot" else "liveness",
    }
    for product, hostname in [
        ("portal", "portal"),
        ("ai", "platform"),
        ("robot", "robot"),
    ]
    for environment in ["staging", "production"]
}
# Recognition does not enable sampling. The original six commissioned slots are
# unchanged; Drone requires its separate private, signed acceptance profile.
OPTIONAL_BACKENDS = {
    "drone-production": {
        "container": "onesa-drone-oracle-production-api-1",
        "product": "drone", "environment": "production",
        "url": "https://drone-api.onesa.eu/api/v1/health",
        "status": "ok", "probe": "liveness",
    },
}
KNOWN_BACKENDS = {**BACKENDS, **OPTIONAL_BACKENDS}


def drone_reader():
    specification = importlib.util.spec_from_file_location(
        "onesa_optional_drone_monitoring", Path(__file__).with_name("drone_monitoring.py")
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def accepted_drone_profile():
    return drone_reader().accepted_profile()


def sample_drone(config, previous):
    """Default-off; an invalid operator selection cannot cause a Drone request."""
    if "drone_monitoring_enabled" not in config:
        return {}
    if config["drone_monitoring_enabled"] is False:
        return {"drone_monitoring": {"status": "disabled"}}
    try:
        if config["drone_monitoring_enabled"] is not True:
            raise ValueError("Invalid optional monitor selection")
        reader = drone_reader()
        profile = reader.accepted_profile()
        name = reader.NAME
        if OPTIONAL_BACKENDS != {name: reader.TARGET}:
            raise ValueError("Optional target identity changed")
        row, matched = {}, False
        try:
            result = subprocess.run(
                ["docker", "inspect", "--type=container", reader.TARGET["container"]],
                capture_output=True, timeout=3, check=False,
            )
            rows = json.loads(result.stdout or b"[]") if len(result.stdout) <= 1024 * 1024 else []
            row = rows[0] if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) else {}
            matched = result.returncode == 0 and reader.runtime_matches(row, profile)
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            pass
        state = row.get("State", {})
        if not isinstance(state, dict):
            state, matched = {}, False
        health = state.get("Health", {})
        if not isinstance(health, dict):
            health, matched = {}, False
        count = row.get("RestartCount", 0)
        if type(count) is not int or count < 0:
            count, matched = 0, False
        probe = probe_backend(name) if matched else {
            "http_healthy": False, "http_status": 0, "http_error": "runtime_identity_changed",
        }
        if reader.accepted_profile() != profile:
            raise ValueError("Optional acceptance changed during observation")
        healthy = matched and state.get("Running") is True and state.get("OOMKilled") is False and (
            health.get("Status") == "healthy"
        )
        return {
            "drone_monitoring": {"status": "accepted-profile", "acceptance_sha256": profile["acceptance_sha256"]},
            "backends": {name: {
                **probe, "container_healthy": healthy, "loopback_only": matched,
                "restart_count": count, "restarted": count > previous.get(name, count),
            }},
            "backend_restart_counts": {name: count},
        }
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, subprocess.SubprocessError):
        return {"drone_monitoring": {"status": "activation-held"}}


def drone_profile_token(metrics):
    selected = (metrics or {}).get("drone_monitoring", {})
    if not isinstance(selected, dict):
        return None
    value = selected.get("acceptance_sha256")
    return value if selected.get("status") == "accepted-profile" and isinstance(value, str) and (
        re.fullmatch(r"[a-f0-9]{64}", value)
    ) else None


def drone_event(pending, prior=None):
    details = pending.get("metrics", {}).get("backends", {}).get("drone-production", {})
    return bool(
        pending.get("drone_acceptance_required") is True
        or pending.get("drone_acceptance_sha256")
        or "drone-production" in pending.get("recovered_backends", [])
        or details and (details.get("container_healthy") is not True or
                        details.get("http_healthy") is not True or details.get("restarted") is True)
        or prior and "drone-production" in prior.get("incident_backends", prior.get("affected_backends", {}))
    )


def drone_pending_hold(pending, metrics):
    if not drone_event(pending):
        return False
    expected = pending.get("drone_acceptance_sha256")
    if not expected or expected != drone_profile_token(metrics):
        return True
    try:
        return accepted_drone_profile()["acceptance_sha256"] != expected
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, subprocess.SubprocessError):
        return True


def evaluate(metrics):
    return {
        "worker-stopped": metrics["worker_required"] and not metrics["worker_healthy"],
        "job-retry-exhausted": metrics.get("failed_jobs", 0) > 0,
        "queue-stalled": max(
            metrics.get("queue_age_seconds", 0), metrics.get("deletion_age_seconds", 0)
        )
        > 300,
        "clamav-unavailable": not metrics.get("scanner_ready", False),
        "signature-update-failed": not metrics["signature_current"],
        "backup-failed": metrics["backup_failed"]
        or metrics["backup_age_seconds"] > 7200
        or metrics.get("database_backup_failed", False),
        "resource-exhaustion": metrics["disk_used_percent"] >= 80
        or metrics["memory_available_bytes"] < 512 * 1024 * 1024,
        "database-unavailable": not metrics.get("database_available", False),
        "worker-restarted": metrics["worker_restart_count"]
        > metrics["previous_restart_count"],
        "backend-api-unavailable": not metrics.get("backend_api_healthy", True),
        "backend-api-restarted": metrics.get("backend_api_restarted", False),
    }


def run(command, timeout=35):
    r = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    if r.returncode:
        raise ValueError("Private metric acquisition failed")
    return r.stdout


def database_backup_health(products, state, now):
    """Fail closed for missing, failed, stale or malformed configured snapshots."""
    if not products or not set(products) <= {"ai", "robot"}:
        raise ValueError("Invalid configured backup products")
    ages = {}
    failed = False
    for product in products:
        try:
            receipt = json.loads(
                (state / f"database-backup-{product}-success.json").read_text()
            )
            age = (
                now
                - datetime.datetime.fromisoformat(receipt["verified_at"]).timestamp()
            )
            valid = (
                receipt["product"] == product
                and receipt["passed"] is True
                and receipt["off_instance_storage_verified"] is True
                and receipt["consistent_snapshot"] is True
                and 0 <= age <= 7200
            )
            ages[product] = max(0, int(age))
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            valid = False
            ages[product] = None
        failed |= (
            not valid or (state / f"database-backup-{product}-failure.json").exists()
        )
    return {"database_backup_failed": failed, "database_backup_age_seconds": ages}


def probe_backend_attempt(name):
    target = KNOWN_BACKENDS[name]
    result = {"http_healthy": False, "http_status": 0}
    try:
        response = subprocess.run(
            [
                "/usr/bin/curl",
                "--disable",
                "--proto",
                "=https",
                "--silent",
                "--show-error",
                "--fail",
                "--connect-timeout",
                "3",
                "--max-time",
                "5",
                "--max-filesize",
                "512",
                "--user-agent",
                "Onesa-Service-Monitor/1.0",
                "--header",
                "Accept: application/json",
                "--write-out",
                "\n%{http_code}",
                target["url"],
            ],
            capture_output=True,
            timeout=6,
            check=False,
        )
        body, status = response.stdout.rsplit(b"\n", 1)
        result["http_status"] = int(status)
        if response.returncode:
            result["http_error"] = {
                6: "dns",
                7: "connect",
                28: "timeout",
                35: "tls",
                60: "tls",
            }.get(response.returncode, "http" if result["http_status"] else "transport")
        if (
            response.returncode == 0
            and result["http_status"] == 200
            and len(body) <= 512
        ):
            value = json.loads(body)
            result["http_healthy"] = (
                isinstance(value, dict) and value.get("status") == target["status"]
            )
            if target["product"] == "robot":
                result["http_healthy"] = result["http_healthy"] and (
                    value.get("mode") == "simulation"
                    and value.get("physical_actuation") is False
                )
            if target["product"] == "drone":
                result["http_healthy"] = result["http_healthy"] and value.get("mode") == "simulation"
    except subprocess.TimeoutExpired:
        result["http_error"] = "timeout"
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        result["http_error"] = "invalid_probe"
    return result


def probe_backend(name):
    result = probe_backend_attempt(name)
    # Retry only an unauthenticated, read-only transport failure, once. HTTP,
    # certificate and response validation failures remain visible immediately.
    if result.get("http_error") in {"dns", "connect", "timeout"}:
        result = probe_backend_attempt(name)
    return result


def sample_backends(previous):
    # One bounded Docker read plus parallel, unauthenticated liveness requests.
    # Robot readiness reads the existing background lease proof, not the database.
    # No model calls, application records, service restarts or new credentials.
    try:
        response = subprocess.run(
            ["docker", "inspect", *[value["container"] for value in BACKENDS.values()]],
            capture_output=True,
            timeout=3,
            check=False,
        )
        containers = {
            row["Name"].lstrip("/"): row for row in json.loads(response.stdout)
        }
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        containers = {}
    with ThreadPoolExecutor(max_workers=len(BACKENDS)) as pool:
        probes = dict(zip(BACKENDS, pool.map(probe_backend, BACKENDS)))
    counts, details = {}, {}
    restarted = False
    for name, target in BACKENDS.items():
        container = containers.get(target["container"], {})
        state = container.get("State", {})
        labels = container.get("Config", {}).get("Labels", {})
        bindings = container.get("HostConfig", {}).get("PortBindings", {})
        ports = [entry for entries in bindings.values() for entry in (entries or [])]
        loopback = bool(ports) and all(
            entry.get("HostIp") == "127.0.0.1" for entry in ports
        )
        healthy = (
            state.get("Running") is True
            and state.get("Health", {}).get("Status") == "healthy"
            and state.get("OOMKilled") is False
            and labels.get("org.onesa.product") == target["product"]
            and labels.get("org.onesa.environment") == target["environment"]
            and loopback
        )
        count = container.get("RestartCount", 0)
        if type(count) is not int or count < 0:
            healthy, count = False, 0
        counts[name] = count
        restarted |= count > previous.get(name, count)
        details[name] = {
            **probes[name],
            "container_healthy": healthy,
            "loopback_only": loopback,
            "restart_count": count,
            "restarted": count > previous.get(name, count),
        }
    return {
        "backend_api_healthy": all(
            v["container_healthy"] and v["http_healthy"] for v in details.values()
        ),
        "backend_api_restarted": restarted,
        "backend_restart_counts": counts,
        "backends": details,
    }


def dependency_metrics(raw, *, scanner_only=False):
    """Accept only this collector's fields; failed acquisition is not zero queue age."""
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Duplicate dependency metric")
            value[key] = item
        return value

    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict) or type(value.get("scanner_ready")) is not bool:
        raise ValueError("Invalid scanner metric")
    if scanner_only:
        if set(value) != {"scanner_ready"}:
            raise ValueError("Unexpected scanner-only metrics")
        return value
    if type(value.get("database_available")) is not bool:
        raise ValueError("Invalid database metric")
    expected = {"database_available", "scanner_ready"}
    if value["database_available"]:
        expected.update({"failed_jobs", "queue_age_seconds", "deletion_age_seconds"})
        count = value.get("failed_jobs")
        if type(count) is not int or not 0 <= count <= 2**53 - 1:
            raise ValueError("Invalid failed-job count")
        for key in ("queue_age_seconds", "deletion_age_seconds"):
            age = value.get(key)
            if type(age) not in (int, float) or not math.isfinite(age):
                raise ValueError("Invalid queue age")
    if set(value) != expected:
        raise ValueError("Unexpected dependency metrics")
    return value


class ProbeCleanupFailed(ValueError):
    """An interrupted disposable probe was not proved absent or removed."""


def dependency_probe_marker():
    state = STATE.lstat()
    if (not stat.S_ISDIR(state.st_mode) or state.st_uid != os.geteuid()
            or stat.S_IMODE(state.st_mode) != 0o700):
        raise ProbeCleanupFailed("Private metric probe custody required")
    return STATE / "dependency-probe.json"


@contextmanager
def dependency_probe_lock():
    path = dependency_probe_marker().with_suffix(".lock")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ProbeCleanupFailed("Private metric probe lock required")
        # A concurrent observer cannot mistake a currently running probe for an
        # interrupted one. The kernel releases this lock if the process dies.
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def validate_dependency_probe(value):
    if not (
        isinstance(value, dict)
        and set(value) == {"schema_version", "name", "owner", "image", "command"}
        and type(value["schema_version"]) is int and value["schema_version"] == 1
        and isinstance(value["owner"], str) and re.fullmatch(r"[a-f0-9]{32}", value["owner"])
        and value["name"] == "onesa-metrics-" + value["owner"]
        and isinstance(value["image"], str) and len(value["image"]) <= 256
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:+-]*(?:@sha256:[a-f0-9]{64})?", value["image"])
        and value["command"] in (["metrics.mjs"], ["metrics.mjs", "--scanner-only"])
    ):
        raise ProbeCleanupFailed("Metric probe custody invalid")
    return value


def read_dependency_probe():
    path = dependency_probe_marker()
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or not 0 < info.st_size <= 4096):
            raise ProbeCleanupFailed("Private metric probe record required")
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ProbeCleanupFailed("Metric probe record too large")
    return validate_dependency_probe(json.loads(raw))


def sync_dependency_probe_directory():
    descriptor = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def retain_dependency_probe(value):
    validate_dependency_probe(value)
    path = dependency_probe_marker()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
        stream.flush()
        os.fsync(stream.fileno())
    sync_dependency_probe_directory()


def clear_dependency_probe(value):
    if read_dependency_probe() != value:
        raise ProbeCleanupFailed("Metric probe custody changed")
    dependency_probe_marker().unlink()
    sync_dependency_probe_directory()


def cleanup_dependency_probe(name, owner, image, command):
    """Remove only this invocation's positively identified disposable probe.

    Docker --rm handles normal exits, but a killed CLI can leave a Created
    container. Never enumerate, adopt or remove a historical probe or service.
    Only bounded metadata is read; environment values cannot enter diagnostics.
    """
    if not (isinstance(owner, str) and re.fullmatch(r"[a-f0-9]{32}", owner)
            and name == "onesa-metrics-" + owner
            and command in (["metrics.mjs"], ["metrics.mjs", "--scanner-only"])):
        return False
    try:
        inspected = subprocess.run(
            ["docker", "inspect", "--type=container", "--format", PROBE_INSPECT_FORMAT, name],
            capture_output=True, timeout=PROBE_CLEANUP_COMMAND_SECONDS, check=False,
        )
        if inspected.returncode:
            # A killed CLI can leave a create request running in the daemon.
            # The name may not be inspectable until later registration. Absence
            # without a positively observed ID never resolves creation custody.
            return False
        if len(inspected.stdout) > 4096:
            return False
        value = json.loads(inspected.stdout)
        if not (
            isinstance(value, dict)
            and isinstance(value.get("id"), str)
            and re.fullmatch(r"[a-f0-9]{64}", value["id"])
            and value.get("name") == "/" + name
            and value.get("owner") == owner
            and value.get("image") == image
            and value.get("entrypoint") == ["node"]
            and value.get("command") == command
            and value.get("auto_remove") is True
            and value.get("read_only") is True
        ):
            return False
        removed = subprocess.run(
            ["docker", "rm", "--force", value["id"]],
            capture_output=True, timeout=PROBE_CLEANUP_COMMAND_SECONDS, check=False,
        )
        if removed.returncode == 0:
            return removed.stdout.strip() == value["id"].encode()
        # The original --rm can finish between inspection and exact-ID removal.
        return removed.stderr.strip() in {
            ("Error: No such object: " + value["id"]).encode(),
            ("Error: No such container: " + value["id"]).encode(),
        }
    except (ValueError, TypeError, OSError, subprocess.SubprocessError):
        return False


def run_dependency_probe(command, *, timeout):
    owner = uuid.uuid4().hex
    name = "onesa-metrics-" + owner
    owned_command = command[:3] + [
        "--name", name, "--label", PROBE_OWNER_LABEL + "=" + owner,
    ] + command[3:]
    image_index = command.index("--entrypoint") + 2
    pending = {
        "schema_version": 1, "name": name, "owner": owner,
        "image": command[image_index], "command": command[image_index + 1:],
    }
    try:
        retain_dependency_probe(pending)
    except (ValueError, TypeError, OSError):
        raise ProbeCleanupFailed("Metric probe intent not durably retained") from None
    try:
        raw = run(owned_command, timeout=timeout)
    except BaseException as error:
        try:
            if not cleanup_dependency_probe(name, owner, pending["image"], pending["command"]):
                raise ProbeCleanupFailed("Disposable metric probe cleanup unresolved")
            clear_dependency_probe(pending)
        except (ValueError, TypeError, OSError):
            if isinstance(error, Exception):
                raise ProbeCleanupFailed("Disposable metric probe cleanup unresolved") from None
        raise
    try:
        clear_dependency_probe(pending)
    except (ValueError, TypeError, OSError):
        raise ProbeCleanupFailed("Metric probe completion not durably retained") from None
    return raw


def sample_dependencies(config):
    try:
        with dependency_probe_lock():
            return sample_dependencies_locked(config)
    except BlockingIOError:
        return {"database_available": False, "scanner_ready": False,
                "dependency_probe_busy": True}
    except (ValueError, TypeError, OSError):
        return {"database_available": False, "scanner_ready": False,
                "dependency_probe_cleanup_failed": True}


def sample_dependencies_locked(config):
    try:
        pending = read_dependency_probe()
        if pending is not None:
            if not cleanup_dependency_probe(
                pending["name"], pending["owner"], pending["image"], pending["command"],
            ):
                raise ProbeCleanupFailed("Pending metric probe cleanup unresolved")
            clear_dependency_probe(pending)
            # Keep recovery's I/O separate from a new probe's deadline budget.
            return {"database_available": False, "scanner_ready": False,
                    "dependency_probe_recovery_only": True}
    except (ValueError, TypeError, OSError):
        return {"database_available": False, "scanner_ready": False,
                "dependency_probe_cleanup_failed": True}
    command = [
        "docker", "run", "--rm", "-i", "--read-only", "--tmpfs", "/tmp",
        "--memory", "128m", "--cpus", "0.1", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--env-file",
        "/etc/onesa/portal-production.env", "-e",
        "CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock", "--group-add", "3000",
        "-v", "onesa-portal-oracle-staging_scanner_socket:/run/onesa-scanner:ro",
        "-v", str(Path(__file__).parents[3] / "scripts/oracle_metrics.mjs")
        + ":/app/metrics.mjs:ro", "--entrypoint", "node", config["image"], "metrics.mjs",
    ]
    try:
        return dependency_metrics(run_dependency_probe(command, timeout=20))
    except ProbeCleanupFailed:
        # Do not create a second probe when the first one's outcome is unknown.
        return {"database_available": False, "scanner_ready": False,
                "dependency_probe_cleanup_failed": True}
    except (ValueError, TypeError, OverflowError, OSError, subprocess.SubprocessError):
        # A whole-client failure says nothing about the scanner. One short,
        # database-free attempt uses the same image, consumer permissions and
        # read-only marker mount. No extra client runs on the normal path.
        result = {"database_available": False, "scanner_ready": False}
        try:
            result.update(dependency_metrics(
                run_dependency_probe(command + ["--scanner-only"], timeout=SCANNER_FALLBACK_SECONDS),
                scanner_only=True,
            ))
        except ProbeCleanupFailed:
            result["dependency_probe_cleanup_failed"] = True
        except (ValueError, TypeError, OverflowError, OSError, subprocess.SubprocessError):
            pass
        return result


def sample(config):
    def inspect(name):
        try:
            return json.loads(run(["docker", "inspect", name], timeout=3))[0]
        except (ValueError, subprocess.SubprocessError):
            return {}

    worker = inspect("onesa-portal-oracle-production-worker-1")
    scanner = inspect("onesa-portal-oracle-staging-scanner-1")
    worker_running = worker.get("State", {}).get("Running")
    worker_health = worker.get("State", {}).get("Health", {}).get("Status")
    mem = {
        l.split(":", 1)[0]: int(l.split()[1]) * 1024
        for l in Path("/proc/meminfo").read_text().splitlines()
    }
    disk = shutil.disk_usage("/")
    previous = (
        json.loads((STATE / "metrics.json").read_text())
        if (STATE / "metrics.json").exists()
        else {}
    )
    metrics = {
        "worker_required": config["worker_required"],
        "worker_healthy": worker_health == "healthy",
        "worker_running": worker_running if type(worker_running) is bool else None,
        "worker_health_status": worker_health
        if isinstance(worker_health, str) and worker_health
        in {"healthy", "unhealthy", "starting"} else "unknown",
        "worker_restart_count": worker.get("RestartCount", 0),
        "previous_restart_count": previous.get(
            "worker_restart_count", worker.get("RestartCount", 0)
        ),
        "disk_used_percent": round(disk.used / disk.total * 100, 2),
        "memory_available_bytes": mem["MemAvailable"],
        "signature_current": False,
        "backup_failed": (STATE / "backup-failure.json").exists(),
        "backup_age_seconds": float("inf"),
    }
    if (STATE / "backup-success.json").exists():
        saved = json.loads((STATE / "backup-success.json").read_text())
        metrics["backup_age_seconds"] = (
            time.time()
            - datetime.datetime.fromisoformat(saved["verified_at"]).timestamp()
        )
    if Path("/etc/onesa/database-backups.json").exists():
        try:
            from database_snapshots import CONFIG, private_json

            profiles = private_json(CONFIG)["products"]
            metrics.update(database_backup_health(profiles, STATE, time.time()))
        except (OSError, ValueError, TypeError, KeyError):
            metrics["database_backup_failed"] = True
    try:
        run(
            [
                "docker",
                "exec",
                scanner["Name"].lstrip("/"),
                "sh",
                "-c",
                'test -n "$(find /var/lib/clamav -maxdepth 1 -type f \\( -name daily.cvd -o -name daily.cld \\) -mmin -2880 -print -quit)" && pgrep freshclam >/dev/null',
            ],
            timeout=3,
        )
        metrics["signature_current"] = True
    except (KeyError, ValueError, subprocess.SubprocessError):
        pass
    # These independent reads overlap so a retried public probe still leaves
    # room for notification delivery within the existing 60-second service limit.
    # Join before returning; incident state and delivery remain on the main thread.
    with ThreadPoolExecutor(max_workers=1) as pool:
        backends = (
            pool.submit(sample_backends, previous.get("backend_restart_counts", {}))
            if config.get("backend_monitoring_enabled") is True
            else None
        )
        metrics.update(sample_dependencies(config))
        if backends is not None:
            metrics.update(backends.result())
    optional = sample_drone(config, previous.get("backend_restart_counts", {}))
    if "drone_monitoring" in optional:
        metrics["drone_monitoring"] = optional["drone_monitoring"]
    if "backends" in optional:
        metrics.setdefault("backends", {}).update(optional["backends"])
        metrics.setdefault("backend_restart_counts", {}).update(optional["backend_restart_counts"])
        values = optional["backends"].values()
        metrics["backend_api_healthy"] = metrics.get("backend_api_healthy", True) and all(
            value["container_healthy"] and value["http_healthy"] for value in values
        )
        metrics["backend_api_restarted"] = metrics.get("backend_api_restarted", False) or any(
            value["restarted"] for value in optional["backends"].values()
        )
    return metrics


def failed_backends(metrics):
    """Only fixed service identities and bounded health fields leave private metrics."""
    details = metrics.get("backends", {})
    result = {}
    for name in KNOWN_BACKENDS:
        value = details.get(name)
        if not isinstance(value, dict):
            continue
        if value.get("container_healthy") is True and value.get("http_healthy") is True:
            continue
        status = value.get("http_status", 0)
        result[name] = {
            "container_healthy": value.get("container_healthy") is True,
            "http_healthy": value.get("http_healthy") is True,
            "http_status": status if type(status) is int and 0 <= status <= 599 else 0,
            "probe": KNOWN_BACKENDS[name]["probe"],
        }
    return result


def write_record(path, value):
    """Persist private bytes and their atomic rename before any provider side effect."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=path.name + ".", suffix=".tmp", delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(json.dumps(value, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def notification_metrics(metrics):
    """Project known API environments before decisions; shared dependencies stay in scope.

    Worker/SQL/queue metrics use portal-production.env. The scanner socket is shared
    with that production worker despite its historical staging container name. Disk,
    memory and configured backups also serve production. Only the fixed staging API
    targets are excluded; unknown aggregate failures are retained, never guessed away.
    """
    result = dict(metrics)
    details = metrics.get("backends")
    if isinstance(details, dict):
        eligible = {
            name: value
            for name, value in details.items()
            if KNOWN_BACKENDS.get(name, {}).get("environment") != "staging"
        }
        result["backends"] = eligible
        if details and set(details) <= set(KNOWN_BACKENDS):
            result["backend_api_healthy"] = all(
                value.get("container_healthy") is True
                and value.get("http_healthy") is True
                for value in eligible.values()
            )
            if not eligible or all("restarted" in value for value in details.values()):
                result["backend_api_restarted"] = any(
                    value.get("restarted") is True for value in eligible.values()
                )
    counts = metrics.get("backend_restart_counts")
    if isinstance(counts, dict):
        result["backend_restart_counts"] = {
            name: count
            for name, count in counts.items()
            if KNOWN_BACKENDS.get(name, {}).get("environment") != "staging"
        }
    return result


def notification_alerts(alerts, metrics):
    """Project stored rules as well as current metrics without changing their history."""
    scoped = notification_metrics(metrics)
    return [
        rule
        for rule in alerts
        if not (
            rule == "backend-api-unavailable"
            and scoped.get("backend_api_healthy") is True
            or rule == "backend-api-restarted"
            and scoped.get("backend_api_restarted") is False
        )
    ]


def notification_history(last):
    """Read a scoped view; never rewrite old receipts or reset their cooldown clock."""
    if not last or last.get("kind") == "recovery":
        return last
    names = set(last.get("incident_backends", last.get("affected_backends", {})))
    names.update(last.get("affected_backends", {}))
    historical_metrics = {
        "backends": {
            name: {"container_healthy": False, "http_healthy": False, "restarted": True}
            for name in names
        }
    }
    rules = notification_alerts(last.get("rules", []), historical_metrics)
    incident_rules = notification_alerts(
        last.get("incident_rules", last.get("rules", [])), historical_metrics
    )
    if not rules and not incident_rules:
        return {}
    return {
        **last,
        "rules": rules or incident_rules,
        "incident_rules": incident_rules,
        "affected_backends": {
            name: value
            for name, value in last.get("affected_backends", {}).items()
            if KNOWN_BACKENDS.get(name, {}).get("environment") != "staging"
        },
        "incident_backends": sorted(
            name
            for name in names
            if KNOWN_BACKENDS.get(name, {}).get("environment") != "staging"
        ),
    }


def previous_notification_state(previous, last):
    scoped = previous.get("notification_state", {})
    if scoped.get("scope") == NOTIFICATION_SCOPE:
        return scoped
    metrics = notification_metrics(previous.get("metrics", {}))
    alerts = notification_alerts(previous.get("alerts", []), metrics)
    # Migrate silently. Staging-only incidents cannot open or recover an emailed
    # incident. Mixed incidents retain eligible history and its original timestamps;
    # require fresh sustained health instead of inferring it from a raw staging streak.
    return {
        "checked_at": previous.get("checked_at"),
        "alerts": alerts,
        "metrics": metrics,
        "healthy_samples": 0,
        "incident_open": bool(alerts)
        or bool(last.get("rules"))
        and incident_open(previous),
    }


def pending_scope_hold(pending):
    """Changed legacy payloads need reconciliation, never a rewritten idempotent retry."""
    metrics = pending["metrics"]
    return (
        notification_alerts(pending["alerts"], metrics) != pending["alerts"]
        or set(failed_backends(metrics))
        != set(failed_backends(notification_metrics(metrics)))
        or any(
            KNOWN_BACKENDS.get(name, {}).get("environment") == "staging"
            for name in pending.get("recovered_backends", [])
        )
    )


def incident_open(previous):
    # A clean legacy baseline must not create a retrospective recovery email.
    return previous.get(
        "incident_open",
        bool(previous.get("alerts")) or previous.get("healthy_samples") == 1,
    )


def observation_age(checked_at, now):
    """Missing, invalid or future times cannot bypass a notification hold."""
    try:
        stamp = datetime.datetime.fromisoformat(checked_at)
        if stamp.utcoffset() is None:
            return None
        age = now - stamp.timestamp()
        return age if age >= 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def continuous_health(previous, now):
    gap = observation_age(previous.get("checked_at"), now)
    return (
        not previous.get("alerts") and gap is not None and gap <= MAX_SAMPLE_GAP_SECONDS
    )


def transport_confirmation(alerts, metrics, previous, now):
    """Keep raw failures; confirm only transport-only email incidents per API.

    A single missed public probe must not create an alert/recovery email pair.
    Explicit HTTP/TLS failures, unhealthy containers and shared-service failures
    bypass this hold. Counts cannot combine different services, rapid invocations,
    clock rollback or missing observations into a confirmed outage.
    """
    failed = failed_backends(metrics)
    details = metrics.get("backends", {})
    transient = {
        name
        for name, value in failed.items()
        if value["container_healthy"]
        and value["http_status"] == 0
        and details[name].get("http_error", "transport")
        in {"dns", "connect", "timeout", "transport"}
    }
    gap = observation_age(previous.get("checked_at"), now)
    streaks = {}
    confirmed = False
    for name in transient:
        prior = previous.get("transport_failures", {}).get(name, {})
        since = observation_age(prior.get("since"), now)
        continuous = (
            gap is not None and 0 < gap <= MAX_SAMPLE_GAP_SECONDS and since is not None
        )
        count = prior.get("samples", 0) if continuous else 0
        if type(count) is not int or not 0 <= count <= TRANSPORT_FAILURE_SAMPLES:
            count = 0
        streaks[name] = {
            "samples": min(TRANSPORT_FAILURE_SAMPLES, count + 1),
            "since": prior["since"]
            if count
            else datetime.datetime.fromtimestamp(
                now, datetime.timezone.utc
            ).isoformat(),
        }
        confirmed |= (
            count + 1 >= TRANSPORT_FAILURE_SAMPLES
            and (since or 0) >= TRANSPORT_FAILURE_SECONDS
        )
    return streaks, (
        alerts != ["backend-api-unavailable"]
        or not failed
        or set(failed) != transient
        or confirmed
    )


def notification_decision(
    alerts,
    metrics,
    previous,
    last,
    now,
    *,
    cooldown_seconds=UPDATE_SECONDS,
    transport_confirmed=True,
):
    """Group incident changes and require sustained health before closing one."""
    if (
        type(cooldown_seconds) is not int
        or not 60 <= cooldown_seconds <= REMINDER_SECONDS
    ):
        raise ValueError("Invalid notification cooldown")
    healthy_samples = 0
    if not alerts:
        healthy_samples = (
            min(RECOVERY_SAMPLES, previous.get("healthy_samples", 0) + 1)
            if continuous_health(previous, now)
            else 1
        )
    if not alerts:
        recovered = (
            incident_open(previous)
            and healthy_samples == RECOVERY_SAMPLES
            and (observation_age(previous.get("healthy_since"), now) or 0)
            >= RECOVERY_SECONDS
            and last.get("rules")
            and last.get("kind", "alert") != "recovery"
        )
        return ("recovery" if recovered else None), healthy_samples
    if (
        not last
        or last.get("kind") == "recovery"
        or previous.get("incident_open") is False
    ):
        return ("alert" if transport_confirmed else None), 0
    added_failures = bool(
        set(alerts) - set(last.get("incident_rules", last.get("rules", [])))
        or set(failed_backends(metrics))
        - set(last.get("incident_backends", last.get("affected_backends", {})))
    )
    age = observation_age(last.get("checked_at"), now) or 0
    if added_failures and age >= cooldown_seconds:
        return "update", 0
    # Partial improvement is retained in metrics, without another email.
    return ("reminder" if age >= REMINDER_SECONDS else None), 0


def worker_notification_detail(alerts, metrics):
    """Describe only worker details captured in this event's observation."""
    if "worker-stopped" not in alerts or not isinstance(metrics, dict):
        return ""
    running, health = metrics.get("worker_running"), metrics.get("worker_health_status")
    if type(running) is not bool or not isinstance(health, str) or health not in {
        "healthy", "unhealthy", "starting", "unknown"
    }:
        return ""
    return (
        "\nWorker is running; health status: " if running
        else "\nWorker is not running; last health status: "
    ) + health + "."


def unique_mail_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate mail configuration field")
        result[key] = value
    return result


def sender_mailbox(value):
    """Accept one mailbox, preserving a valid configured header byte for byte."""
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 320
        or value != value.strip()
        or not all(character.isprintable() for character in value)
    ):
        raise ValueError("Invalid operations mail sender")
    address = value
    if "<" in value or ">" in value:
        match = re.fullmatch(r'([^<>,;:@"\\]+) <([^<>]+)>', value)
        if not match or match[1] != match[1].strip():
            raise ValueError("Invalid operations mail sender")
        address = match[2]
    if len(address) > 254 or not re.fullmatch(
        r"[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]{1,64}@"
        r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
        r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+",
        address,
    ):
        raise ValueError("Invalid operations mail sender")
    local = address.split("@", 1)[0]
    if local.startswith(".") or local.endswith(".") or ".." in local:
        raise ValueError("Invalid operations mail sender")
    return address


def configured_product_senders(values, *, allow_drone=False):
    raw = values.get("OPERATIONS_MAIL_FROM_BY_PRODUCT", "")
    if raw == "":
        return {}
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ValueError("Invalid operations product sender mapping")
    try:
        mapping = json.loads(raw, object_pairs_hook=unique_mail_object)
        allowed = MAIL_PRODUCTS | ({"drone"} if allow_drone else set())
        if not isinstance(mapping, dict) or not set(mapping) <= allowed:
            raise ValueError
        for product, sender in mapping.items():
            if sender_mailbox(sender) not in {
                f"notifications-{product}@onesa.eu", f"alerts-{product}@onesa.eu"
            }:
                raise ValueError
    except (ValueError, TypeError):
        raise ValueError("Invalid operations product sender mapping") from None
    return mapping


def notification_product(alerts, metrics, kind, recovered_backends, prior_incident):
    """Only a fully known, single-product API incident can select another sender."""
    if kind == "simulation" or set(alerts) - API_ALERT_RULES:
        return None
    details = (metrics or {}).get("backends", {})
    if (
        not isinstance(details, dict)
        or not set(details) <= set(KNOWN_BACKENDS)
        or any(not isinstance(value, dict) for value in details.values())
    ):
        return None
    names = set(failed_backends(metrics or {}))
    if "backend-api-unavailable" in alerts and not names:
        return None
    if "backend-api-restarted" in alerts:
        restarted = {
            name for name, value in details.items()
            if isinstance(value, dict) and value.get("restarted") is True
        }
        if not restarted:
            return None
        names.update(restarted)
    if kind == "recovery":
        names.update(recovered_backends)
    products = set()
    if kind in {"update", "reminder", "recovery"}:
        if not prior_incident:
            return None
        if "notification_product" in prior_incident:
            previous_product = prior_incident["notification_product"]
            if previous_product not in MAIL_PRODUCTS | {"drone"}:
                return None
            products.add(previous_product)
        else:
            previous_rules = prior_incident.get(
                "incident_rules", prior_incident.get("rules", [])
            )
            previous_names = prior_incident.get(
                "incident_backends", prior_incident.get("affected_backends", {})
            )
            if (
                not previous_rules
                or set(previous_rules) - API_ALERT_RULES
                or not previous_names
            ):
                return None
            names.update(previous_names)
    if any(
        name not in KNOWN_BACKENDS or KNOWN_BACKENDS[name]["environment"] != "production"
        for name in names
    ):
        return None
    products.update(KNOWN_BACKENDS[name]["product"] for name in names)
    if "drone" in products and not drone_profile_token(metrics):
        return None
    return next(iter(products)) if len(products) == 1 else None


def operations_email_html_v1(subject, text, kind, simulation, product):
    """New envelopes only. Retained v1/plain or v2/HTML bytes are never re-rendered."""
    escape = html.escape
    title = "Notification routing check" if simulation else {
        "recovery": "Service recovered", "update": "Incident update",
        "reminder": "An incident still needs attention", "alert": "Service needs attention",
    }.get(kind, "Infrastructure notification")
    badge = "Controlled test" if simulation else "Recovered" if kind == "recovery" else "Action required"
    color, background = ("#1d5275", "#eaf4fa") if simulation else ("#14552d", "#e6f5ec") if kind == "recovery" else ("#684110", "#fff0d6")
    name = {"portal": "Onesa Portal", "ai": "Onesa AI", "robot": "Onesa Robot", "drone": "Onesa Drone"}.get(product, "Onesa Infrastructure")
    # Body and event classification are already produced by the existing monitor.
    # HTML adds hierarchy; it cannot change recipient, event identity or observations.
    rows = "".join('<p class="copy" style="margin:0 0 12px;color:#10263e;font-size:14px;line-height:23px;overflow-wrap:anywhere;word-break:break-word;">' + escape(line) + '</p>' for line in text.splitlines() if line)
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>{escape(subject)}</title><style>table{{border-collapse:collapse}}@media(max-width:480px){{.outer{{padding:20px 10px!important}}.pad{{padding:26px 24px!important}}h1{{font-size:29px!important}}}}@media(prefers-color-scheme:dark){{.canvas{{background-color:#0b1523!important}}.card{{background-color:#14243a!important}}.copy,h1{{color:#e5edf6!important}}.muted{{color:#b4c4d6!important}}.panel{{background-color:#0b1523!important;border-color:#557a9e!important}}}}</style></head>
<body class="canvas" style="margin:0;background-color:#edf2f7;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{escape(title)} · {escape(name)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]--><table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;table-layout:fixed;background-color:#fff;border:1px solid #dae1e9;border-radius:12px;overflow:hidden;"><tr><td class="pad" bgcolor="#10263e" style="padding:28px 36px;background-color:#10263e;border-bottom:4px solid #2366d1;"><p style="margin:0;color:#fff;font-size:22px;font-weight:bold;letter-spacing:3px;">ONESA</p><p style="margin:12px 0 0;color:#b4c4d6;font-size:13px;line-height:20px;">{escape(name)}</p></td></tr><tr><td class="pad" style="padding:34px 36px;overflow-wrap:anywhere;word-break:break-word;"><p class="muted" style="margin:0 0 14px;color:#56677b;font-size:11px;letter-spacing:1.8px;font-weight:bold;">INFRASTRUCTURE &amp; OPERATIONS</p><h1 style="margin:0 0 20px;color:#10263e;font-size:34px;line-height:1.16;letter-spacing:-0.7px;">{escape(title)}</h1><p style="margin:0 0 24px;"><span style="display:inline-block;padding:7px 11px;border-radius:4px;font-size:12px;line-height:18px;font-weight:bold;color:{color};background-color:{background};">{escape(badge)}</span></p><div class="panel" style="padding:20px;background-color:#f5f7fa;border-left:3px solid #2366d1;">{rows}</div></td></tr><tr><td class="pad panel" style="padding:22px 36px;border-top:1px solid #dae1e9;"><p class="muted" style="margin:0 0 6px;color:#56677b;font-size:11px;line-height:18px;font-weight:bold;">Onesa Infrastructure</p><p class="muted" style="margin:0;color:#56677b;font-size:11px;line-height:18px;">Sent to the configured infrastructure notification mailbox. Keep the event reference when investigating this message.</p></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>'''


def mail_credential_fingerprint(values):
    key = values.get("RESEND_API_KEY")
    if (
        values.get("MAIL_PROVIDER") != "resend"
        or not isinstance(key, str)
        or not 1 <= len(key) <= 4096
        or key != key.strip()
        or not all(33 <= ord(character) <= 126 for character in key)
    ):
        raise ValueError("Existing approved Resend configuration required")
    return hashlib.sha256(
        b"onesa-operations-resend-credential-v1\0" + key.encode("utf-8")
    ).hexdigest()


def validated_mail_envelope(envelope, reference, kind, simulation=False):
    """Validate stored bytes without rebuilding them from current code or settings."""
    if not isinstance(envelope, dict) or set(envelope) != {
        "version", "reference", "kind", "simulation", "body", "body_sha256",
        "credential_fingerprint", "notification_product",
    }:
        raise ValueError("Unbound operations mail envelope")
    body = envelope["body"]
    if (
        type(envelope["version"]) is not int
        or envelope["version"] not in {1, MAIL_ENVELOPE_VERSION}
        or envelope["reference"] != reference
        or str(uuid.UUID(reference)) != reference
        or kind not in NOTIFICATION_KINDS
        or envelope["kind"] != kind
        or type(envelope["simulation"]) is not bool
        or envelope["simulation"] != simulation
        or envelope["notification_product"] not in MAIL_PRODUCTS | {"drone", None}
        or not isinstance(body, str)
        or not 0 < len(body.encode("utf-8")) <= MAIL_BODY_MAX_BYTES
        or not isinstance(envelope["body_sha256"], str)
        or not hmac.compare_digest(
            envelope["body_sha256"], hashlib.sha256(body.encode("utf-8")).hexdigest()
        )
        or not isinstance(envelope["credential_fingerprint"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", envelope["credential_fingerprint"])
    ):
        raise ValueError("Invalid operations mail envelope")
    data = json.loads(body, object_pairs_hook=unique_mail_object)
    if (
        not isinstance(data, dict)
        or set(data) != ({"from", "to", "reply_to", "subject", "text"} | ({"html"} if envelope["version"] == 2 else set()))
        or (envelope["version"] == 2 and (not isinstance(data.get("html"), str) or not data["html"].startswith("<!doctype html>")))
        or not isinstance(data["to"], list)
        or len(data["to"]) != 1
        or not isinstance(data["to"][0], str)
        or data["to"][0] not in MAIL_RECIPIENTS
        or data["reply_to"] != "info@onesa.eu"
        or not isinstance(data["subject"], str)
        or not 1 <= len(data["subject"]) <= 200
        or not all(character.isprintable() for character in data["subject"])
        or not isinstance(data["text"], str)
        or not data["text"].endswith("\nReference: " + reference)
    ):
        raise ValueError("Invalid operations mail envelope")
    sender_mailbox(data["from"])
    return data


def pending_envelope_hold(pending):
    try:
        validated_mail_envelope(
            pending.get("mail_envelope"), pending["reference"], pending["kind"]
        )
        from backup import checked_env

        values, _ = checked_env()
        return not hmac.compare_digest(
            pending["mail_envelope"]["credential_fingerprint"],
            mail_credential_fingerprint(values),
        )
    except (ValueError, TypeError, KeyError):
        # Unknown legacy sender/account cannot be inferred from today's settings.
        return True


def prepare_notification_request(
    alerts,
    simulation=False,
    *,
    metrics=None,
    checked_at=None,
    reference=None,
    kind="alert",
    recovered_backends=(),
    prior_incident=None,
):
    from backup import checked_env

    values, _ = checked_env()
    fingerprint = mail_credential_fingerprint(values)
    recipient = values.get("OPERATIONS_NOTIFY_EMAIL", values.get("NOTIFY_EMAIL"))
    if recipient not in MAIL_RECIPIENTS:
        raise ValueError("Existing approved notification destination required")
    sender_mailbox(values.get("MAIL_FROM"))
    # A valid optional sender name does not activate the target or suppress mail
    # for existing products when Drone enrollment is disabled/held.
    mapping = configured_product_senders(values, allow_drone=True)
    reference = reference or str(uuid.uuid4())
    if str(uuid.UUID(reference)) != reference or kind not in NOTIFICATION_KINDS:
        raise ValueError("Invalid notification event")
    product = None if simulation else notification_product(
        alerts, metrics, kind, recovered_backends, prior_incident
    )
    subject = (
        "ONESA operations qualification — synthetic alert"
        if simulation
        else "ONESA service operations recovery"
        if kind == "recovery"
        else "ONESA service operations alert"
    )
    data = {
        "from": mapping.get(product, values["MAIL_FROM"]),
        "to": [recipient],
        "reply_to": "info@onesa.eu",
        "subject": subject,
        "text": (
            "Controlled nondestructive metric simulations. No actual service was stopped.\n"
            if simulation
            else ""
        )
        + (
            "Recovered: at least five minutes of health across six consecutive samples.\n"
            if kind == "recovery"
            else "State: " + kind + "\n"
        )
        + "\n".join(alerts)
        + worker_notification_detail(alerts, metrics)
        + ("\nObserved at (UTC): " + checked_at if checked_at else "")
        + "".join(
            "\nAffected API: "
            + name
            + "; container="
            + ("healthy" if value["container_healthy"] else "unhealthy")
            + "; public HTTPS="
            + str(value["http_status"])
            + " ("
            + value["probe"]
            + ")"
            + (" (failed health validation)" if not value["http_healthy"] else "")
            for name, value in failed_backends(metrics or {}).items()
        )
        + "".join(
            "\nRecovered API: " + name
            for name in KNOWN_BACKENDS
            if name in recovered_backends
        )
        + "\nReference: "
        + reference,
    }
    data["html"] = operations_email_html_v1(subject, data["text"], kind, simulation, product)
    body = json.dumps(data)
    envelope = {
        "version": MAIL_ENVELOPE_VERSION,
        "reference": reference,
        "kind": kind,
        "simulation": simulation,
        "notification_product": product,
        "body": body,
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "credential_fingerprint": fingerprint,
    }
    validated_mail_envelope(envelope, reference, kind, simulation)
    return envelope


def notify(
    alerts,
    simulation=False,
    *,
    metrics=None,
    checked_at=None,
    reference=None,
    kind="alert",
    recovered_backends=(),
    mail_envelope=None,
):
    from backup import checked_env

    if mail_envelope is None:
        mail_envelope = prepare_notification_request(
            alerts, simulation, metrics=metrics, checked_at=checked_at,
            reference=reference, kind=kind, recovered_backends=recovered_backends,
        )
        reference = mail_envelope["reference"]
    data = validated_mail_envelope(mail_envelope, reference, kind, simulation)
    values, _ = checked_env()
    if not hmac.compare_digest(
        mail_envelope["credential_fingerprint"], mail_credential_fingerprint(values)
    ):
        raise ValueError("Pending mail credential changed; reconciliation required")
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=mail_envelope["body"].encode("utf-8"),
        headers={
            "Authorization": "Bearer " + values["RESEND_API_KEY"],
            "User-Agent": "Onesa-Portal-Operations/1.0",
            "Content-Type": "application/json",
            "Idempotency-Key": "onesa-operations/" + reference,
        },
        method="POST",
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as r:
        receipt = json.load(r)
    if not isinstance(receipt.get("id"), str):
        raise TypeError("Notification receipt absent")
    return {
        "reference": reference,
        "kind": kind,
        "checked_at": checked_at,
        "affected_backends": failed_backends(metrics or {}),
        "provider_receipt_id": receipt["id"],
        "recipient": data["to"][0],
        "sender": data["from"],
        "mail_body_sha256": mail_envelope["body_sha256"],
        "notification_product": mail_envelope["notification_product"],
        "provider_accepted": True,
        "delivery_verified": False,
        "rules": alerts,
        "simulation": simulation,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulate", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Root-only private monitor required")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = json.loads(Path("/etc/onesa/operations.json").read_text())
    metrics = sample(config)
    if args.simulate:
        metrics.update(
            worker_required=True,
            worker_healthy=False,
            failed_jobs=1,
            queue_age_seconds=301,
            scanner_ready=False,
            signature_current=False,
            backup_failed=True,
            disk_used_percent=81,
            database_available=False,
            worker_restart_count=metrics["previous_restart_count"] + 1,
            backend_api_healthy=False,
            backend_api_restarted=True,
        )
    alerts = [key for key, value in evaluate(metrics).items() if value]
    if args.simulate and set(alerts) != set(RULES):
        raise ValueError("Fault simulation incomplete")
    last = STATE / "notification.json"
    now = time.time()
    record = {
        "checked_at": datetime.datetime.fromtimestamp(
            now, datetime.timezone.utc
        ).isoformat(),
        "metrics": metrics,
        "alerts": alerts,
        "simulation": args.simulate,
        "delivery_verified": False,
    }
    path = STATE / ("simulation.json" if args.simulate else "metrics.json")
    previous = json.loads(path.read_text()) if path.exists() else {}
    last_notification = notification_history(
        json.loads(last.read_text()) if last.exists() else {}
    )
    scoped_metrics = notification_metrics(metrics)
    scoped_alerts = notification_alerts(alerts, scoped_metrics)
    scoped_previous = previous_notification_state(previous, last_notification)
    transport_failures, transport_confirmed = transport_confirmation(
        scoped_alerts, scoped_metrics, scoped_previous, now
    )
    notification_state = {
        "scope": NOTIFICATION_SCOPE,
        "checked_at": record["checked_at"],
        "metrics": scoped_metrics,
        "alerts": scoped_alerts,
        "incident_open": (bool(scoped_alerts) and transport_confirmed)
        or incident_open(scoped_previous),
        "transport_failures": transport_failures,
    }
    if not scoped_alerts:
        since = (
            scoped_previous.get("healthy_since")
            if continuous_health(scoped_previous, now)
            else None
        )
        # Rebase an invalid/future clock value; missing observations never count as health.
        notification_state["healthy_since"] = (
            since if observation_age(since, now) is not None else record["checked_at"]
        )
    kind, notification_state["healthy_samples"] = notification_decision(
        scoped_alerts,
        scoped_metrics,
        scoped_previous,
        last_notification,
        now,
        cooldown_seconds=config.get("notification_cooldown_seconds", UPDATE_SECONDS),
        transport_confirmed=transport_confirmed,
    )
    record["notification_state"] = notification_state
    # Compatibility mirrors describe notification health; raw metrics/alerts above
    # always retain every staging failure for observations and restart baselines.
    for key in ["incident_open", "healthy_samples", "healthy_since"]:
        if key in notification_state:
            record[key] = notification_state[key]
    pending = None if args.simulate else previous.get("notification_pending")
    reconciliation_required = bool(
        not args.simulate and previous.get("notification_reconciliation_required")
    )
    scope_hold = False
    envelope_hold = False
    if pending:
        # A prior ambiguous provider result must reuse the same idempotency key.
        if str(uuid.UUID(pending["reference"])) != pending["reference"]:
            raise ValueError("Invalid pending notification identity")
        pending_age = (
            now - datetime.datetime.fromisoformat(pending["checked_at"]).timestamp()
        )
        scope_hold = bool(
            previous.get("notification_pending_policy_hold")
        ) or pending_scope_hold(pending)
        envelope_hold = bool(
            previous.get("notification_pending_envelope_hold")
        ) or pending_envelope_hold(pending)
        reconciliation_required |= (
            scope_hold or envelope_hold or not 0 <= pending_age < PENDING_RETRY_SECONDS
        )
    elif (args.simulate or kind) and not reconciliation_required:
        pending = {
            "reference": str(uuid.uuid4()),
            "kind": "simulation" if args.simulate else kind,
            "alerts": scoped_alerts,
            "metrics": scoped_metrics,
            "checked_at": record["checked_at"],
            "notification_scope": NOTIFICATION_SCOPE,
            "recovered_backends": list(
                last_notification.get(
                    "incident_backends", last_notification.get("affected_backends", {})
                )
            )
            if kind == "recovery"
            else [],
        }
        if not args.simulate and drone_event(pending, last_notification):
            pending["drone_acceptance_required"] = True
            pending["drone_acceptance_sha256"] = (
                last_notification.get("drone_acceptance_sha256")
                if pending["kind"] in {"update", "reminder", "recovery"} and
                "drone-production" in last_notification.get(
                    "incident_backends", last_notification.get("affected_backends", {})
                ) else drone_profile_token(metrics)
            )
    if pending and not args.simulate and drone_pending_hold(pending, metrics):
        scope_hold = True
        reconciliation_required = True
    should_send = pending is not None and not reconciliation_required
    if pending and not args.simulate:
        record["notification_pending"] = pending
    record["notification_pending_policy_hold"] = scope_hold
    record["notification_pending_envelope_hold"] = envelope_hold
    record["notification_reconciliation_required"] = reconciliation_required
    # Preserve the latest observed failure even if notification delivery fails.
    # A cleared sample is recorded separately; it never converts a failed sample to PASS.
    if not args.simulate:
        if alerts:
            write_record(STATE / "last-failure.json", record)
        elif previous.get("alerts"):
            write_record(
                STATE / "last-recovery.json",
                {
                    "checked_at": record["checked_at"],
                    "previous_failure_checked_at": previous.get("checked_at"),
                    "cleared_alerts": previous["alerts"],
                    "previous_failed_backends": failed_backends(
                        previous.get("metrics", {})
                    ),
                    "backends": metrics.get("backends", {}),
                },
            )
    if should_send:
        if "mail_envelope" not in pending:
            try:
                pending["mail_envelope"] = prepare_notification_request(
                    pending["alerts"], args.simulate,
                    metrics=pending["metrics"], checked_at=pending["checked_at"],
                    reference=pending["reference"], kind=pending["kind"],
                    recovered_backends=pending["recovered_backends"],
                    prior_incident=last_notification,
                )
            except (ValueError, TypeError, KeyError, OSError):
                # Keep the observed failure and event identity even when preparation
                # fails. An interrupted/unbound event is never guessed safe to retry.
                record["notification_pending_envelope_hold"] = True
                record["notification_reconciliation_required"] = True
                if not args.simulate:
                    write_record(path, record)
                raise
        if not args.simulate:
            # Persist exact bytes/account binding before sending, not just the UUID.
            record["notification_pending"] = pending
            write_record(path, record)
        record["notification"] = notify(
            pending["alerts"],
            args.simulate,
            metrics=pending["metrics"],
            checked_at=pending["checked_at"],
            reference=pending["reference"],
            kind=pending["kind"],
            recovered_backends=pending["recovered_backends"],
            mail_envelope=pending["mail_envelope"],
        )
        record.pop("notification_pending", None)
        if pending["kind"] == "recovery":
            notification_state["incident_open"] = bool(scoped_alerts)
            record["incident_open"] = notification_state["incident_open"]
        # Retain the observation time/type even with a minimal provider receipt.
        record["notification"].setdefault("checked_at", pending["checked_at"])
        record["notification"].setdefault("kind", pending["kind"])
        if pending.get("drone_acceptance_required") is True:
            record["notification"]["drone_acceptance_sha256"] = pending["drone_acceptance_sha256"]
        # Remember previously emailed failures within this incident. A rule that
        # clears then returns is not a new update on every cooldown boundary.
        prior = last_notification if pending["kind"] in {"update", "reminder"} else {}
        record["notification"]["incident_rules"] = sorted(
            set(prior.get("incident_rules", prior.get("rules", [])))
            | set(pending["alerts"])
        )
        record["notification"]["incident_backends"] = sorted(
            set(prior.get("incident_backends", prior.get("affected_backends", {})))
            | set(failed_backends(pending["metrics"]))
        )
        if not args.simulate:
            write_record(last, record["notification"])
            write_record(
                STATE / "last-notified-incident.json",
                {
                    **record,
                    "checked_at": pending["checked_at"],
                    "alerts": pending["alerts"],
                    "metrics": pending["metrics"],
                },
            )
    # Baseline keeps only counter fields at the top level; never overwrite baseline with injected values.
    if not args.simulate:
        record["worker_restart_count"] = metrics["worker_restart_count"]
        if "backend_restart_counts" in metrics:
            record["backend_restart_counts"] = metrics["backend_restart_counts"]
    # Keep the prior complete sample (or pending notification) if a write fails.
    write_record(path, record)
    print(
        json.dumps(
            {
                "event": "portal_operations_sample",
                "alerts": alerts,
                "simulation": args.simulate,
                "notification_accepted": bool(should_send),
                "notification_reconciliation_required": reconciliation_required,
                "notification_pending_policy_hold": scope_hold,
                "notification_pending_envelope_hold": envelope_hold,
                "notification_scope": NOTIFICATION_SCOPE,
                "notification_alerts": scoped_alerts,
                "notification_kind": pending["kind"] if should_send else None,
                "failed_backends": failed_backends(metrics),
                "reference": record.get("notification", {}).get("reference"),
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        print("portal_operations_monitor_failed; private diagnostics required")
        raise SystemExit(1) from None
