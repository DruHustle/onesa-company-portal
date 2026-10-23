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


def probe_backend(name):
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
                "1",
                "--max-time",
                "3",
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
            timeout=4,
            check=False,
        )
        body, status = response.stdout.rsplit(b"\n", 1)
        result["http_status"] = int(status)
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
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass
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
    if config.get("backend_monitoring_enabled") is True:
        metrics.update(sample_backends(previous.get("backend_restart_counts", {})))
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


def notification_decision(alerts, metrics, previous, last, now):
    """Notify transitions immediately; bound unchanged reminders, confirm clearance."""
    healthy_samples = (
        0
        if alerts
        else min(
            2,
            previous.get(
                "healthy_samples", 2 if previous and not previous.get("alerts") else 0
            )
            + 1,
        )
    )
    if not alerts:
        # Do not retroactively email historical recoveries on first installation.
        recovered = (
            healthy_samples == 2
            and (
                previous.get("healthy_samples") == 1
                or previous.get("notification", {}).get("kind")
                in {"alert", "update", "reminder"}
            )
            and last.get("rules")
            and last.get("kind", "alert") != "recovery"
        )
        return ("recovery" if recovered else None), healthy_samples
    if (
        not last
        or last.get("kind") == "recovery"
        or previous.get(
            "healthy_samples", 2 if previous and not previous.get("alerts") else 0
        )
        >= 2
    ):
        return "alert", 0
    signature = (sorted(alerts), sorted(failed_backends(metrics)))
    old_signature = (
        sorted(last.get("rules", [])),
        sorted(last.get("affected_backends", {})),
    )
    if signature != old_signature:
        return "update", 0
    try:
        age = now - datetime.datetime.fromisoformat(last["checked_at"]).timestamp()
    except (KeyError, TypeError, ValueError, OverflowError):
        age = REMINDER_SECONDS
    return ("reminder" if age < 0 or age >= REMINDER_SECONDS else None), 0


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
            "Recovered: two consecutive healthy samples.\n"
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
    record = {
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "metrics": metrics,
        "alerts": alerts,
        "simulation": args.simulate,
        "delivery_verified": False,
    }
    path = STATE / ("simulation.json" if args.simulate else "metrics.json")
    previous = json.loads(path.read_text()) if path.exists() else {}
    last_notification = json.loads(last.read_text()) if last.exists() else {}
    kind, record["healthy_samples"] = notification_decision(
        alerts, metrics, previous, last_notification, time.time()
    )
    pending = None if args.simulate else previous.get("notification_pending")
    reconciliation_required = False
    if pending:
        # A prior ambiguous provider result must reuse the same idempotency key.
        if str(uuid.UUID(pending["reference"])) != pending["reference"]:
            raise ValueError("Invalid pending notification identity")
        pending_age = (
            time.time()
            - datetime.datetime.fromisoformat(pending["checked_at"]).timestamp()
        )
        reconciliation_required = not 0 <= pending_age < PENDING_RETRY_SECONDS
    elif args.simulate or kind:
        pending = {
            "reference": str(uuid.uuid4()),
            "kind": "simulation" if args.simulate else kind,
            "alerts": alerts,
            "metrics": metrics,
            "checked_at": record["checked_at"],
            "recovered_backends": list(last_notification.get("affected_backends", {}))
            if kind == "recovery"
            else [],
        }
    should_send = pending is not None and not reconciliation_required
    if pending and not args.simulate:
        record["notification_pending"] = pending
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
        # Retain the observation time/type even with a minimal provider receipt.
        record["notification"].setdefault("checked_at", pending["checked_at"])
        record["notification"].setdefault("kind", pending["kind"])
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
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(0o600)
    # Baseline keeps only counter fields at the top level; never overwrite baseline with injected values.
    if not args.simulate:
        record["worker_restart_count"] = metrics["worker_restart_count"]
        if "backend_restart_counts" in metrics:
            record["backend_restart_counts"] = metrics["backend_restart_counts"]
        path.write_text(json.dumps(record, indent=2) + "\n")
    print(
        json.dumps(
            {
                "event": "portal_operations_sample",
                "alerts": alerts,
                "simulation": args.simulate,
                "notification_accepted": bool(should_send),
                "notification_reconciliation_required": reconciliation_required,
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
