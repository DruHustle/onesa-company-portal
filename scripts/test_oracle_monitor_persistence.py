"""Offline interruption regressions for private monitor state; no provider calls."""

import contextlib
import importlib.util
import io
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "onesa_monitor_persistence", ROOT / "infra/oracle/operations/monitor.py"
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


def healthy_metrics():
    return {
        "worker_required": True,
        "worker_healthy": True,
        "scanner_ready": True,
        "signature_current": True,
        "backup_failed": False,
        "backup_age_seconds": 10,
        "disk_used_percent": 20,
        "memory_available_bytes": 1024 * 1024 * 1024,
        "database_available": True,
        "worker_restart_count": 4,
        "previous_restart_count": 4,
        "backend_restart_counts": {"robot-staging": 2},
    }


class MonitorPersistenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="onesa-monitor-test-")
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.metrics = healthy_metrics()
        self.sent = []
        self.initial = {
            "checked_at": "2026-10-23T00:00:00+00:00",
            "metrics": healthy_metrics(),
            "alerts": [],
            "healthy_samples": 2,
            "worker_restart_count": 4,
            "backend_restart_counts": {"robot-staging": 2},
        }
        self.path = self.state / "metrics.json"
        self.path.write_text(json.dumps(self.initial) + "\n")
        self.path.chmod(0o600)
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if path == Path("/etc/onesa/operations.json"):
                return '{"worker_required": true}'
            return original_read(path, *args, **kwargs)

        def notify(alerts, simulation=False, **kwargs):
            self.sent.append({"rules": alerts, "simulation": simulation, **kwargs})
            return {
                "reference": kwargs["reference"],
                "kind": kwargs["kind"],
                "checked_at": kwargs["checked_at"],
                "rules": alerts,
                "affected_backends": monitor.failed_backends(kwargs["metrics"]),
                "provider_receipt_id": "synthetic-receipt",
                "provider_accepted": True,
                "delivery_verified": False,
            }

        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(monitor, "STATE", self.state))
        self.stack.enter_context(patch.object(monitor.os, "geteuid", return_value=0))
        self.stack.enter_context(
            patch.object(monitor, "sample", side_effect=lambda _: dict(self.metrics))
        )
        self.stack.enter_context(patch.object(monitor, "notify", side_effect=notify))
        self.stack.enter_context(patch.object(Path, "read_text", read))
        self.stack.enter_context(
            patch.object(
                monitor.subprocess,
                "run",
                side_effect=AssertionError("No subprocess allowed"),
            )
        )
        self.stack.enter_context(
            patch.object(
                monitor.urllib.request,
                "build_opener",
                side_effect=AssertionError("No network allowed"),
            )
        )
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def run_monitor(self, simulate=False):
        with patch("sys.argv", ["monitor.py", *(["--simulate"] if simulate else [])]):
            monitor.main()

    @contextlib.contextmanager
    def interrupt_state_write(self, *, simulation=False, after_notification=False):
        original_write = Path.write_text
        target = "simulation.json" if simulation else "metrics.json"

        def write(path, text, *args, **kwargs):
            matches = path.parent == self.state and path.name in {
                target,
                target + ".tmp",
            }
            completed = not after_notification or "notification" in json.loads(text)
            if matches and completed:
                original_write(path, text[:17], *args, **kwargs)
                raise OSError("Injected interrupted state write")
            return original_write(path, text, *args, **kwargs)

        with patch.object(Path, "write_text", write):
            yield

    def test_interrupted_healthy_sample_preserves_previous_readable_state(self):
        before = self.path.read_bytes()
        with self.interrupt_state_write(), self.assertRaises(OSError):
            self.run_monitor()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(json.loads(self.path.read_text()), self.initial)
        self.assertEqual(self.sent, [])

    def test_next_sample_recovers_without_deleting_prior_state(self):
        with self.interrupt_state_write(), self.assertRaises(OSError):
            self.run_monitor()
        self.run_monitor()
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["worker_restart_count"], 4)
        self.assertEqual(saved["backend_restart_counts"], {"robot-staging": 2})
        self.assertEqual(saved["alerts"], [])
        self.assertEqual(self.sent, [])

    def test_completed_sample_has_private_mode_and_counter_baseline(self):
        self.run_monitor()
        saved = json.loads(self.path.read_text())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(saved["worker_restart_count"], 4)
        self.assertEqual(saved["backend_restart_counts"], {"robot-staging": 2})
        self.assertFalse(saved["delivery_verified"])
        self.assertNotIn("notification_pending", saved)

    def test_final_save_uses_one_atomic_replacement(self):
        original = Path.replace
        replacements = []

        def replace(path, destination):
            if Path(destination) == self.path:
                replacements.append(path)
            return original(path, destination)

        with patch.object(Path, "replace", replace):
            self.run_monitor()
        self.assertEqual(len(replacements), 1)
        self.assertEqual(replacements[0].name, "metrics.json.tmp")

    def test_interrupted_post_delivery_save_preserves_pending_identity(self):
        self.metrics["backend_api_healthy"] = False
        with (
            self.interrupt_state_write(after_notification=True),
            self.assertRaises(OSError),
        ):
            self.run_monitor()
        self.assertEqual(len(self.sent), 1)
        saved = json.loads(self.path.read_text())
        original_reference = self.sent[0]["reference"]
        self.assertEqual(saved["notification_pending"]["reference"], original_reference)
        self.run_monitor()
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[1]["reference"], original_reference)
        self.assertEqual(self.sent[1]["checked_at"], self.sent[0]["checked_at"])
        self.assertNotIn("notification_pending", json.loads(self.path.read_text()))

    def test_simulation_does_not_overwrite_real_metrics(self):
        before = self.path.read_bytes()
        self.run_monitor(simulate=True)
        simulation = self.state / "simulation.json"
        saved = json.loads(simulation.read_text())
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(set(saved["alerts"]), set(monitor.RULES))
        self.assertTrue(saved["simulation"])
        self.assertNotIn("worker_restart_count", saved)
        self.assertEqual(stat.S_IMODE(simulation.stat().st_mode), 0o600)
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0]["simulation"])

    def test_interrupted_simulation_preserves_prior_simulation_receipt(self):
        target = self.state / "simulation.json"
        target.write_text('{"simulation": true, "healthy_samples": 0}\n')
        target.chmod(0o600)
        before = target.read_bytes()
        with self.interrupt_state_write(simulation=True), self.assertRaises(OSError):
            self.run_monitor(simulate=True)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(json.loads(self.path.read_text()), self.initial)

    def test_failed_replacement_preserves_previous_state(self):
        before = self.path.read_bytes()
        original = Path.replace

        def replace(path, destination):
            if Path(destination) == self.path:
                raise OSError("Injected replacement failure")
            return original(path, destination)

        with patch.object(Path, "replace", replace), self.assertRaises(OSError):
            self.run_monitor()
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
