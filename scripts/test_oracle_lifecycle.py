"""Offline lifecycle custody, exclusion and interruption tests; no Docker/provider calls."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/release"))
import oracle_owner as owner
import test_oracle_owner as owner_fixtures

lifecycle = owner.lifecycle_module()


class LifecycleFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="onesa-lifecycle-test-", dir=Path.home())
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.config = self.root / "recovery.json"
        self.config.write_text('{"enabled":true}\n')
        self.config.chmod(0o600)
        for name, value in {
            "OWNER_UID": os.getuid(),
            "CONFIG": self.config,
            "STATE": self.state,
            "LOCK": self.state / "lifecycle.lock",
            "HOLD": self.state / "maintenance.json",
        }.items():
            self.enterContext(patch.object(lifecycle, name, value))


class LifecycleTests(LifecycleFixture, unittest.TestCase):
    def test_absent_or_disabled_configuration_preserves_owner_default_without_state_writes(self):
        self.config.unlink()
        self.state.rmdir()
        with lifecycle.lifecycle_lock() as guard:
            self.assertFalse(guard.active)
            self.assertIsNone(guard.begin_hold("owner-deploy", "portal:api", "reference"))
            guard.complete_hold(None)
        self.assertFalse(self.state.exists())
        self.config.write_text('{"enabled":false}')
        self.config.chmod(0o600)
        with lifecycle.lifecycle_lock() as guard:
            self.assertFalse(guard.active)
        with self.assertRaisesRegex(lifecycle.LifecycleError, "DISABLED"):
            with lifecycle.lifecycle_lock(required=True):
                self.fail("Disabled recovery cannot acquire an active guard")
        self.assertFalse(self.state.exists())

    def test_precreated_enrollment_state_locks_owner_operations_while_disabled(self):
        self.config.write_text('{"enabled":false}')
        with lifecycle.lifecycle_lock() as guard:
            self.assertTrue(guard.active)
            with self.assertRaises(lifecycle.LifecycleBusy):
                with lifecycle.lifecycle_lock():
                    self.fail("Enrollment must exclude another owner operation")
        with self.assertRaisesRegex(lifecycle.LifecycleError, "DISABLED"):
            with lifecycle.lifecycle_lock(required=True):
                self.fail("Disabled remediation remains prohibited")

    def test_disable_or_remove_config_never_bypasses_a_retained_hold(self):
        with lifecycle.lifecycle_lock(required=True) as guard:
            token = guard.begin_hold("owner-deploy", "portal:api", "uncertain")
            guard.mark_revocation("portal:api", "revoked")
        for present in [True, False]:
            if present:
                self.config.write_text('{"enabled":false}')
            else:
                self.config.unlink()
            with lifecycle.lifecycle_lock() as guard:
                self.assertTrue(guard.active)
                self.assertEqual(guard.read_hold()["token"], token)
                self.assertEqual(len(guard.read_hold()["revocations"]), 1)
                with self.assertRaisesRegex(lifecycle.LifecycleError, "MAINTENANCE_HOLD"):
                    guard.begin_hold("owner-deploy", "portal:api", "another")
                with self.assertRaisesRegex(lifecycle.LifecycleError, "REENROLLMENT_REQUIRED"):
                    guard.complete_hold(token)

    def test_enabled_configuration_requires_existing_private_state(self):
        self.state.rmdir()
        with self.assertRaises(FileNotFoundError):
            with lifecycle.lifecycle_lock(required=True):
                self.fail("Missing commissioned state must block")
        self.assertFalse(self.state.exists())

    def test_exclusive_lock_blocks_another_open_description(self):
        with lifecycle.lifecycle_lock(required=True) as guard:
            self.assertTrue(guard.active)
            with self.assertRaises(lifecycle.LifecycleBusy):
                with lifecycle.lifecycle_lock(required=True):
                    self.fail("Only one lifecycle action may enter")
        with lifecycle.lifecycle_lock(required=True):
            pass

    def test_interruption_retains_hold_after_lock_release(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            with lifecycle.lifecycle_lock(required=True) as guard:
                token = guard.begin_hold("owner-deploy", "portal:api", "operation")
                raise RuntimeError("interrupted")
        with lifecycle.lifecycle_lock(required=True) as guard:
            self.assertEqual(guard.read_hold()["token"], token)
            with self.assertRaisesRegex(lifecycle.LifecycleError, "MAINTENANCE_HOLD"):
                guard.begin_hold("owner-deploy", "portal:api", "other", resume=True)
            resumed = guard.begin_hold("owner-deploy", "portal:api", "operation", resume=True)
            self.assertEqual(resumed, token)
            guard.complete_hold(token)
            self.assertIsNone(guard.read_hold())

    @unittest.skipUnless(hasattr(os, "fork"), "POSIX flock process lifetime")
    def test_process_exit_releases_flock_but_preserves_durable_hold(self):
        child = os.fork()
        if child == 0:
            try:
                with lifecycle.lifecycle_lock(required=True) as guard:
                    guard.begin_hold("owner-deploy", "portal:api", "child-action")
                    os._exit(0)
            except BaseException:
                os._exit(1)
        _pid, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        with lifecycle.lifecycle_lock(required=True) as guard:
            self.assertEqual(guard.read_hold()["reference"], "child-action")

    def test_wrong_completion_token_or_closed_guard_cannot_clear_hold(self):
        with lifecycle.lifecycle_lock(required=True) as guard:
            token = guard.begin_hold("maintenance", "portal:api", "intentional-stop")
            with self.assertRaisesRegex(lifecycle.LifecycleError, "HOLD_CHANGED"):
                guard.complete_hold("wrong")
            self.assertEqual(guard.read_hold()["token"], token)
        with self.assertRaisesRegex(lifecycle.LifecycleError, "GUARD_CLOSED"):
            guard.complete_hold(token)
        self.assertTrue(lifecycle.HOLD.exists())

    def test_lock_inode_replacement_invalidates_open_guard(self):
        with lifecycle.lifecycle_lock(required=True) as guard:
            lifecycle.LOCK.unlink()
            lifecycle.LOCK.write_bytes(b"")
            lifecycle.LOCK.chmod(0o600)
            with self.assertRaisesRegex(lifecycle.LifecycleError, "FILE_REPLACED"):
                guard.begin_hold("owner-deploy", "portal:api", "operation")

    def test_symlink_hardlink_public_mode_and_writable_ancestor_are_refused(self):
        source = self.root / "source.json"
        source.write_text('{"enabled":true}')
        source.chmod(0o600)
        self.config.unlink()
        self.config.symlink_to(source)
        with self.assertRaises(lifecycle.LifecycleError):
            lifecycle.read_private_json(self.config)
        self.config.unlink()
        os.link(source, self.config)
        with self.assertRaises(lifecycle.LifecycleError):
            lifecycle.read_private_json(self.config)
        self.config.unlink()
        self.config.write_text('{"enabled":true}')
        self.config.chmod(0o644)
        with self.assertRaises(lifecycle.LifecycleError):
            lifecycle.read_private_json(self.config)
        self.config.chmod(0o600)
        self.root.chmod(0o777)
        try:
            with self.assertRaises(lifecycle.LifecycleError):
                lifecycle.read_private_json(self.config)
        finally:
            self.root.chmod(0o700)

    def test_duplicate_nonfinite_nonboolean_and_oversized_configuration_fails_closed(self):
        for raw in [
            '{"enabled":false,"enabled":true}',
            '{"enabled":true,"budget":NaN}',
            '{"enabled":"true"}',
            '{"enabled":1}',
            'null',
            '[]',
            '1',
            '"enabled"',
            " " * (lifecycle.MAX_BYTES + 1),
        ]:
            with self.subTest(raw=raw[:45]):
                self.config.write_text(raw)
                with self.assertRaises(lifecycle.LifecycleError):
                    with lifecycle.lifecycle_lock(required=True):
                        self.fail("Invalid configuration cannot enable recovery")

    def test_malformed_hold_is_not_replaced_or_cleared(self):
        lifecycle.HOLD.write_text('{"partial":')
        lifecycle.HOLD.chmod(0o600)
        before = lifecycle.HOLD.read_bytes()
        with lifecycle.lifecycle_lock(required=True) as guard:
            with self.assertRaises(lifecycle.LifecycleError):
                guard.begin_hold("owner-deploy", "portal:api", "new")
        self.assertEqual(lifecycle.HOLD.read_bytes(), before)

    def test_null_hold_cannot_be_mistaken_for_absent_maintenance(self):
        lifecycle.HOLD.write_text('null')
        lifecycle.HOLD.chmod(0o600)
        with lifecycle.lifecycle_lock(required=True) as guard:
            with self.assertRaisesRegex(lifecycle.LifecycleError, "OBJECT_REQUIRED"):
                guard.read_hold()

    def test_revocation_preserves_existing_hold_and_blocks_automatic_completion(self):
        with lifecycle.lifecycle_lock(required=True) as guard:
            token = guard.begin_hold("owner-deploy", "portal:api", "pending")
            guard.mark_revocation("portal:api", "revoked-authorization")
            hold = guard.read_hold()
            self.assertEqual(hold["token"], token)
            self.assertEqual(hold["reference"], "pending")
            self.assertEqual(hold["revocations"], [{"scope": "portal:api", "reference": "revoked-authorization"}])
            with self.assertRaisesRegex(lifecycle.LifecycleError, "REENROLLMENT_REQUIRED"):
                guard.complete_hold(token)

    def test_hold_fsync_failure_prevents_action_and_leaves_fail_closed_record(self):
        called = []
        with lifecycle.lifecycle_lock(required=True) as guard:
            with patch.object(lifecycle.os, "fsync", side_effect=OSError("sync failure")):
                with self.assertRaises(OSError):
                    guard.begin_hold("owner-deploy", "portal:api", "operation")
                    called.append("provider action")
        self.assertEqual(called, [])
        self.assertTrue(lifecycle.HOLD.exists())

    def test_atomic_state_write_failure_preserves_prior_budget(self):
        path = self.state / "budget.json"
        lifecycle.write_private_json(path, {"used": 2})
        with patch.object(lifecycle.os, "replace", side_effect=OSError("replace failure")):
            with self.assertRaises(OSError):
                lifecycle.write_private_json(path, {"used": 0})
        self.assertEqual(lifecycle.read_private_json(path), {"used": 2})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class OwnerLifecycleTests(LifecycleFixture, unittest.TestCase):
    # Reuse fixture setup, not the independent filesystem tests above.
    @classmethod
    def setUpClass(cls):
        owner_fixtures.OwnerStoreTests.setUpClass()

    def setUp(self):
        super().setUp()
        self.fixture = owner_fixtures.OwnerStoreTests("test_valid_owner_run_chain_keeps_actual_CI_and_observed_identity")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_whole_chain_holds_lock_for_every_runner_and_clears_only_after_success(self):
        store = self.fixture.store
        original = store.runner
        phases = []
        def runner(phase, binding, context):
            phases.append(phase)
            self.assertIsNotNone(lifecycle.read_private_json(lifecycle.HOLD))
            with self.assertRaises(lifecycle.LifecycleBusy):
                with lifecycle.lifecycle_lock(required=True):
                    self.fail("Recovery entered an owner operation")
            return original(phase, binding, context)
        with patch.object(store, "runner", side_effect=runner):
            context = self.fixture.context()
            qualification = store.qualify(context)
            authorization = store.authorize(qualification["record"]["id"])
            result = store.deploy(authorization["record"]["id"])
        self.assertEqual(result["record"]["kind"], "production-verification")
        self.assertEqual(phases, ["staging", "operations", "operations", "operations", "deploy", "production"])
        self.assertFalse(lifecycle.HOLD.exists())

    def test_failed_provider_request_remains_held_until_matching_explicit_observation(self):
        store = self.fixture.store
        qualification = store.qualify(self.fixture.context())
        authorization = store.authorize(qualification["record"]["id"])["record"]["id"]
        self.fixture.settings({"interrupt": True})
        with self.assertRaises(owner.Rejected):
            store.deploy(authorization)
        held = lifecycle.read_private_json(lifecycle.HOLD)
        row = store.db.execute("SELECT id,state FROM deployments").fetchone()
        self.assertEqual(row[1], "request-recorded")
        retry = store.deploy(authorization)
        self.assertEqual(retry["action"], "INSPECT_ONLY_NO_DUPLICATE_REQUEST")
        self.assertEqual(lifecycle.read_private_json(lifecycle.HOLD), held)
        self.assertEqual((self.fixture.root / "provider-count").read_text(), "1")
        self.fixture.settings({})
        store.inspect(row[0], observe=True)
        self.assertFalse(lifecycle.HOLD.exists())
        self.assertEqual((self.fixture.root / "provider-count").read_text(), "1")

    def test_acceptance_failure_keeps_hold_after_provider_return(self):
        store = self.fixture.store
        qualification = store.qualify(self.fixture.context())
        authorization = store.authorize(qualification["record"]["id"])["record"]["id"]
        with patch.object(store, "_inspect", side_effect=RuntimeError("acceptance interrupted")):
            with self.assertRaises(RuntimeError):
                store.deploy(authorization)
        row = store.db.execute("SELECT id,state FROM deployments").fetchone()
        self.assertEqual(row[1], "deployed-unverified")
        self.assertTrue(lifecycle.HOLD.exists())
        store.inspect(row[0], observe=True)
        self.assertFalse(lifecycle.HOLD.exists())

    def test_maintenance_blocks_context_reservation_and_provider_work(self):
        context = self.fixture.context()
        with lifecycle.lifecycle_lock(required=True) as guard:
            guard.begin_hold("maintenance", "portal:api", "intentional-stop")
        with patch.object(self.fixture.store, "runner", side_effect=AssertionError("No provider work")):
            with self.assertRaisesRegex(owner.Rejected, "MAINTENANCE_HOLD"):
                self.fixture.store.qualify(context)
        self.assertEqual(self.fixture.store.db.execute("SELECT state FROM contexts WHERE id=?", (context,)).fetchone()[0], "issued")

    def test_helper_tamper_is_rejected_before_executing_code(self):
        with patch.object(owner, "LIFECYCLE_SHA256", "0" * 64):
            with self.assertRaisesRegex(owner.Rejected, "helper source pin"):
                owner.lifecycle_module()

    def test_owner_revocation_is_durable_and_never_auto_clears_recovery_hold(self):
        context = self.fixture.context()
        result = self.fixture.store.revoke(context)
        self.assertEqual(result["record"]["kind"], "revocation")
        self.assertEqual(self.fixture.store.db.execute("SELECT revoked FROM records WHERE id=?", (context,)).fetchone()[0], 1)
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        self.assertEqual(hold["kind"], "owner-revoke")
        self.assertEqual(len(hold["revocations"]), 1)

    def test_accepted_runtime_revocation_inhibits_reobservation_until_owner_reconciliation(self):
        store = self.fixture.store
        qualification = store.qualify(self.fixture.context())
        authorization = store.authorize(qualification["record"]["id"])["record"]["id"]
        accepted = store.deploy(authorization)
        operation = accepted["record"]["parent"]
        store.revoke(authorization)
        with self.assertRaisesRegex(owner.Rejected, "MAINTENANCE_HOLD"):
            store.inspect(operation, observe=True)
        self.assertEqual(store.db.execute("SELECT state FROM deployments WHERE id=?", (operation,)).fetchone()[0], "accepted")
        self.assertTrue(lifecycle.read_private_json(lifecycle.HOLD)["revocations"])

    def test_revocation_during_uncertain_request_survives_later_acceptance(self):
        store = self.fixture.store
        qualification = store.qualify(self.fixture.context())
        authorization = store.authorize(qualification["record"]["id"])["record"]["id"]
        self.fixture.settings({"interrupt": True})
        with self.assertRaises(owner.Rejected):
            store.deploy(authorization)
        token = lifecycle.read_private_json(lifecycle.HOLD)["token"]
        operation = store.db.execute("SELECT id FROM deployments").fetchone()[0]
        store.revoke(authorization)
        self.fixture.settings({})
        store.inspect(operation, observe=True)
        held = lifecycle.read_private_json(lifecycle.HOLD)
        self.assertEqual(held["token"], token)
        self.assertTrue(held["revocations"])
        self.assertEqual(store.db.execute("SELECT state FROM deployments WHERE id=?", (operation,)).fetchone()[0], "accepted")


if __name__ == "__main__":
    unittest.main()
