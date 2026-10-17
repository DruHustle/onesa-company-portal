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
        + ("/health" if product == "ai" else "/api/v1/health"),
        "status": "live" if product == "robot" else "ok",
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
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass
    return result


def sample_backends(previous):
    # One bounded Docker read plus parallel, unauthenticated liveness requests.
    # No /ready, model calls, application records, service restarts or new credentials.
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


def notify(alerts, simulation=False):
    from backup import checked_env

    values, _ = checked_env()
    if values.get("MAIL_PROVIDER") != "resend" or values.get("NOTIFY_EMAIL") not in [
        "info@onesa.eu",
        "andrew@onesa.eu",
    ]:
        raise ValueError("Existing approved notification destination required")
    reference = str(uuid.uuid4())
    subject = (
        "ONESA operations qualification — synthetic alert"
        if simulation
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
        + "\n".join(alerts)
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
    should_send = args.simulate or (
        alerts and (not last.exists() or time.time() - last.stat().st_mtime >= 1800)
    )
    record = {
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "metrics": metrics,
        "alerts": alerts,
        "simulation": args.simulate,
        "delivery_verified": False,
    }
    if should_send:
        record["notification"] = notify(alerts, args.simulate)
    path = STATE / ("simulation.json" if args.simulate else "metrics.json")
    path.write_text(json.dumps(record, indent=2) + "\n")
    path.chmod(0o600)
    # Baseline keeps only counter fields at the top level; never overwrite baseline with injected values.
    if not args.simulate:
        record["worker_restart_count"] = metrics["worker_restart_count"]
        if "backend_restart_counts" in metrics:
            record["backend_restart_counts"] = metrics["backend_restart_counts"]
        path.write_text(json.dumps(record, indent=2) + "\n")
    if should_send:
        last.write_text(json.dumps(record["notification"]) + "\n")
        last.chmod(0o600)
    print(
        json.dumps(
            {
                "event": "portal_operations_sample",
                "alerts": alerts,
                "simulation": args.simulate,
                "notification_accepted": should_send,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        print("portal_operations_monitor_failed; private diagnostics required")
        raise SystemExit(1) from None
