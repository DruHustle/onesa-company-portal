"""Disposable recovery-state and process-identity fault tests; no host actuation."""

import copy
import datetime as dt
import importlib.util
import ast
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "onesa_runtime_recovery", ROOT / "infra/oracle/operations/recovery.py"
)
recovery = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = recovery
SPEC.loader.exec_module(recovery)
NOW = 1800000000
NAME = "portal-api-production"


def fixture(name=NAME):
    target = recovery.TARGETS[name]
    row = {
        "Id": ("a" if target.environment == "production" else "b") * 64,
        "Name": "/" + target.name, "Image": "sha256:" + "c" * 64,
        "Config": {
            "User": "node", "Entrypoint": ["docker-entrypoint.sh"],
            "Cmd": ["node", "dist/src/server.js" if target.role == "api" else "dist/src/jobs/worker.js"],
            "StopTimeout": target.grace_seconds,
            "Labels": {"org.onesa.source-commit": "d" * 40,
                       "com.docker.compose.project": target.project,
                       "com.docker.compose.service": target.service},
            "Env": ["SYNTHETIC_ONLY=not-a-secret"],
        },
        "HostConfig": {
            "RestartPolicy": {"Name": "unless-stopped"}, "Init": True,
            "ReadonlyRootfs": True, "Privileged": False, "CapAdd": None,
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "PidMode": "", "NetworkMode": "test-network",
            "PortBindings": {"8300/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18300"}]},
        },
        "Mounts": [], "NetworkSettings": {"Networks": {"fixture": {"NetworkID": "e" * 64}}},
        "State": {"Running": True, "Status": "running", "Paused": False,
                  "Restarting": False, "Dead": False, "Pid": 321,
                  "StartedAt": dt.datetime.fromtimestamp(NOW - 600, dt.timezone.utc).isoformat(),
                  "Health": {"Status": "unhealthy"}},
    }
    binding = {"container_id": row["Id"], "image_id": row["Image"],
               "source_commit": "d" * 40, "configuration_sha256": recovery.fingerprint(row)}
    return row, binding


class FakeRuntime:
    def __init__(self, row):
        self.row = row
        self.status = "failed"
        self.recoveries = []
        self.probes = 0
        self.probe_override = None
        self.failure = None
        self.inspect_error = False

    def inspect(self, _container_id):
        if self.inspect_error:
            raise recovery.Refused("DOCKER_INSPECTION_FAILED")
        return copy.deepcopy(self.row)

    def probe(self, target, binding):
        self.probes += 1
        return self.probe_override(self.probes) if self.probe_override else self.status

    def recover(self, target, binding, original, before_signal):
        before_signal()
        self.recoveries.append((target.name, binding["container_id"], original["Image"]))
        if self.failure:
            raise self.failure
        return "graceful-exit-observed"


class ControllerTests(unittest.TestCase):
    def setUp(self):
        row, binding = fixture()
        self.runtime = FakeRuntime(row)
        self.config = {"schema_version": 1, "enabled": True, "targets": {NAME: binding}}
        self.state = recovery.initial_state(self.config, NOW)
        self.saved = []
        self.controller = recovery.Controller(self.runtime, lambda value: self.saved.append(copy.deepcopy(value)))

    def tick(self, elapsed, guard=lambda: None):
        self.state = self.controller.tick(self.config, self.state, NOW + elapsed, guard)
        return self.state["targets"][NAME]

    def confirm(self, offset=0):
        for elapsed in (offset, offset + 60, offset + 120):
            self.tick(elapsed)

    def test_confirmed_failure_records_durable_intent_before_one_signal(self):
        self.confirm()
        self.assertEqual(len(self.runtime.recoveries), 1)
        intent = next(value for value in self.saved if value["targets"][NAME]["pending"])
        self.assertEqual(intent["targets"][NAME]["attempts"], [NOW + 120])
        self.assertEqual(intent["targets"][NAME]["result"], "signal-intent-recorded")
        self.assertIsNone(self.state["targets"][NAME]["pending"])
        self.assertEqual(self.runtime.recoveries[0][2], self.config["targets"][NAME]["image_id"])

    def test_dependency_unhealthy_does_not_restart_responsive_process(self):
        self.runtime.status = "healthy"
        self.confirm()
        self.assertEqual(self.runtime.row["State"]["Health"]["Status"], "unhealthy")
        self.assertEqual(self.runtime.recoveries, [])
        self.assertEqual(self.state["targets"][NAME]["result"], "healthy")

    def test_unknown_and_missing_docker_observations_reset_failure_confirmation(self):
        self.tick(0)
        self.tick(60)
        self.runtime.status = "unknown"
        self.tick(120)
        self.runtime.status = "failed"
        self.tick(180)
        self.runtime.inspect_error = True
        self.tick(240)
        self.runtime.inspect_error = False
        self.tick(300)
        self.assertEqual(self.runtime.recoveries, [])

    def test_rapid_or_missing_samples_cannot_invent_confirmation(self):
        for elapsed in (0, 0, 1, 2, 3, 124, 125, 126):
            self.tick(elapsed)
        self.assertEqual(self.runtime.recoveries, [])

    def test_backward_clock_blocks_before_observation(self):
        self.tick(60)
        with self.assertRaisesRegex(recovery.Refused, "CLOCK_REGRESSION"):
            self.tick(59)
        self.assertEqual(self.runtime.recoveries, [])

    def test_stopped_paused_restarting_and_dead_containers_are_never_started(self):
        for values in ({"Running": False, "Status": "exited", "Pid": 0},
                       {"Paused": True}, {"Restarting": True}, {"Dead": True}):
            with self.subTest(values=values):
                self.setUp()
                self.runtime.row["State"].update(values)
                self.confirm()
                self.assertEqual(self.runtime.recoveries, [])
                self.assertEqual(self.runtime.probes, 0)

    def test_new_incarnation_and_startup_grace_reset_streak(self):
        self.tick(0)
        self.tick(60)
        self.runtime.row["State"].update(Pid=322, StartedAt=dt.datetime.fromtimestamp(NOW + 90, dt.timezone.utc).isoformat())
        self.tick(120)
        self.tick(180)
        self.tick(240)
        self.assertEqual(self.runtime.recoveries, [])
        self.confirm(300)
        self.assertEqual(len(self.runtime.recoveries), 1)

    def test_last_moment_health_recheck_avoids_restarting_recovered_api(self):
        self.runtime.probe_override = lambda count: "healthy" if count == 4 else "failed"
        self.confirm()
        self.assertEqual(self.runtime.recoveries, [])
        self.assertEqual(self.state["targets"][NAME]["attempts"], [])

    def test_maintenance_or_deployment_hold_prevents_actuation(self):
        def hold():
            raise recovery.Refused("OWNER_MAINTENANCE_HOLD")
        self.tick(0)
        self.tick(60)
        self.tick(120, hold)
        self.assertEqual(self.runtime.recoveries, [])
        self.assertEqual(self.state["targets"][NAME]["attempts"], [])

    def test_image_or_private_configuration_change_refuses_without_action(self):
        changes = [lambda row: row.update(Image="sha256:" + "f" * 64),
                   lambda row: row["Config"]["Env"].append("OTHER_SYNTHETIC=changed"),
                   lambda row: row.update(Name="/unrelated-service"),
                   lambda row: row["HostConfig"]["RestartPolicy"].update(Name="always")]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                change(self.runtime.row)
                self.confirm()
                self.assertEqual(self.runtime.recoveries, [])

    def test_ambiguous_signal_consumes_budget_and_survives_controller_restart(self):
        self.runtime.failure = TimeoutError("synthetic timeout")
        self.confirm()
        self.assertTrue(self.state["targets"][NAME]["latched"])
        self.assertIsNotNone(self.state["targets"][NAME]["pending"])
        self.runtime.failure = None
        self.confirm(180)
        self.tick(86401)
        self.assertEqual(len(self.runtime.recoveries), 1)
        self.assertEqual(self.state["targets"][NAME]["attempts"], [NOW + 120])

    def test_crash_after_intent_is_not_replayed(self):
        self.confirm()
        self.state = next(value for value in self.saved if value["targets"][NAME]["pending"])
        self.tick(180)
        self.assertTrue(self.state["targets"][NAME]["latched"])
        self.assertEqual(len(self.runtime.recoveries), 1)

    def test_failed_intent_persistence_prevents_signal(self):
        self.tick(0)
        self.tick(60)
        self.controller.save = lambda value: (_ for _ in ()).throw(OSError("synthetic disk failure"))
        with self.assertRaises(OSError):
            self.tick(120)
        self.assertEqual(self.runtime.recoveries, [])

    def test_post_signal_persistence_failure_retains_intent_and_never_replays(self):
        self.tick(0)
        self.tick(60)
        def persist(value):
            if self.runtime.recoveries:
                raise OSError("synthetic post-signal storage failure")
            self.saved.append(copy.deepcopy(value))
        self.controller.save = persist
        with self.assertRaises(OSError):
            self.tick(120)
        self.state = copy.deepcopy(self.saved[-1])
        self.assertIsNotNone(self.state["targets"][NAME]["pending"])
        self.controller.save = lambda value: self.saved.append(copy.deepcopy(value))
        self.tick(180)
        self.assertTrue(self.state["targets"][NAME]["latched"])
        self.assertEqual(len(self.runtime.recoveries), 1)

    def test_only_one_service_can_receive_a_recovery_attempt_per_cycle(self):
        second = "portal-api-staging"
        row, binding = fixture(second)
        self.config["targets"][second] = binding
        self.state = recovery.initial_state(self.config, NOW)
        rows = {self.runtime.row["Id"]: self.runtime.row, row["Id"]: row}
        self.runtime.inspect = lambda identifier: copy.deepcopy(rows[identifier])
        self.confirm()
        self.assertEqual(len(self.runtime.recoveries), 1)
        self.assertEqual(self.state["targets"][second]["result"], "cycle-budget")

    def test_backoff_and_daily_budget_persist_across_brief_health(self):
        for elapsed in range(0, 1621, 60):
            self.tick(elapsed)
        row = self.state["targets"][NAME]
        self.assertEqual(row["attempts"], [NOW + 120, NOW + 420, NOW + 1320])
        self.assertTrue(row["latched"])
        self.assertEqual(row["result"], "restart-budget-exhausted")
        self.runtime.status = "healthy"
        self.tick(1680)
        self.runtime.status = "failed"
        self.confirm(86401)
        self.assertEqual(len(self.runtime.recoveries), 3)

    def test_enrollment_change_cannot_reset_restart_budget(self):
        self.confirm()
        changed = copy.deepcopy(self.config)
        changed["targets"][NAME]["container_id"] = "f" * 64
        with self.assertRaisesRegex(recovery.Refused, "ENROLLMENT_STATE_CHANGED"):
            self.controller.tick(changed, self.state, NOW + 180)

    def test_private_configuration_is_only_hashed_not_recorded(self):
        self.confirm()
        self.assertNotIn("not-a-secret", json.dumps(self.saved))
        self.assertNotIn("Env", json.dumps(self.saved))


class ConfigurationTests(unittest.TestCase):
    def test_operations_archive_includes_controller_transitive_helper(self):
        source = ast.parse((ROOT / "scripts/oracle_operations.py").read_text())
        paths = next(ast.literal_eval(node.value) for node in source.body
                     if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == "PATHS" for target in node.targets))
        with tempfile.TemporaryDirectory(prefix="onesa-recovery-package-") as temporary:
            bundle = Path(temporary)
            for name in paths:
                destination = bundle / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                if (ROOT / name).is_dir():
                    shutil.copytree(ROOT / name, destination, ignore=shutil.ignore_patterns("__pycache__"))
                else:
                    shutil.copyfile(ROOT / name, destination)
            result = subprocess.run([sys.executable, "-I", str(bundle / "infra/oracle/operations/recovery.py"), "--help"],
                                    capture_output=True, timeout=5, check=False)
            self.assertEqual(result.returncode, 0, "Packaged controller must import its own complete source")

    def test_strict_schema_refuses_wildcards_commands_and_nonimmutable_bindings(self):
        _row, binding = fixture()
        base = {"schema_version": 1, "enabled": False, "targets": {NAME: binding}}
        self.assertEqual(recovery.validate_config(base), base)
        edits = [lambda value: value["targets"].update({"*": binding}),
                 lambda value: value.update(command="docker restart all"),
                 lambda value: value["targets"][NAME].update(image_id="latest"),
                 lambda value: value["targets"][NAME].update(container_id="short-id"),
                 lambda value: value.update(enabled="true")]
        for edit in edits:
            value = copy.deepcopy(base)
            edit(value)
            with self.assertRaises(recovery.Refused):
                recovery.validate_config(value)

    def test_fingerprint_excludes_transient_network_address_but_binds_network_identity(self):
        row, _binding = fixture()
        original = recovery.fingerprint(row)
        row["NetworkSettings"]["Networks"]["fixture"]["IPAddress"] = "192.0.2.1"
        self.assertEqual(recovery.fingerprint(row), original)
        row["NetworkSettings"]["Networks"]["fixture"]["NetworkID"] = "f" * 64
        self.assertNotEqual(recovery.fingerprint(row), original)

    def test_unhealthy_flag_is_not_the_probe_and_cli_is_local_without_ambient_credentials(self):
        runtime = recovery.Runtime()
        row, binding = fixture()
        with patch.object(recovery.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"healthy\n")) as call:
            self.assertEqual(runtime.probe(recovery.TARGETS[NAME], binding), "healthy")
        args, options = call.call_args
        self.assertEqual(args[0][:2], ["/usr/bin/docker", "--host=unix:///var/run/docker.sock"])
        self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LANG": "C"})
        self.assertNotIn("/ready", " ".join(args[0]))
        self.assertNotIn("restart", args[0])

    def test_probe_transport_errors_and_malformed_output_are_unknown(self):
        runtime = recovery.Runtime()
        _row, binding = fixture()
        for status, output in ((1, b""), (125, b"failed\n"), (0, b"extra healthy\n")):
            with patch.object(runtime, "command", return_value=SimpleNamespace(returncode=status, stdout=output)):
                self.assertEqual(runtime.probe(recovery.TARGETS[NAME], binding), "unknown")

    def test_worker_probe_has_no_dependency_check_and_validates_exit_contract(self):
        runtime = recovery.Runtime()
        name = "portal-worker-production"
        _row, binding = fixture(name)
        for alive, status, expected in ((True, 0, "healthy"), (False, 1, "failed"), (True, 1, "unknown")):
            result = SimpleNamespace(returncode=status, stdout=json.dumps({"event": "worker_liveness", "alive": alive}).encode())
            with patch.object(runtime, "command", return_value=result) as call:
                self.assertEqual(runtime.probe(recovery.TARGETS[name], binding), expected)
                self.assertEqual(call.call_args.args[0][-1], "dist/src/jobs/liveness-check.js")
        result = SimpleNamespace(returncode=1, stdout=b'{"event":"unexpected","event":"worker_liveness","alive":false}')
        with patch.object(runtime, "command", return_value=result):
            self.assertEqual(runtime.probe(recovery.TARGETS[name], binding), "unknown")


class PidfdTests(unittest.TestCase):
    def setUp(self):
        self.row, self.binding = fixture()
        self.runtime = recovery.Runtime()
        self.clock = 0.0
        self.signals = []
        self.exited = False

    def poll(self, delay):
        self.clock += delay / 1000
        return [(99, 1)] if self.exited else []

    def send(self, handle, signum):
        self.signals.append((handle, signum, self.clock))
        if signum == recovery.signal.SIGKILL:
            self.exited = True

    def act(self, target=None, before_signal=lambda: None):
        fake_poll = SimpleNamespace(register=lambda fd, events: None, poll=self.poll)
        with patch.object(self.runtime, "inspect", side_effect=lambda _id: copy.deepcopy(self.row)), \
             patch.object(self.runtime, "process_identity", return_value="synthetic-starttime"), \
             patch.object(recovery.os, "pidfd_open", return_value=99), \
             patch.object(recovery.os, "close"), \
             patch.object(recovery.select, "poll", return_value=fake_poll), \
             patch.object(recovery.time, "monotonic", side_effect=lambda: self.clock), \
             patch.object(recovery.signal, "pidfd_send_signal", side_effect=self.send):
            return self.runtime.recover(target or recovery.TARGETS[NAME], self.binding,
                                        copy.deepcopy(self.row), before_signal)

    def test_full_api_grace_before_force_and_pinned_descriptor_only(self):
        self.assertEqual(self.act(), "forced-exit-observed")
        self.assertEqual(self.signals, [(99, recovery.signal.SIGTERM, 0.0), (99, recovery.signal.SIGKILL, 150.0)])

    def test_full_worker_grace_before_force(self):
        name = "portal-worker-production"
        self.row, self.binding = fixture(name)
        self.act(recovery.TARGETS[name])
        self.assertEqual(self.signals[-1], (99, recovery.signal.SIGKILL, 180.0))

    def test_operator_stop_between_inspection_and_signal_does_not_start_or_signal(self):
        def stop():
            self.row["State"].update(Running=False, Status="exited", Pid=0)
        with self.assertRaisesRegex(recovery.Refused, "PROCESS_INCARNATION_CHANGED"):
            self.act(before_signal=stop)
        self.assertEqual(self.signals, [])

    def test_replacement_process_is_not_killed_after_term_grace(self):
        original = self.send
        # Avoid recursive replacement while retaining the exact actual signal log.
        def send(handle, signum):
            original(handle, signum)
            self.row["State"]["Pid"] = 322
        self.send = send
        self.assertEqual(self.act(), "incarnation-ended")
        self.assertEqual(len(self.signals), 1)

    def test_maintenance_during_drain_suppresses_force_and_requires_reconciliation(self):
        calls = 0
        def guard():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise recovery.Refused("OWNER_MAINTENANCE_HOLD")
        with self.assertRaises(recovery.Refused):
            self.act(before_signal=guard)
        self.assertEqual(len(self.signals), 1)

    def test_unrelated_host_process_cannot_satisfy_container_cgroup_binding(self):
        for path in ("/system.slice/docker-" + "b" * 64 + ".scope",
                     "/system.slice/docker-" + "a" * 65 + ".scope",
                     "/unrelated-" + "a" * 64):
            with patch.object(recovery.Path, "read_text", return_value="0::" + path + "\n"), \
                 self.assertRaisesRegex(recovery.Refused, "PROCESS_CGROUP_MISMATCH"):
                self.runtime.process_identity(321, "a" * 64)


if __name__ == "__main__":
    unittest.main()
