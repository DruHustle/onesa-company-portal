"""Failure and isolation tests; never hosted qualification evidence."""

import datetime
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import oracle_operations as ops
import oracle_recovery as recovery

SPEC = importlib.util.spec_from_file_location(
    "private_monitor", Path(__file__).parents[1] / "infra/oracle/operations/monitor.py"
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class OperationsGuards(unittest.TestCase):
    def setUp(self):
        self.metrics = {
            "worker_required": True,
            "worker_healthy": True,
            "failed_jobs": 0,
            "queue_age_seconds": 0,
            "deletion_age_seconds": 0,
            "scanner_ready": True,
            "signature_current": True,
            "backup_failed": False,
            "backup_age_seconds": 60,
            "disk_used_percent": 20,
            "memory_available_bytes": 1024 * 1024 * 1024,
            "database_available": True,
            "worker_restart_count": 0,
            "previous_restart_count": 0,
        }

    def test_all_nine_failure_classes_and_clearance(self):
        self.assertFalse(any(monitor.evaluate(self.metrics).values()))
        faults = {
            "worker-stopped": ("worker_healthy", False),
            "job-retry-exhausted": ("failed_jobs", 1),
            "queue-stalled": ("queue_age_seconds", 301),
            "clamav-unavailable": ("scanner_ready", False),
            "signature-update-failed": ("signature_current", False),
            "backup-failed": ("backup_failed", True),
            "resource-exhaustion": ("memory_available_bytes", 0),
            "database-unavailable": ("database_available", False),
            "worker-restarted": ("worker_restart_count", 1),
        }
        for name, (key, value) in faults.items():
            with self.subTest(rule=name):
                actual = monitor.evaluate({**self.metrics, key: value})
                self.assertEqual([n for n, v in actual.items() if v], [name])

    def test_stale_backup_and_disk_pressure_are_not_silent(self):
        self.assertTrue(
            monitor.evaluate({**self.metrics, "backup_age_seconds": 7201})[
                "backup-failed"
            ]
        )
        self.assertTrue(
            monitor.evaluate({**self.metrics, "disk_used_percent": 80})[
                "resource-exhaustion"
            ]
        )

    def test_install_cannot_write_vm_or_create_keys_before_source_qualification(self):
        with (
            patch.object(ops.worker, "qualified_source", side_effect=ValueError),
            patch.object(ops, "run") as remote,
            patch.object(ops, "public_key") as keys,
        ):
            with self.assertRaises(ValueError):
                ops.install("a" * 40)
            remote.assert_not_called()
            keys.assert_not_called()

    def test_wrong_recovered_application_key_cannot_start_database_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            master = private / "production-backup-encryption.key"
            master.write_bytes(b"m" * 32)
            master.chmod(0o600)
            (private / "production-operations-installation.json").write_text(
                json.dumps(
                    {
                        "source_commit": "a" * 40,
                        "backup": {
                            "object_count": 1,
                            "object_key": "synthetic-backup",
                            "key_id": "synthetic-key",
                            "ciphertext_sha256": "b" * 64,
                        },
                    }
                )
            )
            values = {
                "DATABASE_URL": "postgresql://synthetic@"
                + ops.production.DATABASE_HOST
                + "/neondb",
                "S3_ENDPOINT": "https://" + ops.production.BUCKET_HOST,
                "S3_REGION": "synthetic-region",
                "S3_BUCKET": "synthetic-bucket",
                "AWS_ACCESS_KEY_ID": "synthetic-access",
                "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
                "SESSION_KEY": "approved-synthetic-key",
            }
            with (
                patch.object(ops, "PRIVATE", private),
                patch.object(ops.worker, "qualified_source"),
                patch.object(ops.production, "provider", return_value=[]),
                patch.object(ops.production, "inventory", return_value=values),
                patch.object(
                    recovery,
                    "run",
                    return_value=json.dumps(
                        {"session_key": "wrong-synthetic-key"}
                    ).encode(),
                ) as commands,
            ):
                with self.assertRaisesRegex(
                    ValueError, "Recovered application key differs"
                ):
                    recovery.recover("a" * 40)
                self.assertEqual(commands.call_count, 1)
                self.assertEqual(commands.call_args.args[0][0], "node")
                self.assertFalse(list(private.glob("independent-restore-*")))

    def test_notification_uses_identified_client_and_does_not_follow_redirects(self):
        values = {
            "MAIL_PROVIDER": "resend",
            "NOTIFY_EMAIL": "andrew@onesa.eu",
            "MAIL_FROM": "synthetic@example.invalid",
            "RESEND_API_KEY": "synthetic-only",
        }
        captured = []

        def open_request(request, timeout):
            captured.append(request)
            return io.BytesIO(b'{"id":"synthetic-receipt"}')

        with (
            patch.dict(
                "sys.modules",
                {"backup": SimpleNamespace(checked_env=lambda: (values, None))},
            ),
            patch.object(
                monitor.urllib.request,
                "build_opener",
                return_value=SimpleNamespace(open=open_request),
            ) as build,
        ):
            result = monitor.notify(["backup-failed"], simulation=True)
        self.assertEqual(
            captured[0].get_header("User-agent"), "Onesa-Portal-Operations/1.0"
        )
        self.assertIsNone(
            build.call_args.args[0].redirect_request(None, None, None, None, None, None)
        )
        self.assertTrue(result["provider_accepted"])
        self.assertFalse(result["delivery_verified"])

    def test_failure_details_are_scoped_and_reference_is_retained(self):
        metrics = {
            "backends": {
                "robot-production": {
                    "container_healthy": False,
                    "http_healthy": False,
                    "http_status": 503,
                    "secret": "never-serialize",
                },
                "portal-staging": {
                    "container_healthy": True,
                    "http_healthy": True,
                    "http_status": 200,
                },
                "unapproved-host": {"container_healthy": False, "http_status": 500},
            }
        }
        values = {
            "MAIL_PROVIDER": "resend",
            "NOTIFY_EMAIL": "andrew@onesa.eu",
            "MAIL_FROM": "synthetic@example.invalid",
            "RESEND_API_KEY": "synthetic",
        }
        requests = []

        def opened(request, timeout):
            requests.append(json.loads(request.data))
            return io.BytesIO(b'{"id":"synthetic-receipt"}')

        with (
            patch.dict(
                "sys.modules",
                {"backup": SimpleNamespace(checked_env=lambda: (values, None))},
            ),
            patch.object(
                monitor.urllib.request,
                "build_opener",
                return_value=SimpleNamespace(open=opened),
            ),
        ):
            result = monitor.notify(
                ["backend-api-unavailable"],
                metrics=metrics,
                checked_at="2026-10-17T14:00:00+00:00",
            )
        self.assertIn(
            "robot-production; container=unhealthy; public HTTPS=503",
            requests[0]["text"],
        )
        self.assertIn("Reference: " + result["reference"], requests[0]["text"])
        self.assertIn("Observed at (UTC):", requests[0]["text"])
        self.assertNotIn("never-serialize", str(result) + str(requests))
        self.assertNotIn("unapproved-host", str(result) + str(requests))
        self.assertEqual(list(result["affected_backends"]), ["robot-production"])

    def test_failure_and_recovery_preserve_distinct_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config = state / "config.json"
            config.write_text("{}")
            actual_read = Path.read_text

            def read(path, *args, **kwargs):
                return (
                    config.read_text()
                    if str(path) == "/etc/onesa/operations.json"
                    else actual_read(path, *args, **kwargs)
                )

            failed = {
                **self.metrics,
                "backend_api_healthy": False,
                "backends": {
                    "robot-production": {
                        "container_healthy": False,
                        "http_healthy": False,
                        "http_status": 503,
                    }
                },
            }
            with (
                patch.object(monitor, "STATE", state),
                patch.object(monitor.os, "geteuid", return_value=0),
                patch.object(
                    monitor.argparse.ArgumentParser,
                    "parse_args",
                    return_value=SimpleNamespace(simulate=False),
                ),
                patch.object(monitor.Path, "read_text", read),
                patch.object(monitor, "sample", side_effect=[failed, self.metrics]),
                patch.object(
                    monitor, "notify", return_value={"reference": "synthetic-reference"}
                ) as notify,
                patch("builtins.print"),
            ):
                monitor.main()
                preserved = (state / "last-failure.json").read_bytes()
                monitor.main()
            self.assertEqual(notify.call_count, 1)
            self.assertEqual((state / "last-failure.json").read_bytes(), preserved)
            recovery = json.loads((state / "last-recovery.json").read_text())
            self.assertEqual(recovery["cleared_alerts"], ["backend-api-unavailable"])
            self.assertEqual(
                list(recovery["previous_failed_backends"]), ["robot-production"]
            )
            incident = json.loads((state / "last-notified-incident.json").read_text())
            self.assertEqual(
                incident["notification"]["reference"], "synthetic-reference"
            )
            self.assertEqual(
                (state / "last-notified-incident.json").stat().st_mode & 0o777, 0o600
            )

    def test_monitor_never_stops_restarts_or_deletes_services(self):
        source = Path(monitor.__file__).read_text()
        for command in ["'stop'", "'restart'", "'rm'", "'kill'", "'pause'"]:
            self.assertNotIn(command, source)

    def test_new_backend_failures_preserve_existing_alert_rules(self):
        for key, rule in [
            ("backend_api_healthy", "backend-api-unavailable"),
            ("backend_api_restarted", "backend-api-restarted"),
        ]:
            with self.subTest(rule=rule):
                metrics = {**self.metrics, key: key.endswith("restarted")}
                self.assertEqual(
                    [k for k, v in monitor.evaluate(metrics).items() if v], [rule]
                )


class BackendMonitoring(unittest.TestCase):
    def test_optional_monitor_and_acquisition_budget_preserve_existing_timer(self):
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if str(path) == "/proc/meminfo":
                return "MemAvailable: 1048576 kB\n"
            return original_read(path, *args, **kwargs)

        def acquire(command, timeout=35):
            if command[1] == "inspect":
                return json.dumps(
                    [{"Name": "/synthetic-scanner", "RestartCount": 0}]
                ).encode()
            if command[1] == "exec":
                return b""
            return b'{"database_available":true,"scanner_ready":true}'

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(monitor, "STATE", Path(directory)),
            patch.object(monitor.Path, "read_text", read),
            patch.object(
                monitor.shutil,
                "disk_usage",
                return_value=SimpleNamespace(used=20, total=100),
            ),
            patch.object(monitor, "run", side_effect=acquire) as commands,
            patch.object(
                monitor, "sample_backends", return_value={"backend_api_healthy": True}
            ) as backends,
        ):
            monitor.sample({"worker_required": True, "image": "synthetic-image"})
            backends.assert_not_called()
            monitor.sample(
                {
                    "worker_required": True,
                    "image": "synthetic-image",
                    "backend_monitoring_enabled": True,
                }
            )
            backends.assert_called_once_with({})
        # Two3s inspect reads,3s scanner read,20s aggregate DB read, up to7s
        # backend sampling and20s notification leave4s in the60s service budget.
        self.assertEqual(
            [call.kwargs["timeout"] for call in commands.call_args_list[:4]],
            [3, 3, 3, 20],
        )
        self.assertLess(
            sum(call.kwargs["timeout"] for call in commands.call_args_list[:4])
            + 7
            + 20,
            60,
        )

    def containers(self):
        return [
            {
                "Name": "/" + value["container"],
                "State": {
                    "Running": True,
                    "Health": {"Status": "healthy"},
                    "OOMKilled": False,
                },
                "Config": {
                    "Labels": {
                        "org.onesa.product": value["product"],
                        "org.onesa.environment": value["environment"],
                    },
                    "Env": ["SYNTHETIC_PRIVATE_VALUE=never-serialize"],
                },
                "HostConfig": {
                    "PortBindings": {
                        "8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18001"}]
                    }
                },
                "RestartCount": 0,
            }
            for value in monitor.BACKENDS.values()
        ]

    def sample(self, rows, previous=None):
        response = SimpleNamespace(stdout=json.dumps(rows).encode(), returncode=0)
        with (
            patch.object(monitor.subprocess, "run", return_value=response) as inspect,
            patch.object(
                monitor,
                "probe_backend",
                return_value={"http_healthy": True, "http_status": 200},
            ),
        ):
            result = monitor.sample_backends(previous or {})
        self.assertEqual(inspect.call_args.kwargs["timeout"], 3)
        self.assertNotIn("never-serialize", str(result))
        return result

    def test_existing_six_targets_healthy_without_false_restart(self):
        result = self.sample(self.containers())
        self.assertEqual(len(result["backends"]), 6)
        self.assertTrue(result["backend_api_healthy"])
        self.assertFalse(result["backend_api_restarted"])

    def test_missing_wrong_environment_and_public_ports_fail_closed(self):
        rows = self.containers()
        self.assertFalse(self.sample(rows[:-1])["backend_api_healthy"])
        rows[0]["Config"]["Labels"]["org.onesa.environment"] = "wrong"
        self.assertFalse(self.sample(rows)["backend_api_healthy"])
        rows = self.containers()
        rows[0]["HostConfig"]["PortBindings"]["8000/tcp"][0]["HostIp"] = "0.0.0.0"
        self.assertFalse(self.sample(rows)["backend_api_healthy"])

    def test_unhealthy_oom_and_unexpected_restart_are_observed_without_action(self):
        for key, value in [
            ("Running", False),
            ("OOMKilled", True),
            ("Health", {"Status": "unhealthy"}),
        ]:
            rows = self.containers()
            rows[0]["State"][key] = value
            self.assertFalse(self.sample(rows)["backend_api_healthy"])
        rows = self.containers()
        rows[0]["RestartCount"] = 2
        self.assertTrue(
            self.sample(rows, {"portal-staging": 1})["backend_api_restarted"]
        )
        self.assertFalse(self.sample(rows)["backend_api_restarted"])

    def test_http_liveness_has_expected_json_and_bounded_credential_free_transport(
        self,
    ):
        for name, value in monitor.BACKENDS.items():
            payload = (
                json.dumps(
                    {
                        "status": value["status"],
                        "mode": "simulation",
                        "physical_actuation": False,
                    }
                ).encode()
                + b"\n200"
            )
            with patch.object(
                monitor.subprocess,
                "run",
                return_value=SimpleNamespace(stdout=payload, returncode=0),
            ) as request:
                self.assertTrue(monitor.probe_backend(name)["http_healthy"])
            args = request.call_args.args[0]
            self.assertEqual(
                args[:4], ["/usr/bin/curl", "--disable", "--proto", "=https"]
            )
            self.assertEqual(args[-1], value["url"])
            self.assertEqual("/ready" in args[-1], value["product"] == "robot")
            self.assertNotIn("--location", args)
            self.assertFalse(
                any("authorization" in v.lower() or "cookie" in v.lower() for v in args)
            )
            self.assertEqual(request.call_args.kwargs["timeout"], 6)
            self.assertEqual(args[args.index("--max-time") + 1], "5")
            self.assertEqual(args[args.index("--connect-timeout") + 1], "3")

    def test_html_redirect_invalid_json_and_oversize_are_not_health(self):
        for body, code, exit_code in [
            (b"<html>synthetic-private-body</html>", b"200", 0),
            (b'{"status":"ok"}', b"302", 0),
            (b"[]", b"200", 0),
            (b'{"status":"wrong"}', b"200", 0),
            (b"x" * 513, b"200", 0),
            (b'{"status":"ok"}', b"200", 1),
        ]:
            with patch.object(
                monitor.subprocess,
                "run",
                return_value=SimpleNamespace(
                    stdout=body + b"\n" + code, returncode=exit_code
                ),
            ):
                result = monitor.probe_backend("portal-production")
                self.assertFalse(result["http_healthy"])
                self.assertNotIn("synthetic-private-body", str(result))

    def test_transport_timeout_and_unapproved_target_never_succeed(self):
        with patch.object(
            monitor.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("synthetic", 4),
        ) as probe:
            self.assertEqual(
                monitor.probe_backend("ai-production"),
                {"http_healthy": False, "http_status": 0, "http_error": "timeout"},
            )
            self.assertEqual(probe.call_count, 2)
        with patch.object(monitor.subprocess, "run") as request:
            with self.assertRaises(KeyError):
                monitor.probe_backend("unapproved")
            request.assert_not_called()

    def test_transient_probe_retries_once_but_http_and_tls_failures_do_not(self):
        for code in (6, 7, 28):
            with (
                self.subTest(code=code),
                patch.object(
                    monitor.subprocess,
                    "run",
                    side_effect=[
                        SimpleNamespace(stdout=b"\n000", returncode=code),
                        SimpleNamespace(stdout=b'{"status":"ok"}\n200', returncode=0),
                    ],
                ) as probe,
            ):
                self.assertTrue(monitor.probe_backend("ai-production")["http_healthy"])
                self.assertEqual(probe.call_count, 2)
        for code, status in ((60, b"000"), (35, b"000"), (22, b"503")):
            with (
                self.subTest(code=code),
                patch.object(
                    monitor.subprocess,
                    "run",
                    return_value=SimpleNamespace(
                        stdout=b"\n" + status, returncode=code
                    ),
                ) as probe,
            ):
                self.assertFalse(monitor.probe_backend("ai-production")["http_healthy"])
                self.assertEqual(probe.call_count, 1)


if __name__ == "__main__":
    unittest.main()


class NotificationLifecycle(unittest.TestCase):
    def setUp(self):
        OperationsGuards.setUp(self)
        self.now = 1792770000
        self.failed = {
            **self.metrics,
            "backend_api_healthy": False,
            "backends": {
                "robot-production": {
                    "container_healthy": False,
                    "http_healthy": False,
                    "http_status": 503,
                }
            },
        }
        self.last = {
            "rules": ["backend-api-unavailable"],
            "kind": "alert",
            "affected_backends": {"robot-production": {}},
            "checked_at": "2026-10-23T15:40:00+00:00",
        }
        self.now = (
            __import__("datetime")
            .datetime.fromisoformat(self.last["checked_at"])
            .timestamp()
        )
        self.sample_time = self.now

    def decision(self, metrics=None, previous=None, last=None, elapsed=0):
        return monitor.notification_decision(
            ["backend-api-unavailable"],
            metrics or self.failed,
            previous or {"alerts": ["backend-api-unavailable"], "healthy_samples": 0},
            self.last if last is None else last,
            self.now + elapsed,
        )

    def test_sustained_incident_is_not_emailed_every_thirty_minutes(self):
        for elapsed in [60, 1800, 3600, 21599]:
            self.assertEqual(self.decision(elapsed=elapsed), (None, 0))
        self.assertEqual(self.decision(elapsed=21600), ("reminder", 0))

    def test_new_affected_service_and_new_rule_are_grouped_for_thirty_minutes(self):
        metrics = {
            **self.failed,
            "backends": {
                **self.failed["backends"],
                "portal-production": {"container_healthy": False, "http_status": 503},
            },
        }
        self.assertIsNone(self.decision(metrics=metrics, elapsed=1799)[0])
        self.assertEqual(self.decision(metrics=metrics, elapsed=1800)[0], "update")
        self.assertEqual(
            monitor.notification_decision(
                ["backend-api-unavailable", "backup-failed"],
                self.failed,
                {"healthy_samples": 0},
                self.last,
                self.now + 1800,
            )[0],
            "update",
        )

    def test_status_noise_does_not_create_a_new_incident(self):
        changed = {
            **self.failed,
            "backends": {
                "robot-production": {
                    "container_healthy": False,
                    "http_healthy": False,
                    "http_status": 502,
                }
            },
        }
        self.assertIsNone(self.decision(metrics=changed)[0])

    def test_recovery_requires_five_minutes_and_six_fresh_healthy_samples(self):
        self.assertEqual(
            monitor.notification_decision(
                [],
                self.metrics,
                {"alerts": ["backend-api-unavailable"], "healthy_samples": 0},
                self.last,
                self.now,
            ),
            (None, 1),
        )
        self.assertEqual(
            monitor.notification_decision(
                [],
                self.metrics,
                {
                    "alerts": [],
                    "healthy_samples": 1,
                    "incident_open": True,
                    "checked_at": self.last["checked_at"],
                    "healthy_since": self.last["checked_at"],
                },
                self.last,
                self.now + 60,
            ),
            (None, 2),
        )
        self.assertIsNone(
            self.decision(previous={"alerts": [], "healthy_samples": 1})[0]
        )
        self.assertEqual(self.decision(previous={"incident_open": False})[0], "alert")
        self.assertIsNone(
            self.decision(previous={"incident_open": True, "healthy_samples": 2})[0]
        )
        self.assertEqual(
            monitor.notification_decision(
                [],
                self.metrics,
                {
                    "alerts": [],
                    "healthy_samples": 5,
                    "incident_open": True,
                    "checked_at": datetime.datetime.fromtimestamp(
                        self.now + 240, datetime.timezone.utc
                    ).isoformat(),
                    "healthy_since": self.last["checked_at"],
                },
                self.last,
                self.now + 300,
            ),
            ("recovery", 6),
        )

    def test_initial_migration_does_not_email_a_historical_recovery(self):
        self.assertEqual(
            monitor.notification_decision(
                [], self.metrics, {"alerts": []}, self.last, self.now
            ),
            (None, 1),
        )

    def test_robot_liveness_200_cannot_substitute_for_readiness(self):
        for body in [
            {"status": "live", "mode": "simulation", "physical_actuation": False},
            {"status": "ready", "mode": "simulation", "physical_actuation": True},
            [],
            {"status": "ready"},
        ]:
            with patch.object(
                monitor.subprocess,
                "run",
                return_value=SimpleNamespace(
                    stdout=json.dumps(body).encode() + b"\n200", returncode=0
                ),
            ):
                self.assertFalse(
                    monitor.probe_backend("robot-production")["http_healthy"]
                )

    def run_monitor(self, state, samples, sender):
        actual_read = Path.read_text

        def read(path, *args, **kwargs):
            return (
                "{}"
                if str(path) == "/etc/onesa/operations.json"
                else actual_read(path, *args, **kwargs)
            )

        with (
            patch.object(monitor, "STATE", state),
            patch.object(monitor.os, "geteuid", return_value=0),
            patch.object(
                monitor.argparse.ArgumentParser,
                "parse_args",
                return_value=SimpleNamespace(simulate=False),
            ),
            patch.object(monitor.Path, "read_text", read),
            patch.object(monitor, "sample", side_effect=samples),
            patch.object(monitor.time, "time", side_effect=lambda: self.sample_time),
            patch.object(monitor, "notify", side_effect=sender),
            patch("builtins.print"),
        ):
            for _ in samples:
                self.sample_time += 60
                monitor.main()

    def test_ambiguous_delivery_keeps_identical_reference_and_body_across_timer_runs(
        self,
    ):
        calls = []

        def send(alerts, simulation, **kwargs):
            calls.append((alerts, kwargs))
            if len(calls) == 1:
                raise TimeoutError("synthetic ambiguous provider result")
            return {
                "reference": kwargs["reference"],
                "rules": alerts,
                "affected_backends": monitor.failed_backends(kwargs["metrics"]),
            }

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with self.assertRaises(TimeoutError):
                self.run_monitor(state, [self.failed], send)
            pending = json.loads((state / "metrics.json").read_text())[
                "notification_pending"
            ]
            self.assertEqual(pending["reference"], calls[0][1]["reference"])
            self.run_monitor(state, [self.failed], send)
            self.assertEqual(calls[0], calls[1])
            self.assertNotIn(
                "notification_pending", json.loads((state / "metrics.json").read_text())
            )
            self.assertEqual(
                json.loads((state / "notification.json").read_text())["reference"],
                pending["reference"],
            )

    def test_recovery_is_sent_once_and_existing_failures_remain_preserved(self):
        calls = []

        def send(alerts, simulation, **kwargs):
            calls.append(kwargs["kind"])
            return {
                "reference": kwargs["reference"],
                "rules": alerts,
                "affected_backends": monitor.failed_backends(kwargs["metrics"]),
            }

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.run_monitor(state, [self.failed, *([self.metrics] * 8)], send)
            self.assertEqual(calls, ["alert", "recovery"])
            failure = json.loads((state / "last-failure.json").read_text())
            self.assertEqual(failure["alerts"], ["backend-api-unavailable"])
            self.assertEqual(
                json.loads((state / "notification.json").read_text())["kind"],
                "recovery",
            )

    def test_delayed_delivery_keeps_failure_evidence_and_then_reports_recovery(self):
        calls = []

        def send(alerts, simulation, **kwargs):
            calls.append((alerts, kwargs))
            if len(calls) == 1:
                raise TimeoutError("synthetic")
            return {
                "reference": kwargs["reference"],
                "rules": alerts,
                "affected_backends": monitor.failed_backends(kwargs["metrics"]),
            }

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with self.assertRaises(TimeoutError):
                self.run_monitor(state, [self.failed], send)
            self.run_monitor(state, [self.metrics], send)
            record = json.loads((state / "last-notified-incident.json").read_text())
            self.assertEqual(record["alerts"], ["backend-api-unavailable"])
            self.assertFalse(record["metrics"]["backend_api_healthy"])
            self.run_monitor(state, [self.metrics] * 6, send)
            self.assertEqual(
                [v[1]["kind"] for v in calls], ["alert", "alert", "recovery"]
            )
            self.assertEqual(calls[0], calls[1])

    def test_pending_delivery_stops_before_provider_idempotency_expiry(self):

        expired = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
        ).isoformat()
        pending = {
            "reference": str(uuid.uuid4()),
            "kind": "alert",
            "alerts": ["backend-api-unavailable"],
            "metrics": self.failed,
            "checked_at": expired,
            "recovered_backends": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "metrics.json").write_text(
                json.dumps(
                    {
                        "alerts": ["backend-api-unavailable"],
                        "healthy_samples": 0,
                        "notification_pending": pending,
                    }
                )
            )

            def forbidden(*args, **kwargs):
                raise AssertionError("Expired idempotency key was retried")

            self.run_monitor(state, [self.failed], forbidden)
            saved = json.loads((state / "metrics.json").read_text())
            self.assertTrue(saved["notification_reconciliation_required"])
            self.assertEqual(saved["notification_pending"], pending)
            self.assertEqual(
                json.loads((state / "last-failure.json").read_text())["alerts"],
                ["backend-api-unavailable"],
            )

    def test_unchanged_critical_rules_use_six_hour_reminders(self):
        for alerts in [
            ["backup-failed"],
            ["resource-exhaustion"],
            ["backend-api-unavailable", "backup-failed"],
        ]:
            last = {**self.last, "rules": alerts}
            self.assertEqual(
                monitor.notification_decision(
                    alerts, self.failed, {"healthy_samples": 0}, last, self.now + 21600
                )[0],
                "reminder",
            )
            self.assertIsNone(
                monitor.notification_decision(
                    alerts, self.failed, {"healthy_samples": 0}, last, self.now + 21599
                )[0]
            )

    def test_two_hours_of_changing_rules_and_brief_health_stays_one_incident(self):
        calls = []
        recovered_backends = []

        def send(alerts, simulation, **kwargs):
            calls.append(kwargs["kind"])
            if kwargs["kind"] == "recovery":
                recovered_backends.extend(kwargs["recovered_backends"])
            return {
                "reference": kwargs["reference"],
                "rules": alerts,
                "affected_backends": monitor.failed_backends(kwargs["metrics"]),
            }

        unavailable = {
            **self.failed,
            "scanner_ready": False,
            "database_available": False,
        }
        low_memory = {**self.metrics, "memory_available_bytes": 128 * 1024 * 1024}
        both = {**unavailable, "memory_available_bytes": 128 * 1024 * 1024}
        cycle = [unavailable, both, low_memory, self.metrics, self.metrics, low_memory]
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.run_monitor(state, cycle * 20, send)
            self.assertEqual(calls, ["alert", "update"])
            last = json.loads((state / "notification.json").read_text())
            self.assertEqual(
                set(last["incident_rules"]),
                {
                    "backend-api-unavailable",
                    "database-unavailable",
                    "clamav-unavailable",
                    "resource-exhaustion",
                },
            )
            self.assertTrue(
                json.loads((state / "metrics.json").read_text())["incident_open"]
            )
            self.assertEqual(
                json.loads((state / "last-failure.json").read_text())["alerts"],
                ["resource-exhaustion"],
            )
            self.run_monitor(state, [self.metrics] * 8, send)
            self.assertEqual(calls, ["alert", "update", "recovery"])
            self.assertEqual(recovered_backends, ["robot-production"])
            self.assertFalse(
                json.loads((state / "metrics.json").read_text())["incident_open"]
            )
            self.run_monitor(state, [self.failed], send)
            self.assertEqual(calls[-1], "alert")

    def test_missing_samples_reset_recovery_confirmation(self):
        calls = []

        def send(alerts, simulation, **kwargs):
            calls.append(kwargs["kind"])
            return {"reference": kwargs["reference"], "rules": alerts}

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            self.run_monitor(state, [self.failed, *([self.metrics] * 5)], send)
            self.assertEqual(calls, ["alert"])
            self.sample_time += 300
            self.run_monitor(state, [self.metrics], send)
            self.assertEqual(
                json.loads((state / "metrics.json").read_text())["healthy_samples"], 1
            )
            self.assertEqual(calls, ["alert"])
            self.run_monitor(state, [self.metrics] * 5, send)
            self.assertEqual(calls, ["alert", "recovery"])

    def test_partial_improvement_does_not_send_an_update(self):
        last = {
            **self.last,
            "rules": ["backend-api-unavailable", "database-unavailable"],
        }
        self.assertIsNone(self.decision(last=last, elapsed=1800)[0])
        self.assertEqual(self.decision(last=last, elapsed=21600)[0], "reminder")

    def test_fast_repeated_samples_cannot_confirm_recovery(self):
        previous = {
            "alerts": [],
            "incident_open": True,
            "healthy_samples": 5,
            "healthy_since": self.last["checked_at"],
            "checked_at": self.last["checked_at"],
        }
        self.assertEqual(
            monitor.notification_decision(
                [], self.metrics, previous, self.last, self.now + 1
            ),
            (None, 6),
        )

    def test_clock_rollback_and_invalid_times_do_not_send_repeated_mail(self):
        for value in [
            None,
            "invalid",
            "2026-10-23T15:40:00",
            "2026-10-24T15:40:00+00:00",
        ]:
            last = {**self.last, "checked_at": value}
            self.assertIsNone(self.decision(last=last, elapsed=1800)[0])

    def test_configured_update_cooldown_is_bounded_and_honored(self):
        alerts = ["backend-api-unavailable", "backup-failed"]
        self.assertEqual(
            monitor.notification_decision(
                alerts,
                self.failed,
                {"incident_open": True},
                self.last,
                self.now + 60,
                cooldown_seconds=60,
            )[0],
            "update",
        )
        for value in [True, "1800", 0, -1, 21601]:
            with self.assertRaises(ValueError):
                monitor.notification_decision(
                    alerts,
                    self.failed,
                    {},
                    self.last,
                    self.now,
                    cooldown_seconds=value,
                )
