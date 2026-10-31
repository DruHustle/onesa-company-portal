"""Private metrics and bounded notifications. Simulations never stop actual services."""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STATE = Path("/var/lib/onesa/operations")
REMINDER_SECONDS = 6 * 60 * 60
UPDATE_SECONDS = 30 * 60
RECOVERY_SECONDS = 5 * 60
RECOVERY_SAMPLES = 6
MAX_SAMPLE_GAP_SECONDS = 120
TRANSPORT_FAILURE_SECONDS = 120
TRANSPORT_FAILURE_SAMPLES = 3
NOTIFICATION_SCOPE = "production-and-shared-v1"
# Provider keys last 24 hours; leave an hour before manual reconciliation is needed.
PENDING_RETRY_SECONDS = 23 * 60 * 60
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
    target = BACKENDS[name]
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


def sample(config):
    def inspect(name):
        try:
            return json.loads(run(["docker", "inspect", name], timeout=3))[0]
        except (ValueError, subprocess.SubprocessError):
            return {}

    worker = inspect("onesa-portal-oracle-production-worker-1")
    scanner = inspect("onesa-portal-oracle-staging-scanner-1")
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
        "worker_healthy": worker.get("State", {}).get("Health", {}).get("Status")
        == "healthy",
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
        try:
            raw = run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-i",
                    "--read-only",
                    "--tmpfs",
                    "/tmp",
                    "--memory",
                    "128m",
                    "--cpus",
                    "0.1",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--env-file",
                    "/etc/onesa/portal-production.env",
                    "-e",
                    "CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock",
                    "--group-add",
                    "3000",
                    "-v",
                    "onesa-portal-oracle-staging_scanner_socket:/run/onesa-scanner:ro",
                    "-v",
                    str(Path(__file__).parents[3] / "scripts/oracle_metrics.mjs")
                    + ":/app/metrics.mjs:ro",
                    "--entrypoint",
                    "node",
                    config["image"],
                    "metrics.mjs",
                ],
                timeout=20,
            )
            metrics.update(json.loads(raw))
        except (ValueError, subprocess.SubprocessError):
            metrics["database_available"] = False
            metrics["scanner_ready"] = False
        if backends is not None:
            metrics.update(backends.result())
    return metrics


def failed_backends(metrics):
    """Only fixed service identities and bounded health fields leave private metrics."""
    details = metrics.get("backends", {})
    result = {}
    for name in BACKENDS:
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
            "probe": BACKENDS[name]["probe"],
        }
    return result


def write_record(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


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
            if BACKENDS.get(name, {}).get("environment") != "staging"
        }
        result["backends"] = eligible
        if details and set(details) <= set(BACKENDS):
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
            if BACKENDS.get(name, {}).get("environment") != "staging"
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
            if BACKENDS.get(name, {}).get("environment") != "staging"
        },
        "incident_backends": sorted(
            name
            for name in names
            if BACKENDS.get(name, {}).get("environment") != "staging"
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
            BACKENDS.get(name, {}).get("environment") == "staging"
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


def notify(
    alerts,
    simulation=False,
    *,
    metrics=None,
    checked_at=None,
    reference=None,
    kind="alert",
    recovered_backends=(),
):
    from backup import checked_env

    values, _ = checked_env()
    if values.get("MAIL_PROVIDER") != "resend" or values.get("NOTIFY_EMAIL") not in [
        "info@onesa.eu",
        "andrew@onesa.eu",
    ]:
        raise ValueError("Existing approved notification destination required")
    reference = reference or str(uuid.uuid4())
    if str(uuid.UUID(reference)) != reference or kind not in {
        "alert",
        "update",
        "reminder",
        "recovery",
        "simulation",
    }:
        raise ValueError("Invalid notification event")
    subject = (
        "ONESA operations qualification — synthetic alert"
        if simulation
        else "ONESA service operations recovery"
        if kind == "recovery"
        else "ONESA service operations alert"
    )
    data = {
        "from": values["MAIL_FROM"],
        "to": [values["NOTIFY_EMAIL"]],
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
            for name in BACKENDS
            if name in recovered_backends
        )
        + "\nReference: "
        + reference,
    }
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(data).encode(),
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
        "recipient": values["NOTIFY_EMAIL"],
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
        reconciliation_required |= (
            scope_hold or not 0 <= pending_age < PENDING_RETRY_SECONDS
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
    should_send = pending is not None and not reconciliation_required
    if pending and not args.simulate:
        record["notification_pending"] = pending
    record["notification_pending_policy_hold"] = scope_hold
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
        if not args.simulate:
            # Persist identity before sending: timeouts/crashes must not create new mail.
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
        )
        record.pop("notification_pending", None)
        if pending["kind"] == "recovery":
            notification_state["incident_open"] = bool(scoped_alerts)
            record["incident_open"] = notification_state["incident_open"]
        # Retain the observation time/type even with a minimal provider receipt.
        record["notification"].setdefault("checked_at", pending["checked_at"])
        record["notification"].setdefault("kind", pending["kind"])
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
