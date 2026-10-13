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
)


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
        or metrics["backup_age_seconds"] > 7200,
        "resource-exhaustion": metrics["disk_used_percent"] >= 80
        or metrics["memory_available_bytes"] < 512 * 1024 * 1024,
        "database-unavailable": not metrics.get("database_available", False),
        "worker-restarted": metrics["worker_restart_count"]
        > metrics["previous_restart_count"],
    }


def run(command):
    r = subprocess.run(command, capture_output=True, timeout=35, check=False)
    if r.returncode:
        raise ValueError("Private metric acquisition failed")
    return r.stdout


def sample(config):
    def inspect(name):
        try:
            return json.loads(run(["docker", "inspect", name]))[0]
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
    try:
        run(
            [
                "docker",
                "exec",
                scanner["Name"].lstrip("/"),
                "sh",
                "-c",
                'test -n "$(find /var/lib/clamav -maxdepth 1 -type f \\( -name daily.cvd -o -name daily.cld \\) -mmin -2880 -print -quit)" && pgrep freshclam >/dev/null',
            ]
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
            ]
        )
        metrics.update(json.loads(raw))
    except (ValueError, subprocess.SubprocessError):
        metrics["database_available"] = False
        metrics["scanner_ready"] = False
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
        else "ONESA Portal operations alert"
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
