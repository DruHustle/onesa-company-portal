"""Offline notification-environment and migration regressions; delivery is mocked."""

import contextlib
import copy
import datetime
import importlib.util
import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "onesa_scoped_monitor", ROOT / "infra/oracle/operations/monitor.py"
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


def metrics(*failed, restarted=()):
    return {
        "worker_required": True,
        "worker_healthy": True,
        "worker_restart_count": 1,
        "previous_restart_count": 1,
        "scanner_ready": True,
        "signature_current": True,
        "backup_failed": False,
        "backup_age_seconds": 10,
        "disk_used_percent": 20,
        "memory_available_bytes": 1024**3,
        "database_available": True,
        "backend_api_healthy": not failed,
        "backend_api_restarted": bool(restarted),
        "backend_restart_counts": {
            name: 2 if name in restarted else 1 for name in monitor.BACKENDS
        },
        "backends": {
            name: {
                "container_healthy": True,
                "http_healthy": name not in failed,
                "http_status": 0 if name in failed else 200,
                "restart_count": 2 if name in restarted else 1,
                "restarted": name in restarted,
            }
            for name in monitor.BACKENDS
        },
    }


class NotificationScopeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="onesa-notification-scope-")
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.sent = []
        self.now = datetime.datetime(
            2026, 10, 29, tzinfo=datetime.timezone.utc
        ).timestamp()
        self.config = {"notification_cooldown_seconds": 1800}

    def read(self, name="metrics.json"):
        return json.loads((self.state / name).read_bytes())

    def write(self, name, value):
        (self.state / name).write_text(json.dumps(value))
        (self.state / name).chmod(0o600)

    def receipt(self, alerts, simulation, **kwargs):
        self.sent.append(
            copy.deepcopy({"alerts": alerts, "simulation": simulation, **kwargs})
        )
        return {
            "reference": kwargs["reference"],
            "kind": kwargs["kind"],
            "checked_at": kwargs["checked_at"],
            "rules": alerts,
            "affected_backends": monitor.failed_backends(kwargs["metrics"]),
            "provider_receipt_id": "mock-provider-receipt-" + str(len(self.sent)),
            "provider_accepted": True,
            "delivery_verified": False,
        }

    def tick(self, value, elapsed=60, sender=None):
        self.now += elapsed
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if str(path) == "/etc/onesa/operations.json":
                return json.dumps(self.config)
            return original_read(path, *args, **kwargs)

        with contextlib.ExitStack() as stack:
            for target, name, options in [
                (monitor, "STATE", {"new": self.state}),
                (monitor.os, "geteuid", {"return_value": 0}),
                (
                    monitor.argparse.ArgumentParser,
                    "parse_args",
                    {"return_value": SimpleNamespace(simulate=False)},
                ),
                (Path, "read_text", {"new": read}),
                (monitor, "sample", {"return_value": copy.deepcopy(value)}),
                (monitor.time, "time", {"return_value": self.now}),
                (monitor, "notify", {"side_effect": sender or self.receipt}),
                (
                    monitor.subprocess,
                    "run",
                    {"side_effect": AssertionError("No subprocess permitted")},
                ),
                (
                    monitor.urllib.request,
                    "build_opener",
                    {"side_effect": AssertionError("No network permitted")},
                ),
            ]:
                stack.enter_context(patch.object(target, name, **options))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            monitor.main()
        return json.loads(output.getvalue())

    def legacy(self, *failed, shared=False, healthy=False):
        value = metrics(*failed)
        alerts = ["backend-api-unavailable"] if failed else []
        if shared:
            value["scanner_ready"] = False
            alerts.append("clamav-unavailable")
        when = datetime.datetime.fromtimestamp(
            self.now, datetime.timezone.utc
        ).isoformat()
        last = {
            "checked_at": when,
            "kind": "alert",
            "reference": str(uuid.uuid4()),
            "rules": alerts,
            "incident_rules": alerts,
            "affected_backends": monitor.failed_backends(value),
            "incident_backends": list(failed),
            "provider_receipt_id": "preserved-legacy-receipt",
        }
        previous = {
            "checked_at": when,
            "metrics": metrics() if healthy else value,
            "alerts": [] if healthy else alerts,
            "healthy_samples": 5 if healthy else 0,
            "healthy_since": when,
            "incident_open": True,
        }
        self.write("notification.json", last)
        self.write("metrics.json", previous)
        return last

    def pending(self, value, kind="alert", recovered=(), held=False):
        when = datetime.datetime.fromtimestamp(
            self.now, datetime.timezone.utc
        ).isoformat()
        alerts = [key for key, failed in monitor.evaluate(value).items() if failed]
        pending = {
            "reference": str(uuid.uuid4()),
            "kind": kind,
            "alerts": [] if kind == "recovery" else alerts,
            "metrics": value,
            "checked_at": when,
            "recovered_backends": list(recovered),
        }
        self.write(
            "metrics.json",
            {
                "checked_at": when,
                "metrics": value,
                "alerts": alerts,
                "incident_open": True,
                "healthy_samples": 0,
                "notification_pending": pending,
                "notification_reconciliation_required": held,
            },
        )
        return pending

    def test_all_staging_outages_and_recoveries_are_silent_but_recorded(self):
        for name in monitor.BACKENDS:
            if monitor.BACKENDS[name]["environment"] != "staging":
                continue
            with self.subTest(name=name):
                for _ in range(8):
                    event = self.tick(metrics(name))
                saved = self.read()
                self.assertEqual(saved["alerts"], ["backend-api-unavailable"])
                self.assertEqual(saved["notification_state"]["alerts"], [])
                self.assertFalse(saved["notification_state"]["incident_open"])
                self.assertIn(
                    name,
                    monitor.failed_backends(self.read("last-failure.json")["metrics"]),
                )
                self.assertIn(name, event["failed_backends"])
                for _ in range(8):
                    self.tick(metrics())
                self.assertEqual(self.sent, [])
                self.assertEqual(
                    self.read("last-recovery.json")["cleared_alerts"],
                    ["backend-api-unavailable"],
                )

    def test_staging_changes_reminders_and_restart_counters_are_silent(self):
        self.tick(metrics("portal-staging"))
        self.tick(metrics("portal-staging", "robot-staging"), elapsed=1800)
        self.tick(metrics("ai-staging"), elapsed=21600)
        event = self.tick(metrics(restarted=["robot-staging"]))
        saved = self.read()
        self.assertEqual(event["notification_alerts"], [])
        self.assertEqual(saved["alerts"], ["backend-api-restarted"])
        self.assertEqual(saved["backend_restart_counts"]["robot-staging"], 2)
        self.assertEqual(self.sent, [])

    def test_filtering_precedes_decision_and_incident_bookkeeping(self):
        with patch.object(
            monitor, "notification_decision", wraps=monitor.notification_decision
        ) as decision:
            self.tick(metrics("portal-staging"))
            args = decision.call_args.args
            self.assertEqual(args[0], [])
            self.assertTrue(args[1]["backend_api_healthy"])
            self.assertFalse(args[2]["incident_open"])
        self.assertFalse(self.read()["incident_open"])

    def test_production_initial_alert_is_immediate_and_staging_changes_do_not_update_it(
        self,
    ):
        self.tick(metrics("robot-production"))
        self.assertEqual([call["kind"] for call in self.sent], ["alert"])
        self.tick(metrics("robot-production", "portal-staging"), elapsed=1800)
        self.assertEqual(len(self.sent), 1)
        self.tick(metrics("robot-production", "ai-staging"), elapsed=60)
        self.assertEqual(len(self.sent), 1)

    def test_production_updates_use_existing_cooldown_and_unchanged_six_hour_reminders(
        self,
    ):
        self.tick(metrics("robot-production"))
        self.tick(metrics("robot-production", "ai-production"), elapsed=1799)
        self.assertEqual(len(self.sent), 1)
        self.tick(metrics("robot-production", "ai-production"), elapsed=1)
        self.assertEqual([call["kind"] for call in self.sent], ["alert", "update"])
        self.tick(metrics("robot-production"), elapsed=21599)
        self.assertEqual(len(self.sent), 2)
        self.tick(metrics("robot-production"), elapsed=1)
        self.assertEqual(self.sent[-1]["kind"], "reminder")

    def test_nondefault_cooldown_is_honored_for_eligible_updates(self):
        self.config["notification_cooldown_seconds"] = 60
        self.tick(metrics("robot-production"))
        self.tick(metrics("robot-production", "ai-production"))
        self.assertEqual([call["kind"] for call in self.sent], ["alert", "update"])

    def test_mixed_incident_records_all_failures_and_emails_only_production(self):
        self.tick(metrics("robot-staging", "ai-production"))
        sent = self.sent[0]
        self.assertEqual(
            set(monitor.failed_backends(sent["metrics"])), {"ai-production"}
        )
        self.assertFalse(
            any(name.endswith("-staging") for name in sent["metrics"]["backends"])
        )
        self.assertEqual(
            set(monitor.failed_backends(self.read()["metrics"])),
            {"robot-staging", "ai-production"},
        )
        self.assertEqual(
            self.read("notification.json")["incident_backends"], ["ai-production"]
        )

    def test_production_recovers_while_staging_keeps_failing_then_staging_clear_is_silent(
        self,
    ):
        self.tick(metrics("robot-production", "robot-staging"))
        for _ in range(5):
            self.tick(metrics("robot-staging"))
        self.assertEqual(len(self.sent), 1)
        self.tick(metrics("robot-staging"))
        self.assertEqual([call["kind"] for call in self.sent], ["alert", "recovery"])
        self.assertEqual(self.sent[-1]["recovered_backends"], ["robot-production"])
        self.assertEqual(self.read()["alerts"], ["backend-api-unavailable"])
        for _ in range(8):
            self.tick(metrics())
        self.assertEqual(len(self.sent), 2)

    def test_brief_production_health_does_not_close_incident(self):
        self.tick(metrics("ai-production"))
        for _ in range(5):
            self.tick(metrics("ai-staging"))
        self.tick(metrics("ai-production"))
        self.assertEqual([call["kind"] for call in self.sent], ["alert"])

    def test_sample_gap_restarts_scoped_recovery_confirmation(self):
        self.tick(metrics("ai-production"))
        for _ in range(4):
            self.tick(metrics("ai-staging"))
        self.tick(metrics("ai-staging"), elapsed=121)
        for _ in range(4):
            self.tick(metrics("ai-staging"))
        self.assertEqual(len(self.sent), 1)
        self.tick(metrics("ai-staging"))
        self.assertEqual(self.sent[-1]["kind"], "recovery")

    def test_shared_scanner_with_historical_staging_name_remains_notifiable(self):
        value = metrics("portal-staging")
        value.update(
            scanner_ready=False,
            scanner_container="onesa-portal-oracle-staging-scanner-1",
        )
        self.tick(value)
        self.assertEqual(self.sent[0]["alerts"], ["clamav-unavailable"])
        self.assertEqual(monitor.failed_backends(self.sent[0]["metrics"]), {})

    def test_shared_and_production_non_backend_rules_remain_notifiable(self):
        value = metrics("portal-staging")
        value.update(
            worker_healthy=False,
            worker_restart_count=2,
            failed_jobs=1,
            queue_age_seconds=301,
            scanner_ready=False,
            signature_current=False,
            backup_failed=True,
            disk_used_percent=81,
            database_available=False,
        )
        self.tick(value)
        self.assertEqual(
            set(self.sent[0]["alerts"]),
            set(monitor.RULES) - {"backend-api-unavailable", "backend-api-restarted"},
        )

    def test_legacy_staging_incident_is_silently_retired_without_rewriting_receipt(
        self,
    ):
        self.legacy("robot-staging")
        before = (self.state / "notification.json").read_bytes()
        for _ in range(8):
            self.tick(metrics("robot-staging"))
        for _ in range(8):
            self.tick(metrics())
        self.assertEqual(self.sent, [])
        self.assertEqual((self.state / "notification.json").read_bytes(), before)

    def test_legacy_staging_recovery_due_on_migration_does_not_send(self):
        self.legacy("robot-staging", healthy=True)
        for _ in range(8):
            self.tick(metrics())
        self.assertEqual(self.sent, [])

    def test_legacy_mixed_incident_retains_original_cooldown_and_eligible_history(self):
        last = self.legacy("robot-staging", "robot-production")
        self.tick(metrics("robot-production", "ai-production"), elapsed=1799)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.read("notification.json")["reference"], last["reference"])
        self.tick(metrics("robot-production", "ai-production"), elapsed=1)
        self.assertEqual([call["kind"] for call in self.sent], ["update"])
        self.assertEqual(
            set(self.read("notification.json")["incident_backends"]),
            {"robot-production", "ai-production"},
        )

    def test_legacy_mixed_recovery_needs_fresh_health_and_names_only_production(self):
        self.legacy("robot-staging", "robot-production")
        for _ in range(5):
            self.tick(metrics("robot-staging"))
        self.assertEqual(self.sent, [])
        self.tick(metrics("robot-staging"))
        self.assertEqual([call["kind"] for call in self.sent], ["recovery"])
        self.assertEqual(self.sent[0]["recovered_backends"], ["robot-production"])

    def test_historical_eligible_failure_survives_a_later_staging_only_update(self):
        last = self.legacy("robot-staging")
        last["incident_backends"].append("robot-production")
        self.write("notification.json", last)
        for _ in range(6):
            self.tick(metrics("robot-staging"))
        self.assertEqual([call["kind"] for call in self.sent], ["recovery"])
        self.assertEqual(self.sent[0]["recovered_backends"], ["robot-production"])

    def test_all_legacy_staging_pending_kinds_are_held_without_changing_identity_or_payload(
        self,
    ):
        for kind in ["alert", "update", "reminder", "recovery"]:
            with self.subTest(kind=kind):
                pending = self.pending(
                    metrics("robot-staging"), kind=kind, recovered=["robot-staging"]
                )
                for _ in range(2):
                    self.tick(metrics())
                    saved = self.read()
                    self.assertEqual(saved["notification_pending"], pending)
                    self.assertTrue(saved["notification_reconciliation_required"])
                    self.assertTrue(saved["notification_pending_policy_hold"])
                self.assertEqual(self.sent, [])

    def test_legacy_mixed_pending_requires_reconciliation_instead_of_rewriting_body(
        self,
    ):
        pending = self.pending(metrics("robot-staging", "robot-production"))
        self.tick(metrics("robot-production"))
        self.assertEqual(self.sent, [])
        self.assertEqual(self.read()["notification_pending"], pending)
        self.assertTrue(self.read()["notification_reconciliation_required"])

    def test_eligible_legacy_pending_retries_same_body_reference_and_timestamp(self):
        pending = self.pending(metrics("robot-production"))
        self.tick(metrics("ai-staging"))
        sent = self.sent[0]
        for field in [
            "reference",
            "kind",
            "alerts",
            "metrics",
            "checked_at",
            "recovered_backends",
        ]:
            self.assertEqual(sent[field], pending[field])
        self.assertNotIn("notification_pending", self.read())

    def test_new_ambiguous_delivery_reuses_identical_scoped_payload_after_mixed_sample(
        self,
    ):
        calls = []

        def sender(alerts, simulation, **kwargs):
            calls.append(copy.deepcopy((alerts, simulation, kwargs)))
            if len(calls) == 1:
                raise TimeoutError("Mock ambiguous acceptance")
            return self.receipt(alerts, simulation, **kwargs)

        with self.assertRaises(TimeoutError):
            self.tick(metrics("robot-staging", "robot-production"), sender=sender)
        pending = self.read()["notification_pending"]
        self.tick(metrics("ai-staging"), sender=sender)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.sent[0]["reference"], pending["reference"])
        self.assertEqual(
            set(monitor.failed_backends(self.sent[0]["metrics"])), {"robot-production"}
        )

    def test_existing_provider_hold_is_not_released_by_recent_timestamp(self):
        pending = self.pending(metrics("robot-production"), held=True)
        self.tick(metrics())
        self.assertEqual(self.sent, [])
        self.assertTrue(self.read()["notification_reconciliation_required"])
        self.assertEqual(self.read()["notification_pending"], pending)

    def test_unknown_aggregate_failure_is_preserved_without_guessing_environment(self):
        value = metrics()
        value.pop("backends")
        value["backend_api_healthy"] = False
        self.tick(value)
        self.assertEqual(self.sent[0]["alerts"], ["backend-api-unavailable"])


if __name__ == "__main__":
    unittest.main()
