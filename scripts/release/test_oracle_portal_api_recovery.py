"""Real disposable signatures/ledger; synthetic I/O, never hosted acceptance."""

import base64
import copy
import datetime as dt
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import oracle_owner as owner
import oracle_portal_api_recovery as recovery
from test_oracle_install import Source
from test_oracle_owner import OwnerStoreTests


class RecoveryTests(unittest.TestCase):
    open = OwnerStoreTests.open
    settings = OwnerStoreTests.settings
    commission_fixture = OwnerStoreTests.commission_fixture
    context = OwnerStoreTests.context
    qualified = OwnerStoreTests.qualified
    authorization = OwnerStoreTests.authorization

    @classmethod
    def setUpClass(cls):
        OwnerStoreTests.setUpClass.__func__(cls)

    def setUp(self):
        OwnerStoreTests.setUp(self)
        authorization = self.authorization()
        with self.store.transaction():
            intent = self.store.put(
                "deployment-intent",
                self.binding,
                {
                    "authorization": authorization,
                    "provider_request_budget": 1,
                    "automatic_retry": False,
                },
                parent=authorization,
            )["record"]
            qualification = self.store.get(authorization)["record"]["parent"]
            self.store.db.execute(
                "INSERT INTO deployments(id,authorization,qualification,state) VALUES(?,?,?,'request-recorded')",
                (intent["id"], authorization, qualification),
            )
        self.operation = intent["id"]
        self.code_root = (
            self.root / "code" / ("portal-api-observer-" + self.binding["source_tree"])
        )
        self.code_root.mkdir(mode=0o700, parents=True)
        repo = Path(__file__).resolve().parents[2]
        self.files = {}
        for local, upstream in recovery.installer.API_ALLOWED.items():
            path = self.code_root / local
            path.parent.mkdir(mode=0o700, exist_ok=True)
            path.write_bytes((repo / upstream).read_bytes())
            path.chmod(0o600)
            self.files[upstream] = path.read_bytes()
        self.pins = {
            local: owner.file_digest(self.code_root / local)
            for local in recovery.installer.API_ALLOWED
        }
        self.source = {
            key: self.binding[key]
            for key in ["repository", "candidate_commit", "source_tree"]
        }
        self.enterContext(
            patch.object(recovery.api, "component_lock", side_effect=nullcontext)
        )
        self.enterContext(
            patch.object(recovery, "installed_files", return_value=self.pins)
        )
        self.enterContext(
            patch.object(
                recovery.api.r,
                "read",
                return_value={"returncode": 0, "automatic_retry": False},
            )
        )
        self.calls = []
        self.observation = self.store.runner(
            "production",
            self.binding,
            {"operation_id": self.operation, "read_only": True},
        )["observations"]
        self.enterContext(
            patch.object(recovery.api, "runner", side_effect=self.actual_observation)
        )

    def actual_observation(
        self, phase, binding, context, *, observer_tool, independent=None
    ):
        self.assertEqual(phase, "production")
        self.assertEqual(binding, self.binding)
        self.assertEqual(context, {"operation_id": self.operation, "read_only": True})
        self.assertEqual(
            observer_tool,
            (
                self.code_root / "runners" / recovery.api.PRODUCTION_TOOL,
                self.pins["runners/" + recovery.api.PRODUCTION_TOOL],
            ),
        )
        self.calls.append(phase)
        return copy.deepcopy(self.observation)

    def commission(self, independent=None):
        with self.store.transaction():
            return self.store.put(
                "production-observer-commission",
                self.binding,
                {
                    "operation_id": self.operation,
                    "observer_source": self.source,
                    "installed_root": str(self.code_root),
                    "file_pins": self.pins,
                    "ci": [{"run_id": 123}],
                    "purpose": "read-only-observer-defect-correction",
                    "deployment_requests": 0,
                    "qualification_reissued": False,
                    "authorization_reissued": False,
                    **(
                        {
                            "independent_receipt_references": [
                                {
                                    "store": "fixture-only",
                                    "record": "fixture-only",
                                    "environment": "staging",
                                }
                            ],
                            "independent_runtime_baselines": independent,
                            "independent_receipt_provenance": [
                                {"record": "fixture-only"}
                            ],
                        }
                        if independent
                        else {}
                    ),
                },
                parent=self.operation,
            )["record"]["id"]

    def test_valid_observation_accepts_exact_existing_intent_without_deployment(self):
        count = self.store.db.execute(
            "SELECT count(*) FROM records WHERE kind IN ('context','qualification','authorization','deployment-intent')"
        ).fetchone()[0]
        result = recovery.observe(self.store, self.commission(), self.code_root)[
            "record"
        ]
        self.assertEqual(result["binding"], self.binding)
        self.assertEqual(result["parent"], self.operation)
        self.assertFalse(result["details"]["provider_request_repeated"])
        self.assertEqual(self.calls, ["production"])
        self.assertEqual(
            self.store.db.execute("SELECT state FROM deployments").fetchone()[0],
            "accepted",
        )
        self.assertEqual(
            self.store.db.execute(
                "SELECT count(*) FROM records WHERE kind IN ('context','qualification','authorization','deployment-intent')"
            ).fetchone()[0],
            count,
        )

    def test_commissioned_independent_baseline_is_revalidated_before_and_after_observation(
        self,
    ):
        baseline = {
            "onesa-robot-oracle-api-staging-1": {"source": "synthetic-peer-only"}
        }
        expected = (baseline, [{"record": "fixture-only"}])
        commission = self.commission(baseline)
        with (
            patch.object(
                recovery, "independent_receipts", return_value=expected
            ) as peer,
            patch.object(
                recovery.api, "runner", return_value=self.observation
            ) as runner,
        ):
            result = recovery.observe(self.store, commission, self.code_root)
        self.assertEqual(peer.call_count, 2)
        self.assertEqual(runner.call_args.kwargs["independent"], baseline)
        self.assertEqual(
            result["record"]["details"]["independent_receipt_provenance"], expected[1]
        )

    def test_peer_revocation_or_runtime_drift_during_observation_never_accepts(self):
        baseline = {
            "onesa-robot-oracle-api-staging-1": {"source": "synthetic-peer-only"}
        }
        expected = (baseline, [{"record": "fixture-only"}])
        commission = self.commission(baseline)
        for terminal in [owner.Rejected("peer revoked during observation"), ({}, [])]:
            with (
                patch.object(
                    recovery, "independent_receipts", side_effect=[expected, terminal]
                ),
                self.assertRaises(owner.Rejected),
            ):
                recovery.observe(self.store, commission, self.code_root)
            self.assertEqual(
                self.store.db.execute("SELECT state FROM deployments").fetchone()[0],
                "request-recorded",
            )
        self.assertEqual(
            self.store.db.execute(
                "SELECT count(*) FROM records WHERE kind='production-verification'"
            ).fetchone()[0],
            0,
        )

    def test_expired_original_qualification_is_historical_but_new_commission_is_fresh(
        self,
    ):
        self.store.clock = lambda: (
            dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
        )
        self.observation["observed_at"] = self.store.clock().isoformat()
        result = recovery.observe(self.store, self.commission(), self.code_root)
        self.assertIsNotNone(result)

    def test_changed_scope_artifact_source_or_incomplete_checks_never_accept(self):
        commission = self.commission()
        for key, value in [
            ("component", "worker"),
            ("candidate_commit", "f" * 40),
            ("target_environment", "staging"),
            ("artifact_digest", "sha256:" + "f" * 64),
        ]:
            saved = copy.deepcopy(self.observation)
            self.observation["binding"][key] = value
            with self.subTest(key=key), self.assertRaises(owner.Rejected):
                recovery.observe(self.store, commission, self.code_root)
            self.observation = saved
        for change in [
            {"workflow_run_id": 123},
            {"environment": "staging"},
            {"operation_id": "wrong"},
            {"deployment_id": None},
            {"checks": {}},
            {
                "observed_at": (
                    dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=6)
                ).isoformat()
            },
        ]:
            saved = copy.deepcopy(self.observation)
            self.observation.update(change)
            with self.subTest(change=change), self.assertRaises(owner.Rejected):
                recovery.observe(self.store, commission, self.code_root)
            self.observation = saved
        self.assertEqual(
            self.store.db.execute("SELECT state FROM deployments").fetchone()[0],
            "request-recorded",
        )

    def test_revocation_of_any_original_ancestor_or_commission_refuses_recovery(self):
        commission = self.commission()
        rows = self.store.db.execute("SELECT id FROM records").fetchall()
        for (identity,) in rows:
            self.store.db.execute(
                "UPDATE records SET revoked=1 WHERE id=?", (identity,)
            )
            with self.subTest(identity=identity), self.assertRaises(owner.Rejected):
                recovery.observe(self.store, commission, self.code_root)
            self.store.db.execute(
                "UPDATE records SET revoked=0 WHERE id=?", (identity,)
            )
        self.assertEqual(self.calls, [])

    def test_expired_commission_and_changed_installed_code_are_refused(self):
        commission = self.commission()
        self.store.clock = lambda: (
            dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
        )
        with self.assertRaises(owner.Rejected):
            recovery.observe(self.store, commission, self.code_root)
        self.store.clock = lambda: dt.datetime.now(dt.timezone.utc)
        with (
            patch.object(recovery, "installed_files", return_value={}),
            self.assertRaises(owner.Rejected),
        ):
            recovery.observe(self.store, commission, self.code_root)
        self.assertEqual(self.calls, [])

    def test_failed_or_uncertain_provider_command_cannot_be_recovered_as_success(self):
        commission = self.commission()
        for provider in [
            {"returncode": 1, "automatic_retry": False},
            {"state": "TIMED_OUT_OUTCOME_UNCERTAIN", "automatic_retry": False},
        ]:
            with (
                patch.object(recovery.api.r, "read", return_value=provider),
                self.assertRaises(owner.Rejected),
            ):
                recovery.observe(self.store, commission, self.code_root)
        self.assertEqual(self.calls, [])

    def test_interrupted_observation_stays_unresolved_and_resume_never_dispatches_deployment(
        self,
    ):
        commission = self.commission()
        with (
            patch.object(
                recovery.api,
                "runner",
                side_effect=RuntimeError("synthetic interrupted read"),
            ),
            self.assertRaises(RuntimeError),
        ):
            recovery.observe(self.store, commission, self.code_root)
        self.assertEqual(
            self.store.db.execute("SELECT state FROM deployments").fetchone()[0],
            "request-recorded",
        )
        recovery.observe(self.store, commission, self.code_root)
        result = recovery.observe(self.store, commission, self.code_root)
        self.assertEqual(result["state"], "accepted")
        self.assertEqual(self.calls, ["production"])

    def test_commission_requires_external_owner_and_current_reviewed_source(self):
        with (
            patch.object(recovery.os, "geteuid", return_value=1000),
            self.assertRaises(owner.Rejected),
        ):
            recovery.commission(self.store, self.operation, self.source, self.code_root)
        with (
            patch.object(recovery.os, "geteuid", return_value=0),
            patch.dict(os.environ, {"SUDO_USER": "ubuntu", "GITHUB_ACTIONS": "true"}),
            self.assertRaises(owner.Rejected),
        ):
            recovery.commission(self.store, self.operation, self.source, self.code_root)
        with (
            patch.object(recovery.os, "geteuid", return_value=0),
            patch.dict(os.environ, {"SUDO_USER": "ubuntu", "GITHUB_ACTIONS": ""}),
            patch.object(
                recovery,
                "reviewed_source",
                side_effect=owner.Rejected("real CI failed"),
            ),
            self.assertRaises(owner.Rejected),
        ):
            recovery.commission(self.store, self.operation, self.source, self.code_root)

    def test_reviewed_source_checks_every_actual_installed_byte_and_source_scope(self):
        github = Source(self.files)
        self.assertEqual(
            recovery.reviewed_source(github, self.source, self.code_root)[0], self.pins
        )
        github.failed = True
        with self.assertRaises(owner.Rejected):
            recovery.reviewed_source(github, self.source, self.code_root)
        github.failed = False
        github.truncated = True
        with self.assertRaises(owner.Rejected):
            recovery.reviewed_source(github, self.source, self.code_root)
        github.truncated = False
        (self.code_root / "runners" / recovery.api.PRODUCTION_TOOL).write_text(
            "modified installed observer"
        )
        with self.assertRaises(owner.Rejected):
            recovery.reviewed_source(github, self.source, self.code_root)
        with self.assertRaises(owner.Rejected):
            recovery.reviewed_source(
                github, {**self.source, "repository": "foreign/repo"}, self.code_root
            )

    def test_modified_commission_or_actions_evidence_never_grants_authority(self):
        commission = self.commission()
        original = self.store.db.execute(
            "SELECT envelope FROM records WHERE id=?", (commission,)
        ).fetchone()[0]
        modified = json.loads(original)
        modified["record"]["details"]["installed_root"] = "/tmp/forged"
        self.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?",
            (json.dumps(modified), commission),
        )
        with self.assertRaises(owner.Rejected):
            recovery.observe(self.store, commission, self.code_root)
        self.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?", (original, commission)
        )
        with self.store.transaction():
            action = self.store.put(
                "actions-artifact", self.binding, {"workflow_run_id": 123}
            )["record"]["id"]
        with self.assertRaises(owner.Rejected):
            recovery.observe(self.store, action, self.code_root)
        self.assertEqual(self.calls, [])

    def test_simultaneous_observers_accept_once_without_duplicate_observation(self):
        commission = self.commission()
        barrier = threading.Barrier(2)

        def run(_):
            store = self.open()
            try:
                barrier.wait()
                return recovery.observe(store, commission, self.code_root)
            finally:
                store.db.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(self.calls, ["production"])
        self.assertEqual(
            sum(
                value.get("record", {}).get("kind") == "production-verification"
                for value in results
            ),
            1,
        )

    def test_signed_failed_or_skipped_original_checks_cannot_be_requalified(self):
        commission = self.commission()
        identity = self.store.db.execute(
            "SELECT id FROM records WHERE kind='qualification'"
        ).fetchone()[0]
        original = self.store.db.execute(
            "SELECT envelope FROM records WHERE id=?", (identity,)
        ).fetchone()[0]
        for status in ["FAIL", "SKIP", None]:
            changed = json.loads(original)
            changed["record"]["details"]["staging"]["observations"]["checks"][
                "workflow"
            ] = status
            changed["signature"]["value"] = base64.b64encode(
                owner.signed_bytes(
                    self.root / "signing.pem",
                    self.root / "public.pem",
                    owner.canonical(changed["record"]),
                )
            ).decode()
            self.store.db.execute(
                "UPDATE records SET envelope=? WHERE id=?",
                (json.dumps(changed), identity),
            )
            with self.subTest(status=status), self.assertRaises(owner.Rejected):
                recovery.observe(self.store, commission, self.code_root)
        self.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?", (original, identity)
        )
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
