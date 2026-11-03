"""Disposable owner/recovery commissioning tests; no Docker or hosted changes."""

import base64
import copy
import hashlib
import json
import os
import signal
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/release"))
import oracle_runtime_recovery as r
import test_oracle_owner as owner_fixtures
from test_oracle_runtime_recovery import fixture

c, lifecycle = r.controller(), r.lifecycle
NOW = 1800000000.0


def plan_fixture(all_targets=False):
    names = sorted(r.STAGING | r.PRODUCTION if all_targets else r.STAGING)
    plan = {"schema_version": 1, "repository": r.REPOSITORY, "candidate_commit": "a" * 40,
            "source_tree": "b" * 40, "targets": {}}
    rows = {}
    for index, name in enumerate(names, 1):
        row, binding = fixture(name)
        row["Id"] = str(index) * 64
        row["RestartCount"] = 0
        row["State"]["FinishedAt"] = "0001-01-01T00:00:00Z"
        row["HostConfig"]["AutoRemove"] = False
        row["Config"]["Labels"]["org.onesa.source-commit"] = plan["candidate_commit"]
        binding.update(container_id=row["Id"], source_commit=plan["candidate_commit"], configuration_sha256=c.fingerprint(row))
        plan["targets"][name] = {"binding": binding, "store": "/private/fixture-store", "record": str(uuid4())}
        rows[row["Id"]] = row
    return plan, rows


class Clock:
    def __init__(self):
        self.value = 1000.0
        self.callback = lambda: None

    def monotonic(self):
        return self.value

    def wall(self):
        return NOW + self.value - 1000

    def sleep(self, seconds):
        self.value += seconds
        self.callback()


class Host:
    def __init__(self, plan, rows, clock=None):
        self.c = c
        self.runtime = self
        self.plan, self.rows = plan, copy.deepcopy(rows)
        self.clock = clock or Clock()
        self.clock.callback = self.tick
        self.commands, self.faults, self.hung = [], [], set()
        self.status = "healthy"
        self.timer_active = False
        self.trigger = int(self.clock.value * 1_000_000)
        self.service_state = "inactive"
        self.service_result = "success"
        self.trigger_offset = 0
        self.fail_command = None
        self.unrelated = {"fixture-database": {"image_id": "fixture-db", "running": True}}
        self.mutate_unrelated = False
        self.no_ticks = False

    def inspect(self, identifier):
        return copy.deepcopy(self.rows[identifier])

    def probe(self, target, binding):
        return "failed" if binding["container_id"] in self.hung else self.status

    def command(self, args, timeout=20):
        self.commands.append(args)
        if self.fail_command and self.fail_command in args:
            raise OSError("synthetic interrupted command")
        if args[0] in {"stop", "start"}:
            self.assert_private_intent(args[0])
            row = self.rows[args[-1]]
            if args[0] == "stop":
                row["State"].update(Running=False, Status="exited", Pid=0, FinishedAt=str(self.clock.value))
            else:
                row["State"].update(Running=True, Status="running", Pid=500,
                                    StartedAt=datetime.fromtimestamp(self.clock.wall(), timezone.utc).isoformat())
        return SimpleNamespace(returncode=0, stdout=b"")

    def assert_private_intent(self, action):
        journal = lifecycle.read_private_json(lifecycle.STATE / "acceptance-pending.json")
        expected = "manual-stop-intent" if action == "stop" else "owner-restore-intent"
        assert journal["phase"].endswith(expected)
        try:
            with lifecycle.lifecycle_lock(required=True):
                raise AssertionError("Actuation must hold the actual owner exclusion lock")
        except lifecycle.LifecycleBusy:
            pass

    def systemctl(self, *args):
        self.command(["systemctl", *args])
        if args[0] in {"enable", "disable"}:
            self.timer_active = args[0] == "enable"

    def properties(self, unit):
        common = {"LoadState": "loaded", "FragmentPath": str(r.UNITS / unit)}
        if unit == r.TIMER:
            return {**common, "ActiveState": "active" if self.timer_active else "inactive",
                    "UnitFileState": "enabled" if self.timer_active else "disabled",
                    "LastTriggerUSecMonotonic": str(self.trigger + self.trigger_offset)}
        return {**common, "ActiveState": self.service_state, "Result": self.service_result,
                "ExecMainStartTimestampMonotonic": str(self.trigger)}

    def inventory(self):
        value = copy.deepcopy(self.unrelated)
        if self.mutate_unrelated and self.faults:
            value["fixture-database"]["image_id"] = "changed"
        for identifier, row in self.rows.items():
            value[identifier] = {"image_id": row["Image"], "running": row["State"]["Running"],
                                 "started_at": row["State"]["StartedAt"], "restarts": row["RestartCount"],
                                 "configuration_sha256": c.fingerprint(row)}
        return value

    def restart(self, identifier):
        row = self.rows[identifier]
        row["RestartCount"] += 1
        row["State"]["Pid"] += 1
        row["State"]["StartedAt"] = datetime.fromtimestamp(self.clock.wall(), timezone.utc).isoformat()

    def fault(self, name, binding, signum):
        assert name in r.STAGING
        journal = lifecycle.read_private_json(lifecycle.STATE / "acceptance-pending.json")
        assert journal["phase"] == name + (":crash-intent" if signum == signal.SIGKILL else ":hang-intent")
        try:
            with lifecycle.lifecycle_lock(required=True):
                raise AssertionError("Signal must hold the actual owner exclusion lock")
        except lifecycle.LifecycleBusy:
            pass
        before = self.inspect(binding["container_id"])
        self.faults.append((name, signum))
        if signum == signal.SIGKILL:
            self.restart(binding["container_id"])
        else:
            assert lifecycle.read_private_json(lifecycle.HOLD)["kind"] == "recovery-staging-test"
            self.hung.add(binding["container_id"])
        return before

    def tick(self):
        if self.no_ticks or not self.timer_active or int(self.clock.value - 1000) % 60:
            return
        self.trigger = int(self.clock.value * 1_000_000)
        if lifecycle.read_private_json(lifecycle.HOLD, required=False):
            return
        config = lifecycle.read_private_json(lifecycle.CONFIG)
        state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
        state["last_checked_at"] = self.clock.wall()
        for name, binding in config["targets"].items():
            identifier = binding["container_id"]
            if identifier in self.hung:
                self.restart(identifier)
                self.hung.remove(identifier)
                state["targets"][name]["attempts"].append(self.clock.wall())
            state["targets"][name]["result"] = "healthy" if self.rows[identifier]["State"]["Running"] else "stopped-or-transitioning"
        lifecycle.write_private_json(lifecycle.STATE / "state.json", state)


class FilesystemFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="onesa-recovery-commissioning-", dir=Path.home())
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.config_path = self.root / "config.json"
        self.units = self.root / "units"
        self.units.mkdir(mode=0o700)
        for name, value in {"OWNER_UID": os.getuid(), "CONFIG": self.config_path, "STATE": self.state,
                            "LOCK": self.state / "lifecycle.lock", "HOLD": self.state / "maintenance.json"}.items():
            self.enterContext(patch.object(lifecycle, name, value))
        self.enterContext(patch.object(r, "ROOT", self.root / "installed"))
        self.enterContext(patch.object(r, "UNITS", self.units))
        self.plan, self.rows = plan_fixture()
        self.clock = Clock()
        self.host = Host(self.plan, self.rows, self.clock)
        self.enterContext(patch.object(r.time, "time", self.clock.wall))
        self.accepted = lambda plan, _github, _runtime, names: {name: copy.deepcopy(plan["targets"][name]["binding"]) for name in names}

    def enrolled(self, enabled=False, plan=None):
        plan = plan or self.plan
        config = {"schema_version": 1, "enabled": enabled,
                  "targets": {name: copy.deepcopy(entry["binding"]) for name, entry in plan["targets"].items()}}
        lifecycle.write_private_json(self.config_path, config)
        state = c.initial_state(config, self.clock.wall())
        for row in state["targets"].values():
            row["result"] = "healthy"
        lifecycle.write_private_json(self.state / "state.json", state)
        self.host.timer_active = enabled
        return config, state

    def stage_receipts(self, plan=None):
        plan = plan or self.plan
        checks = {name + ":" + case: "PASS" for name in r.STAGING for case in ["crash", "hang", "maintenance", "manual-stop"]}
        lifecycle.write_private_json(self.state / "staging-acceptance.json", {
            "status": "passed", "binding": r.stage_binding(plan), "observed_at": self.clock.wall() - 400, "checks": checks})
        samples = [{"invocation": str(60_000_000 * index), "monotonic": 60_000_000 * index,
                    "checked_at": self.clock.wall() - 360 + 60 * index} for index in range(1, 7)]
        lifecycle.write_private_json(self.state / "staging-observation.json", {
            "status": "passed", "binding": r.stage_binding(plan), "observed_at": self.clock.wall(),
            "span_seconds": 300, "samples": 6, "sample_evidence": samples, "manual_invocations": 0})


class PlanTests(unittest.TestCase):
    def test_only_both_staging_or_all_four_exact_source_targets(self):
        for all_targets in [False, True]:
            plan, _rows = plan_fixture(all_targets)
            self.assertEqual(r.validate_plan(plan), plan)
        for mutate in [lambda p: p["targets"].pop("portal-api-staging"),
                       lambda p: p["targets"]["portal-worker-staging"]["binding"].update(source_commit="c" * 40),
                       lambda p: p["targets"]["portal-worker-staging"].update(store="relative/path"),
                       lambda p: p.update(schema_version=True), lambda p: p.update(candidate_commit=None),
                       lambda p: p["targets"]["portal-api-staging"].update(binding=None)]:
            with self.subTest(mutation=mutate):
                plan, _rows = plan_fixture()
                mutate(plan)
                with self.assertRaises(ValueError):
                    r.validate_plan(plan)

    def test_cli_owner_route_excludes_actions_and_nonowner(self):
        for uid, user, actions in [(1000, "ubuntu", ""), (0, "someone", ""), (0, "ubuntu", "true")]:
            with patch.object(os, "geteuid", return_value=uid), patch.dict(os.environ, {"SUDO_USER": user, "GITHUB_ACTIONS": actions}):
                with self.assertRaisesRegex(ValueError, "OWNER_ROUTE"):
                    r.owner_route("a" * 64)


class SourceInstallationTests(FilesystemFixture):
    def setUp(self):
        super().setUp()
        private = r.owner.private

        if os.getuid() != 0:
            fixture_root, fixture_uid = self.root, os.getuid()

            class FixturePath(type(Path())):
                def lstat(self):
                    observed = super().lstat()
                    if self.is_relative_to(fixture_root):
                        # Only this disposable tree represents the host's root
                        # ownership. Preserve every real mode/type/link/inode
                        # field, and never normalize a foreign-owned fixture.
                        if observed.st_uid != fixture_uid:
                            raise AssertionError("Foreign owner in disposable recovery fixture")
                        fields = list(observed)
                        fields[4] = 0
                        return os.stat_result(fields)
                    return observed

            # Scope the adapter to the recovery module. The real owner/lifecycle
            # custody helpers still read actual metadata and the runner UID.
            self.enterContext(patch.object(r, "Path", FixturePath))
            self.enterContext(patch.object(r, "ROOT", FixturePath(r.ROOT)))
            self.enterContext(patch.object(r, "UNITS", FixturePath(r.UNITS)))

        def fixture_private(path, *, directory=False, uid=0):
            # Hosted CI owns its disposable bundle as the runner account. Keep
            # the real custody checks; production still requires UID 0.
            self.assertTrue(Path(path).resolve().is_relative_to(self.root))
            return private(path, directory=directory, uid=os.getuid())

        self.enterContext(patch.object(r.owner, "private", side_effect=fixture_private))

    def test_fixture_parent_adapter_preserves_writable_and_symlink_rejection(self):
        writable = self.root / "unsafe-parent"
        writable.mkdir(mode=0o700)
        writable.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "DIRECTORY_PARENT"):
            r.mkdir_private(writable / "child")
        self.assertFalse((writable / "child").exists())
        alias = self.root / "parent-alias"
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "DIRECTORY_PARENT"):
            r.mkdir_private(alias / "child")
        self.assertFalse((self.state / "child").exists())

    def bundle(self):
        directory = self.root / "bundle"
        directory.mkdir(mode=0o700)
        payloads, listing = {}, []
        for name in r.SOURCES:
            path = directory / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes((ROOT / name).read_bytes())
            path.chmod(0o600)
            payloads[name] = path.read_bytes()
            listing.append({"path": name, "type": "blob", "mode": "100644", "sha": hashlib.sha256(payloads[name]).hexdigest()})
        class Github:
            def owner(self):
                return "DruHustle"
            def qualify(self, binding):
                assert binding["candidate_commit"] == "a" * 40
                return [{"run_id": 1, "run_attempt": 1}]
            def api(self, path):
                if "/git/trees/" in path:
                    return {"truncated": False, "tree": listing}
                key = next(name for name, data in payloads.items() if hashlib.sha256(data).hexdigest() == path.rsplit("/", 1)[-1])
                return {"encoding": "base64", "content": base64.b64encode(payloads[key]).decode()}
        return directory, payloads, listing, Github()

    def test_install_exact_source_is_disabled_and_idempotent_without_runtime_commands(self):
        bundle, payloads, _listing, github = self.bundle()
        result = r.install(self.plan, bundle, github, self.host)
        self.assertTrue(result["changed"])
        self.assertFalse(self.config_path.exists())
        self.assertFalse(lifecycle.HOLD.exists())
        self.assertFalse(self.host.timer_active)
        self.assertEqual(r.install(self.plan, bundle, github, self.host)["changed"], False)
        receipt = r.installation(self.plan)
        self.assertEqual(set(receipt["files"]), set(payloads))
        self.assertEqual(len(self.host.commands), 2)
        self.assertEqual(self.host.commands[1], ["systemctl", "daemon-reload"])

    def test_source_mismatch_unreviewed_mode_and_truncated_tree_never_start_install(self):
        bundle, _payloads, listing, github = self.bundle()
        (bundle / r.SOURCES[-1]).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "SOURCE_CHANGED"):
            r.install(self.plan, bundle, github, self.host)
        self.assertFalse(r.ROOT.exists())
        (bundle / r.SOURCES[-1]).write_bytes((ROOT / r.SOURCES[-1]).read_bytes())
        listing[0]["mode"] = "120000"
        with self.assertRaisesRegex(ValueError, "SOURCE_MODE"):
            r.install(self.plan, bundle, github, self.host)
        with patch.object(github, "api", return_value={"truncated": True}):
            with self.assertRaisesRegex(ValueError, "TREE_TRUNCATED"):
                r.source_payloads(self.plan, bundle, github)

    def test_installation_interruption_retains_hold_and_never_enables(self):
        bundle, _payloads, _listing, github = self.bundle()
        self.host.fail_command = "verify"
        with self.assertRaises(OSError):
            r.install(self.plan, bundle, github, self.host)
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        self.assertEqual(hold["kind"], "recovery-install")
        self.assertFalse(self.host.timer_active)
        self.host.fail_command = None
        with self.assertRaisesRegex(ValueError, "EXISTING_HOLD"):
            r.install(self.plan, bundle, github, self.host)
        self.assertEqual(lifecycle.read_private_json(lifecycle.HOLD), hold)

    def test_active_timer_and_foreign_units_are_not_overwritten(self):
        bundle, _payloads, _listing, github = self.bundle()
        self.host.timer_active = True
        with self.assertRaisesRegex(ValueError, "TIMER_MUST_BE_STOPPED"):
            r.install(self.plan, bundle, github, self.host)
        self.host.timer_active = False
        foreign = self.units / r.TIMER
        foreign.write_text("foreign unit")
        with self.assertRaisesRegex(ValueError, "EXISTING_UNIT_DIFFERS"):
            r.install(self.plan, bundle, github, self.host)
        self.assertEqual(foreign.read_text(), "foreign unit")

    def test_installed_source_and_unit_tampering_block_enrollment(self):
        bundle, _payloads, _listing, github = self.bundle()
        r.install(self.plan, bundle, github, self.host)
        installed = r.ROOT / "releases" / self.plan["candidate_commit"] / r.SOURCES[3]
        installed.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "INSTALLED_SOURCE_CHANGED"):
            r.installation(self.plan)
        installed.write_bytes((ROOT / r.SOURCES[3]).read_bytes())
        (self.units / r.TIMER).write_text("changed")
        with self.assertRaisesRegex(ValueError, "INSTALLED_UNIT_CHANGED"):
            r.installation(self.plan)

    def test_new_source_upgrade_validates_previous_custody_without_requiring_previous_executed_bytes(self):
        bundle, payloads, listing, github = self.bundle()
        r.install(self.plan, bundle, github, self.host)
        prior = r.ROOT / "releases" / self.plan["candidate_commit"]
        old_tool = prior / r.SOURCES[0]
        old_tool.write_bytes(b"# previous reviewed fixture version\n" + old_tool.read_bytes())
        record = lifecycle.read_private_json(prior / "installation.json")
        record["files"][r.SOURCES[0]] = r.owner.file_digest(old_tool)
        lifecycle.write_private_json(prior / "installation.json", record)
        self.enrolled()
        before_state = (self.state / "state.json").read_bytes()
        before_config = self.config_path.read_bytes()
        new = copy.deepcopy(self.plan)
        new.update(candidate_commit="c" * 40, source_tree="d" * 40)
        for entry in new["targets"].values():
            entry["binding"]["source_commit"] = new["candidate_commit"]
        payloads[r.SOURCES[-1]] += b"\n# reviewed timer version\n"
        (bundle / r.SOURCES[-1]).write_bytes(payloads[r.SOURCES[-1]])
        listing[-1]["sha"] = hashlib.sha256(payloads[r.SOURCES[-1]]).hexdigest()
        with patch.object(github, "qualify", return_value=[{"run_id": 2, "run_attempt": 1}]):
            result = r.install(new, bundle, github, self.host)
        self.assertTrue(result["changed"])
        self.assertEqual(r.installation(new)["source"], new["candidate_commit"])
        self.assertEqual((self.units / r.TIMER).read_bytes(), payloads[r.SOURCES[-1]])
        self.assertEqual((self.state / "state.json").read_bytes(), before_state)
        self.assertEqual(self.config_path.read_bytes(), before_config)
        self.assertTrue(prior.exists())
        self.assertFalse(lifecycle.HOLD.exists())


class EnrollmentTests(FilesystemFixture):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(r, "installation", return_value={}))
        self.enterContext(patch.object(r, "accepted_targets", side_effect=self.accepted))

    def test_enroll_does_not_start_processes_and_preserves_consumed_budget(self):
        r.enroll(self.plan, None, self.host, "staging")
        old = lifecycle.read_private_json(self.state / "state.json")
        old["targets"]["portal-api-staging"]["attempts"] = [self.clock.wall() - 20]
        lifecycle.write_private_json(self.state / "state.json", old)
        original = copy.deepcopy(old)
        self.plan["targets"]["portal-api-staging"]["binding"]["container_id"] = "e" * 64
        r.enroll(self.plan, None, self.host, "staging")
        state = lifecycle.read_private_json(self.state / "state.json")
        self.assertEqual(state["targets"]["portal-api-staging"]["attempts"], [self.clock.wall() - 20])
        self.assertEqual(state["targets"]["portal-worker-staging"], original["targets"]["portal-worker-staging"])
        self.assertFalse(lifecycle.read_private_json(self.config_path)["enabled"])
        self.assertEqual(self.host.commands, [])

    def test_interrupted_two_file_enrollment_resumes_only_exact_durable_transaction(self):
        write = lifecycle.write_private_json
        def fail_state(path, value, **kwargs):
            if Path(path) == self.state / "state.json":
                raise OSError("synthetic state disk failure")
            return write(path, value, **kwargs)
        with patch.object(lifecycle, "write_private_json", side_effect=fail_state):
            with self.assertRaises(OSError):
                r.enroll(self.plan, None, self.host, "staging")
        pending = lifecycle.read_private_json(self.state / "enrollment-pending.json")
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        self.assertEqual(lifecycle.read_private_json(self.config_path), pending["config"])
        wrong = copy.deepcopy(self.plan)
        wrong["targets"]["portal-api-staging"]["record"] = str(uuid4())
        with self.assertRaisesRegex(ValueError, "MAINTENANCE_HOLD"):
            r.enroll(wrong, None, self.host, "staging")
        self.assertEqual(lifecycle.read_private_json(lifecycle.HOLD), hold)
        r.enroll(self.plan, None, self.host, "staging")
        self.assertEqual(lifecycle.read_private_json(self.state / "state.json"), pending["state"])
        self.assertFalse(lifecycle.HOLD.exists())
        self.assertFalse((self.state / "enrollment-pending.json").exists())

    def test_pending_and_latched_actions_cannot_be_erased_by_new_runtime(self):
        config, state = self.enrolled()
        item = state["targets"]["portal-api-staging"]
        item.update(attempts=[self.clock.wall() - 5], latched=True,
                    pending={"at": self.clock.wall() - 5, "incarnation": [321, "fixture"]})
        lifecycle.write_private_json(self.state / "state.json", state)
        self.plan["targets"]["portal-api-staging"]["binding"]["container_id"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "UNRESOLVED_ACTION_RETAINED"):
            r.enroll(self.plan, None, self.host, "staging")
        self.assertEqual(lifecycle.read_private_json(self.state / "state.json"), state)
        self.assertEqual(lifecycle.read_private_json(self.config_path), config)

    def test_revoked_and_foreign_holds_survive_without_enrollment_writes(self):
        config, state = self.enrolled()
        with lifecycle.lifecycle_lock() as guard:
            guard.begin_hold("recovery-enroll", r.REPOSITORY + ":recovery", r.digest(self.plan) + ":staging")
            guard.mark_revocation("portal:identity", "revoked-record")
        with self.assertRaisesRegex(ValueError, "ENROLLMENT_REVOKED"):
            r.enroll(self.plan, None, self.host, "staging")
        self.assertEqual(lifecycle.read_private_json(self.config_path), config)
        self.assertEqual(lifecycle.read_private_json(self.state / "state.json"), state)

    def test_no_target_can_be_dropped_by_reenrollment(self):
        plan, _rows = plan_fixture(True)
        config, state = self.enrolled(plan=plan)
        with self.assertRaisesRegex(ValueError, "CANNOT_DROP_TARGETS"):
            r.enrollment_state(c, config, state, {**config, "targets": {name: config["targets"][name] for name in r.STAGING}}, self.clock.wall())

    def test_disable_preserves_uncertain_attempt_and_hold(self):
        _config, state = self.enrolled(enabled=True)
        state["targets"]["portal-api-staging"].update(attempts=[self.clock.wall()], latched=True,
                pending={"at": self.clock.wall(), "incarnation": [321, "fixture"]})
        lifecycle.write_private_json(self.state / "state.json", state)
        with lifecycle.lifecycle_lock() as guard:
            guard.begin_hold("owner-deploy", "portal:identity", "uncertain")
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        result = r.disable(self.host)
        self.assertTrue(result["hold_preserved"])
        self.assertFalse(lifecycle.read_private_json(self.config_path)["enabled"])
        self.assertFalse(self.host.timer_active)
        self.assertEqual(lifecycle.read_private_json(lifecycle.HOLD), hold)
        self.assertEqual(lifecycle.read_private_json(self.state / "state.json"), state)


class AcceptanceTests(FilesystemFixture):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(r, "installation", return_value={}))
        self.enterContext(patch.object(r, "accepted_targets", side_effect=self.accepted))

    def test_production_activation_requires_staging_faults_and_actual_scheduled_samples(self):
        plan, _rows = plan_fixture(True)
        self.enrolled(plan=plan)
        with self.assertRaises(ValueError):
            r.activate(plan, None, self.host, "production")
        self.stage_receipts(plan)
        observation = lifecycle.read_private_json(self.state / "staging-observation.json")
        lifecycle.write_private_json(self.state / "staging-observation.json", {**observation, "sample_evidence": []})
        with self.assertRaisesRegex(ValueError, "ORDINARY_STAGING_OBSERVATION_REQUIRED"):
            r.activate(plan, None, self.host, "production")
        lifecycle.write_private_json(self.state / "staging-observation.json", observation)
        self.assertEqual(r.activate(plan, None, self.host, "production")["status"], "enabled-unverified")
        self.assertTrue(self.host.timer_active)
        self.assertFalse(lifecycle.HOLD.exists())

    def test_changed_stage_binding_or_failed_check_cannot_qualify_production(self):
        plan, _rows = plan_fixture(True)
        self.enrolled(plan=plan)
        self.stage_receipts(plan)
        receipt = lifecycle.read_private_json(self.state / "staging-acceptance.json")
        receipt["checks"]["portal-api-staging:hang"] = "FAIL"
        lifecycle.write_private_json(self.state / "staging-acceptance.json", receipt)
        with self.assertRaisesRegex(ValueError, "STAGING_ACCEPTANCE_REQUIRED"):
            r.activate(plan, None, self.host, "production")
        self.assertFalse(self.host.timer_active)

    def test_interrupted_enable_can_only_resume_its_matched_hold(self):
        self.enrolled()
        self.host.fail_command = "enable"
        with self.assertRaises(OSError):
            r.activate(self.plan, None, self.host, "staging")
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        self.assertTrue(lifecycle.read_private_json(self.config_path)["enabled"])
        self.assertEqual(hold["kind"], "recovery-enable")
        self.host.fail_command = None
        r.activate(self.plan, None, self.host, "staging")
        self.assertFalse(lifecycle.HOLD.exists())

    def test_observation_waits_for_six_distinct_timer_runs_and_five_minutes(self):
        self.enrolled(enabled=True)
        result = r.observe(self.plan, self.host, "staging", clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertEqual(result["samples"], 6)
        self.assertEqual(result["span_seconds"], 300)
        self.assertEqual(result["manual_invocations"], 0)
        self.assertEqual(self.host.commands, [])
        self.assertEqual(len({row["invocation"] for row in result["sample_evidence"]}), 6)

    def test_manually_invoked_or_unchanging_timer_cannot_supply_acceptance(self):
        self.enrolled(enabled=True)
        self.host.trigger_offset = -30_000_000
        with self.assertRaisesRegex(ValueError, "ORDINARY_TIMER_TRIGGER_REQUIRED"):
            r.observe(self.plan, self.host, "staging", clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.host.trigger_offset = 0
        self.host.no_ticks = True
        with self.assertRaisesRegex(ValueError, "OBSERVATION_TIMEOUT"):
            r.observe(self.plan, self.host, "staging", clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertFalse((self.state / "staging-observation.json").exists())

    def test_staging_acceptance_exercises_both_roles_under_real_owner_locks_and_keeps_production_untouched(self):
        self.enrolled(enabled=True)
        before = copy.deepcopy(self.host.unrelated)
        result = r.test_staging(self.plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(len(result["checks"]), 8)
        self.assertEqual(result["production_faults"], 0)
        self.assertFalse(result["controller_policy_shortened"])
        self.assertEqual(self.host.unrelated, before)
        self.assertEqual(len(self.host.faults), 4)
        self.assertEqual([command[0] for command in self.host.commands], ["stop", "start", "stop", "start"])
        state = lifecycle.read_private_json(self.state / "state.json")
        self.assertTrue(all(len(item["attempts"]) == 1 for item in state["targets"].values()))
        self.assertFalse((self.state / "acceptance-pending.json").exists())
        self.assertFalse(lifecycle.HOLD.exists())

    def test_fault_scope_never_includes_production_and_inactive_timer_prevents_first_fault(self):
        plan, _rows = plan_fixture(True)
        self.enrolled(enabled=True, plan=plan)
        with self.assertRaisesRegex(ValueError, "STAGING_ONLY"):
            r.test_staging(plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.enrolled()
        with self.assertRaisesRegex(ValueError, "TIMER_INACTIVE"):
            r.test_staging(self.plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertEqual(self.host.faults, [])

    def test_unrelated_change_preserves_pending_fault_intent_and_prevents_repeat(self):
        self.enrolled(enabled=True)
        self.host.mutate_unrelated = True
        with self.assertRaisesRegex(ValueError, "UNRELATED_RUNTIME_CHANGED"):
            r.test_staging(self.plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        pending = lifecycle.read_private_json(self.state / "acceptance-pending.json")
        self.assertTrue(pending["phase"].endswith("crash-intent"))
        self.assertEqual(len(self.host.faults), 1)
        with self.assertRaisesRegex(ValueError, "ALREADY_PENDING"):
            r.test_staging(self.plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertEqual(len(self.host.faults), 1)

    def test_acceptance_observes_recovery_while_controller_owns_full_grace_lock(self):
        self.enrolled(enabled=True)
        tick = self.host.tick
        active = {"context": None, "until": None, "completed": 0}
        def controller_tick():
            if (active["context"] is None and self.host.hung and int(self.clock.value - 1000) % 60 == 0
                    and lifecycle.read_private_json(lifecycle.HOLD, required=False) is None):
                active["context"] = lifecycle.lifecycle_lock(required=True)
                active["context"].__enter__()
                active["until"] = self.clock.value + 180
            if active["context"]:
                if self.clock.value < active["until"]:
                    return
                active["context"].__exit__(None, None, None)
                active["context"] = None
                active["completed"] += 1
            tick()
        def cleanup_lock():
            if active["context"]:
                active["context"].__exit__(None, None, None)
        self.addCleanup(cleanup_lock)
        self.clock.callback = controller_tick
        result = r.test_staging(self.plan, None, self.host, clock=self.clock.monotonic, sleep=self.clock.sleep)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(active["completed"], 2)


class SignedAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        owner_fixtures.OwnerStoreTests.setUpClass()

    def setUp(self):
        fixture_store = owner_fixtures.OwnerStoreTests()
        fixture_store.setUp()
        self.addCleanup(fixture_store.doCleanups)
        self.fixture = fixture_store
        fixture_store.store.db.close()
        policy = fixture_store.policy
        policy["components"][r.REPOSITORY + ":identity"] = policy["components"].pop(r.REPOSITORY + ":api")
        (fixture_store.root / "policy.json").write_bytes(r.owner.canonical(policy))
        trust = json.loads((fixture_store.root / "trust.json").read_bytes())
        trust["policy_sha256"] = r.owner.file_digest(fixture_store.root / "policy.json")
        (fixture_store.root / "trust.json").write_bytes(r.owner.canonical(trust))
        fixture_store.commission_fixture()
        fixture_store.binding["component"] = "identity"
        fixture_store.store = fixture_store.open()
        self.addCleanup(fixture_store.store.db.close)
        self.plan, rows = plan_fixture()
        self.host = Host(self.plan, rows)
        self.issue()

    def issue(self, *, issued=None, checks=None, component=None):
        f = self.fixture
        observations = {"environment": "staging", "runtime_targets": {
            name: entry["binding"] for name, entry in self.plan["targets"].items()}, "checks": checks or {
                "source_build_image_identity": "PASS", "authentication_and_authorization": "PASS", "configuration_and_isolation": "PASS"}}
        with patch.object(f.store, "clock", return_value=issued or datetime.now(timezone.utc)):
            with f.store.transaction():
                parent = f.store.put("context", f.binding, {})["record"]["id"]
                result = f.store.put("qualification", f.binding, {"staging": {"observations": observations}}, parent=parent)
        self.record = result["record"]["id"]
        self.parent = parent
        for entry in self.plan["targets"].values():
            entry.update(store=str(f.root), record=self.record)

    def read(self):
        return r.accepted_targets(self.plan, self.fixture.ci, self.host.runtime, r.STAGING,
                                  store_factory=lambda path, github: r.owner.Store(path, github, uid=os.getuid()))

    def test_real_ed25519_accepted_identity_record_and_live_compatible_runtime(self):
        self.assertEqual(set(self.read()), r.STAGING)
        self.host.status = "unknown"
        with self.assertRaisesRegex(ValueError, "HEALTHY_COMPATIBLE_RUNTIME_REQUIRED"):
            self.read()

    def test_revocation_of_ancestor_rejected_even_for_historical_signature_read(self):
        self.fixture.store.db.execute("UPDATE records SET revoked=1 WHERE id=?", (self.parent,))
        with self.assertRaisesRegex(ValueError, "ACCEPTANCE_REVOKED"):
            self.read()

    def test_tampered_signature_or_stale_runtime_receipt_cannot_enroll(self):
        row = self.fixture.store.db.execute("SELECT envelope FROM records WHERE id=?", (self.record,)).fetchone()
        changed = json.loads(row[0])
        changed["record"]["details"]["staging"]["observations"]["checks"]["authentication_and_authorization"] = "FAIL"
        self.fixture.store.db.execute("UPDATE records SET envelope=? WHERE id=?", (json.dumps(changed), self.record))
        with self.assertRaises(ValueError):
            self.read()
        self.issue(issued=datetime.now(timezone.utc) - timedelta(hours=25))
        with self.assertRaisesRegex(ValueError, "TOO_OLD"):
            self.read()

    def test_signed_missing_acceptance_or_changed_runtime_configuration_is_rejected(self):
        self.issue(checks={"source_build_image_identity": "PASS"})
        with self.assertRaisesRegex(ValueError, "ACCEPTED_CHECKS_REQUIRED"):
            self.read()
        self.issue()
        identifier = next(iter(self.host.rows))
        self.host.rows[identifier]["Config"]["Env"].append("SYNTHETIC_CHANGED=1")
        with self.assertRaisesRegex(ValueError, "RUNTIME_IDENTITY_CHANGED"):
            self.read()


if __name__ == "__main__":
    unittest.main()
