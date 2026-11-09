"""Exercise durable mail requests and sender routing without network or host access."""

import contextlib
import copy
import datetime
import hashlib
import importlib.util
import io
import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "onesa_envelope_monitor", ROOT / "infra/oracle/operations/monitor.py"
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
        "backends": {
            name: {
                "container_healthy": True,
                "http_healthy": name not in failed,
                "http_status": 503 if name in failed else 200,
                "restarted": name in restarted,
            }
            for name in monitor.BACKENDS
        },
    }


class DurableMailTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="onesa-mail-envelope-")
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name) / "state"
        self.values = {
            "MAIL_PROVIDER": "resend",
            "RESEND_API_KEY": "synthetic-only",
            "MAIL_FROM": "Onesa Portal <notifications-portal@onesa.eu>",
            "NOTIFY_EMAIL": "andrew@onesa.eu",
        }
        self.senders = {
            "portal": "Onesa Portal <notifications-portal@onesa.eu>",
            "ai": "Onesa AI <notifications-ai@onesa.eu>",
            "robot": "Onesa Robot <notifications-robot@onesa.eu>",
        }
        self.now = datetime.datetime(
            2026, 11, 4, tzinfo=datetime.timezone.utc
        ).timestamp()
        self.requests = []
        self.failures = 0
        self.before_response = lambda request: None

        def open_request(request, timeout):
            self.assertEqual(timeout, 20)
            self.assertEqual(request.full_url, "https://api.resend.com/emails")
            self.assertEqual(request.method, "POST")
            self.requests.append(request)
            self.before_response(request)
            if self.failures:
                self.failures -= 1
                raise TimeoutError("Synthetic ambiguous provider acceptance")
            return io.StringIO('{"id":"synthetic-provider-receipt"}')

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict("sys.modules", {
            "backup": SimpleNamespace(checked_env=lambda: (dict(self.values), None)),
        }))
        stack.enter_context(patch.object(monitor, "STATE", self.state))
        stack.enter_context(patch.object(monitor.os, "geteuid", return_value=0))
        stack.enter_context(patch.object(
            monitor.urllib.request, "build_opener",
            return_value=SimpleNamespace(open=open_request),
        ))
        stack.enter_context(patch.object(
            monitor.subprocess, "run",
            side_effect=AssertionError("Host subprocesses are forbidden"),
        ))

    def tick(self, value=None, elapsed=60, simulation=False):
        self.now += elapsed
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if str(path) == "/etc/onesa/operations.json":
                return '{"notification_cooldown_seconds":1800}'
            return original_read(path, *args, **kwargs)

        with (
            patch.object(Path, "read_text", new=read),
            patch.object(monitor, "sample", return_value=copy.deepcopy(
                metrics("robot-production") if value is None else value
            )),
            patch.object(monitor.time, "time", return_value=self.now),
            patch.object(monitor.argparse.ArgumentParser, "parse_args",
                         return_value=SimpleNamespace(simulate=simulation)),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            monitor.main()

    def read(self, name="metrics.json"):
        return json.loads((self.state / name).read_bytes())

    def save(self, value, name="metrics.json"):
        monitor.write_record(self.state / name, value)

    def ambiguous(self):
        self.failures = 1
        with self.assertRaises(TimeoutError):
            self.tick()
        return copy.deepcopy(self.read()["notification_pending"])

    def body(self, index=-1):
        return json.loads(self.requests[index].data)

    def test_html_is_versioned_escaped_and_plain_legacy_bytes_still_retry(self):
        pending = self.ambiguous()
        envelope = pending["mail_envelope"]
        self.assertEqual(envelope["version"], 2)
        body = json.loads(envelope["body"])
        self.assertIn("Service needs attention", body["html"])
        self.assertIn("Reference: " + pending["reference"], body["html"])
        self.assertNotIn("<script>", monitor.operations_email_html_v1(
            "<script>bad</script>", "<img src=x onerror=bad>", "alert", False, None))
        # Reconstruct a synthetic legacy envelope, not a real operational record.
        # Its stored body remains plain on retry, despite the new renderer.
        del body["html"]
        envelope["version"] = 1
        envelope["body"] = json.dumps(body)
        envelope["body_sha256"] = hashlib.sha256(envelope["body"].encode()).hexdigest()
        saved = self.read()
        saved["notification_pending"] = pending
        self.save(saved)
        self.tick()
        self.assertEqual(self.requests[-1].data, envelope["body"].encode())
        self.assertNotIn("html", self.body())

    def test_request_is_durable_and_private_before_provider_call(self):
        def inspect(request):
            saved = self.read()
            pending = saved["notification_pending"]
            envelope = pending["mail_envelope"]
            self.assertEqual(request.data, envelope["body"].encode("utf-8"))
            self.assertEqual(envelope["body_sha256"],
                             hashlib.sha256(request.data).hexdigest())
            self.assertEqual(request.get_header("Idempotency-key"),
                             "onesa-operations/" + pending["reference"])
            self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((self.state / "metrics.json").stat().st_mode), 0o600)
            self.assertNotIn(self.values["RESEND_API_KEY"], json.dumps(saved))
            self.assertNotIn("Authorization", json.dumps(saved))

        self.before_response = inspect
        pending = self.ambiguous()
        self.assertEqual(pending, self.read()["notification_pending"])
        self.assertEqual(self.read("last-failure.json")["alerts"],
                         ["backend-api-unavailable"])

    def test_file_and_directory_sync_precede_provider_call(self):
        events = []
        original_sync = monitor.os.fsync
        original_replace = Path.replace

        def sync(descriptor):
            is_directory = stat.S_ISDIR(monitor.os.fstat(descriptor).st_mode)
            original_sync(descriptor)
            events.append("directory_sync" if is_directory else "file_sync")

        def replace(path, destination):
            result = original_replace(path, destination)
            events.append("replace_" + Path(destination).name)
            return result

        def before_response(_request):
            self.assertEqual(events[-3:], ["file_sync", "replace_metrics.json", "directory_sync"])

        self.before_response = before_response
        with patch.object(monitor.os, "fsync", side_effect=sync), patch.object(Path, "replace", replace):
            self.ambiguous()

    def test_pending_directory_sync_failure_prevents_send_and_retains_event(self):
        original_sync = monitor.os.fsync

        def sync(descriptor):
            if stat.S_ISDIR(monitor.os.fstat(descriptor).st_mode):
                path = self.state / "metrics.json"
                if path.exists() and "notification_pending" in self.read():
                    raise OSError("Synthetic directory sync failure")
            return original_sync(descriptor)

        with patch.object(monitor.os, "fsync", side_effect=sync), self.assertRaises(OSError):
            self.tick()
        self.assertEqual(self.requests, [])
        pending = self.read()["notification_pending"]
        self.tick()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].data, pending["mail_envelope"]["body"].encode())
        self.assertEqual(self.read("notification.json")["reference"], pending["reference"])

    def assert_frozen_retry(self, change):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        pending = self.ambiguous()
        first = self.requests[0]
        change()
        with patch.object(monitor, "prepare_notification_request",
                          side_effect=AssertionError("Never rebuild a pending request")):
            self.tick(metrics("ai-production"))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(first.data, self.requests[1].data)
        self.assertEqual(first.get_header("Idempotency-key"),
                         self.requests[1].get_header("Idempotency-key"))
        self.assertNotIn("notification_pending", self.read())
        receipt = self.read("notification.json")
        self.assertEqual(receipt["reference"], pending["reference"])
        self.assertEqual(receipt["checked_at"], pending["checked_at"])
        self.assertEqual(receipt["sender"], self.senders["robot"])
        self.assertEqual(receipt["recipient"], "andrew@onesa.eu")
        self.assertFalse(receipt["delivery_verified"])

    def test_sender_and_mapping_drift_do_not_change_pending_request(self):
        def change():
            self.values["MAIL_FROM"] = "Changed <synthetic@example.invalid>"
            self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = "not valid JSON"
        self.assert_frozen_retry(change)

    def test_recipient_drift_does_not_redirect_pending_request(self):
        self.assert_frozen_retry(lambda: self.values.update(NOTIFY_EMAIL="info@onesa.eu"))

    def test_infrastructure_recipient_transition_preserves_attempted_request(self):
        self.assert_frozen_retry(lambda: self.values.update(
            OPERATIONS_NOTIFY_EMAIL="it-infrastructure@onesa.eu"
        ))

    def test_fresh_infrastructure_alert_uses_approved_mailbox(self):
        self.values["OPERATIONS_NOTIFY_EMAIL"] = "it-infrastructure@onesa.eu"
        self.tick()
        self.assertEqual(self.body()["to"], ["it-infrastructure@onesa.eu"])
        self.assertEqual(self.read("notification.json")["recipient"],
                         "it-infrastructure@onesa.eu")
        self.assertEqual(self.values["NOTIFY_EMAIL"], "andrew@onesa.eu")

    def test_infrastructure_recipient_does_not_allow_other_addresses(self):
        for recipient in ["unapproved@example.invalid", "", "it-infrastructure@onesa.eu\nBcc: other@example.invalid"]:
            with self.subTest(recipient=recipient):
                self.values["OPERATIONS_NOTIFY_EMAIL"] = recipient
                with self.assertRaisesRegex(ValueError, "notification destination"):
                    monitor.prepare_notification_request(["backup-failed"])
                self.assertEqual(self.requests, [])

    def test_message_template_drift_does_not_change_pending_request(self):
        with patch.object(monitor, "worker_notification_detail",
                          side_effect=["", AssertionError("Never rebuild message text")]):
            self.assert_frozen_retry(lambda: None)

    def test_changed_credential_holds_event_and_restoration_does_not_release_hold(self):
        pending = self.ambiguous()
        self.values["RESEND_API_KEY"] = "synthetic-only-rotated"
        self.tick()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.read()["notification_pending"], pending)
        self.assertTrue(self.read()["notification_pending_envelope_hold"])
        self.assertTrue(self.read()["notification_reconciliation_required"])
        self.values["RESEND_API_KEY"] = "synthetic-only"
        self.tick()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.read()["notification_pending"], pending)

    def test_credential_change_between_preparation_and_post_never_sends(self):
        original_prepare = monitor.prepare_notification_request

        def prepare(*args, **kwargs):
            result = original_prepare(*args, **kwargs)
            self.values["RESEND_API_KEY"] = "synthetic-only-rotated"
            return result

        with patch.object(monitor, "prepare_notification_request", side_effect=prepare):
            with self.assertRaises(ValueError):
                self.tick()
        pending = self.read()["notification_pending"]
        self.assertEqual(self.requests, [])
        self.tick()
        self.assertTrue(self.read()["notification_reconciliation_required"])
        self.assertEqual(self.read()["notification_pending"], pending)

    def test_legacy_ambiguous_pending_keeps_identity_and_cooldown_without_guessing(self):
        self.tick()
        receipt = self.read("notification.json")
        self.failures = 1
        with self.assertRaises(TimeoutError):
            self.tick(elapsed=monitor.REMINDER_SECONDS)
        saved = self.read()
        del saved["notification_pending"]["mail_envelope"]
        pending = copy.deepcopy(saved["notification_pending"])
        self.save(saved)
        with patch.object(monitor, "prepare_notification_request",
                          side_effect=AssertionError("Legacy envelope cannot be guessed")):
            self.tick()
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.read()["notification_pending"], pending)
        self.assertEqual(self.read("notification.json"), receipt)
        self.assertTrue(self.read()["notification_pending_envelope_hold"])

    def test_changed_body_hash_or_reference_holds_without_provider_call(self):
        self.ambiguous()
        original = self.read()
        for field, value in [
            ("body", original["notification_pending"]["mail_envelope"]["body"] + " "),
            ("body_sha256", "0" * 64),
            ("reference", "00000000-0000-0000-0000-000000000000"),
            ("credential_fingerprint", "invalid"),
            ("notification_product", ["robot"]),
        ]:
            with self.subTest(field=field):
                saved = copy.deepcopy(original)
                saved["notification_pending"]["mail_envelope"][field] = value
                self.save(saved)
                self.tick()
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(self.read()["notification_pending"],
                                 saved["notification_pending"])
                self.assertTrue(self.read()["notification_pending_envelope_hold"])

    def test_invalid_mapping_holds_new_event_without_sending(self):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = '{"farmer":"alerts-farmer@onesa.eu"}'
        with self.assertRaises(ValueError):
            self.tick()
        pending = self.read()["notification_pending"]
        self.assertEqual(self.requests, [])
        self.assertTrue(self.read()["notification_reconciliation_required"])
        self.assertEqual(self.read("last-failure.json")["alerts"],
                         ["backend-api-unavailable"])
        del self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"]
        self.tick()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.read()["notification_pending"], pending)

    def test_mapping_rejects_ambiguous_or_unimplemented_routes(self):
        for raw in [
            "{", "null", "[]", "true",
            '{"ai":"alerts-ai@onesa.eu","ai":"notifications-ai@onesa.eu"}',
            '{"farmer":"notifications-farmer@onesa.eu"}',
            '{"farmer":"notifications-farmer@onesa.eu"}',
            '{"factory":"notifications-factory@onesa.eu"}',
            '{"ai":"notifications-robot@onesa.eu"}',
            '{"robot":"notifications-robot@mail.onesa.eu"}',
            '{"robot":["notifications-robot@onesa.eu"]}',
            '{"robot":"notifications-robot@onesa.eu,extra@example.invalid"}',
            json.dumps({"robot": "Robot\r\nBcc:extra@example.invalid <notifications-robot@onesa.eu>"}),
        ]:
            with self.subTest(raw=raw):
                self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = raw
                with self.assertRaises(ValueError):
                    monitor.prepare_notification_request(
                        ["backend-api-unavailable"], metrics=metrics("robot-production")
                    )
        self.assertEqual(self.requests, [])

    def test_sender_validation_blocks_header_injection_and_lists(self):
        for sender in [
            "Onesa\nPortal <notifications-portal@onesa.eu>",
            "first@example.invalid,second@example.invalid",
            " first@example.invalid", "..first@example.invalid", "missing-address",
        ]:
            with self.subTest(sender=sender):
                self.values["MAIL_FROM"] = sender
                with self.assertRaises(ValueError):
                    monitor.prepare_notification_request(["backup-failed"])
        self.assertEqual(self.requests, [])

    def test_absent_mapping_preserves_explicit_legacy_sender(self):
        self.values["MAIL_FROM"] = "ONESA Operations <operations@mail.onesa.eu>"
        self.tick()
        self.assertEqual(self.body()["from"], self.values["MAIL_FROM"])

    def test_single_product_production_failures_select_only_configured_senders(self):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        for product, sender in self.senders.items():
            with self.subTest(product=product):
                monitor.notify(["backend-api-unavailable"],
                               metrics=metrics(product + "-production"))
                self.assertEqual(self.body()["from"], sender)
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = '{"robot":"Onesa Robot <alerts-robot@onesa.eu>"}'
        monitor.notify(["backend-api-restarted"],
                       metrics=metrics(restarted=("robot-production",)))
        self.assertEqual(self.body()["from"], "Onesa Robot <alerts-robot@onesa.eu>")

    def test_mixed_shared_staging_and_unattributed_alerts_keep_portal_sender(self):
        self.senders["portal"] = "Onesa Portal <alerts-portal@onesa.eu>"
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        unknown = metrics("robot-production")
        unknown["backends"]["unknown-production"] = {"http_healthy": False}
        cases = [
            (["backend-api-unavailable"], metrics("ai-production", "robot-production")),
            (["backend-api-unavailable", "backup-failed"], metrics("robot-production")),
            (["backend-api-unavailable"], metrics("robot-staging")),
            (["backend-api-unavailable"], {"backend_api_healthy": False}),
            (["backend-api-unavailable"], unknown),
            (["backend-api-unavailable", "backend-api-restarted"], metrics("robot-production")),
        ]
        for alerts, value in cases:
            with self.subTest(alerts=alerts, backends=list(value.get("backends", {}))):
                monitor.notify(alerts, metrics=value)
                self.assertEqual(self.body()["from"], self.values["MAIL_FROM"])

    def test_mixed_incident_stays_shared_through_reminder_and_recovery(self):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        self.tick(metrics("ai-production", "robot-production"))
        self.tick(metrics("robot-production"), elapsed=monitor.REMINDER_SECONDS)
        for _ in range(6):
            self.tick(metrics())
        self.assertEqual(len(self.requests), 3)
        self.assertEqual([json.loads(request.data)["from"] for request in self.requests],
                         [self.values["MAIL_FROM"]] * 3)
        self.assertEqual(self.read("notification.json")["kind"], "recovery")

    def test_shared_incident_does_not_switch_sender_when_only_robot_still_fails(self):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        value = metrics("robot-production")
        value["scanner_ready"] = False
        self.tick(value)
        self.tick(metrics("robot-production"), elapsed=monitor.REMINDER_SECONDS)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.body()["from"], self.values["MAIL_FROM"])

    def test_single_product_recovery_keeps_product_classification(self):
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        self.tick()
        for _ in range(6):
            self.tick(metrics())
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.body()["from"], self.senders["robot"])
        self.assertEqual(self.read("notification.json")["kind"], "recovery")

    def test_simulation_keeps_portal_sender_and_actual_pending_untouched(self):
        self.senders["portal"] = "Onesa Portal <alerts-portal@onesa.eu>"
        self.values["OPERATIONS_MAIL_FROM_BY_PRODUCT"] = json.dumps(self.senders)
        pending = self.ambiguous()
        previous = (self.state / "metrics.json").read_bytes()
        self.tick(metrics(), simulation=True)
        self.assertEqual(self.body()["from"], self.values["MAIL_FROM"])
        self.assertEqual((self.state / "metrics.json").read_bytes(), previous)
        self.assertEqual(self.read()["notification_pending"], pending)
        self.assertTrue(self.read("simulation.json")["notification"]["simulation"])


if __name__ == "__main__":
    unittest.main()
