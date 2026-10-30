"""Real disposable signatures for completed-request disposition, never acceptance."""

import json
import unittest
from datetime import timedelta

import oracle_portal as r
import oracle_portal_scanner as scanner
import test_oracle_owner as owner_fixtures
import test_oracle_portal_scanner as scanner_fixtures


class CompletedRevocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        owner_fixtures.OwnerStoreTests.setUpClass()

    def setUp(self):
        self.fixture = scanner_fixtures.SignedScannerContextTests(
            "test_valid_owner_zero_retains_positive_underlying_ci"
        )
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.owner = self.fixture.owner
        self.binding = self.owner.binding
        qualification = self.owner.store.qualify(self.owner.context())["record"]
        authorization = self.owner.store.authorize(qualification["id"])["record"]
        self.intent = self.owner.store.put(
            "deployment-intent",
            self.binding,
            {
                "authorization": authorization["id"],
                "provider_request_budget": 1,
                "automatic_retry": False,
            },
            parent=authorization["id"],
        )["record"]
        self.operation = self.intent["id"]
        self.owner.store.db.execute(
            "INSERT INTO deployments VALUES(?,?,?,'request-recorded')",
            (self.operation, authorization["id"], qualification["id"]),
        )
        self.path = self.owner.root / self.operation
        self.path.mkdir(mode=0o700)
        r.write(
            self.path / "scanner-override.json",
            {"services": {"scanner": {"image": self.binding["artifact_digest"]}}},
        )
        self.result = {
            "operation_id": self.operation,
            "returncode": 0,
            "automatic_retry": False,
            "observed_at": r.now().isoformat(),
        }
        r.write(self.path / "provider-command-result.json", self.result)
        self.request = {
            "binding": self.binding,
            "context": {
                "operation_id": self.operation,
                "authorization_id": authorization["id"],
            },
            "verifier_store": str(self.owner.root),
            "request_budget": 1,
            "automatic_retry": False,
            "override_sha256": r.sha(self.path / "scanner-override.json"),
        }
        self.next_binding = {
            **self.binding,
            "candidate_commit": "f" * 40,
            "source_tree": "e" * 40,
            "artifact_digest": "sha256:" + "9" * 64,
        }

    def revoke(self):
        self.revocation = self.owner.store.revoke(self.operation)["record"]

    def check(self):
        return scanner.acknowledged_completed_request(
            self.path, self.request, self.next_binding
        )

    def rewrite_result(self, value):
        (self.path / "provider-command-result.json").write_bytes(r.canonical(value))

    def test_completed_signed_revocation_allows_only_fresh_release_and_writes_no_acceptance(
        self,
    ):
        self.revoke()
        before = list(self.owner.store.db.execute("SELECT * FROM records"))
        self.assertTrue(self.check())
        self.assertEqual(
            before, list(self.owner.store.db.execute("SELECT * FROM records"))
        )
        self.assertEqual(
            self.owner.store.db.execute("SELECT state FROM deployments").fetchone()[0],
            "request-recorded",
        )
        self.assertEqual(
            self.owner.store.db.execute(
                "SELECT count(*) FROM records WHERE kind='production-verification'"
            ).fetchone()[0],
            0,
        )

    def test_unrevoked_request_remains_blocking(self):
        with self.assertRaisesRegex(
            r.Refused, "EXPLICIT_UNACCEPTED_INTENT_REVOCATION_REQUIRED"
        ):
            self.check()

    def test_accepted_or_unknown_ledger_state_cannot_use_unaccepted_disposition(self):
        self.revoke()
        for state in ["accepted", "unknown"]:
            self.owner.store.db.execute("UPDATE deployments SET state=?", (state,))
            with self.assertRaisesRegex(
                r.Refused, "EXPLICIT_UNACCEPTED_INTENT_REVOCATION_REQUIRED"
            ):
                self.check()

    def test_same_source_tree_foreign_component_or_environment_cannot_use_disposition(
        self,
    ):
        self.revoke()
        for key, value in [
            ("candidate_commit", self.binding["candidate_commit"]),
            ("source_tree", self.binding["source_tree"]),
            ("repository", "foreign/repo"),
            ("component", "worker"),
            ("target_environment", "staging"),
        ]:
            with self.subTest(key=key):
                original = self.next_binding
                self.next_binding = {**original, key: value}
                self.assertFalse(self.check())
                self.next_binding = original

    def test_missing_failed_timed_out_or_automatic_retry_result_remains_blocking(self):
        self.revoke()
        for value in [
            {**self.result, "returncode": 1},
            {**self.result, "returncode": False},
            {**self.result, "automatic_retry": True},
            {**self.result, "operation_id": "0" * 36},
            {"state": "TIMED_OUT_OUTCOME_UNCERTAIN", "automatic_retry": False},
        ]:
            with self.subTest(value=value):
                self.rewrite_result(value)
                with self.assertRaises(r.Refused):
                    self.check()
        (self.path / "provider-command-result.json").unlink()
        self.assertFalse(self.check())

    def test_changed_override_and_foreign_authorization_are_refused(self):
        self.revoke()
        override = self.path / "scanner-override.json"
        original = override.read_bytes()
        override.write_bytes(b"{}")
        with self.assertRaisesRegex(
            r.Refused, "PREVIOUS_SCANNER_REQUEST_IDENTITY_CHANGED"
        ):
            self.check()
        override.write_bytes(original)
        self.request["context"]["authorization_id"] = "0" * 36
        with self.assertRaisesRegex(
            r.Refused, "PREVIOUS_SCANNER_REQUEST_IDENTITY_CHANGED"
        ):
            self.check()

    def test_modified_or_actions_provenance_revocations_fail_closed(self):
        self.revoke()
        original = self.owner.store.db.execute(
            "SELECT envelope FROM records WHERE id=?", (self.revocation["id"],)
        ).fetchone()[0]
        for change in [
            lambda v: v["record"].update(workflow_run_id=123),
            lambda v: v["record"]["binding"].update(component="worker"),
            lambda v: v["record"].update(
                issued_at=(r.now() + timedelta(minutes=1)).isoformat()
            ),
            lambda v: v["signature"].update(value="AA=="),
        ]:
            envelope = json.loads(original)
            change(envelope)
            self.owner.store.db.execute(
                "UPDATE records SET envelope=? WHERE id=?",
                (r.canonical(envelope).decode(), self.revocation["id"]),
            )
            with self.assertRaises((r.Refused, ValueError)):
                self.check()
        self.owner.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?",
            (original, self.revocation["id"]),
        )
        self.assertTrue(self.check())

    def test_revoked_decision_or_unsigned_caller_json_cannot_close_history(self):
        self.revoke()
        self.owner.store.db.execute(
            "UPDATE records SET revoked=1 WHERE id=?", (self.revocation["id"],)
        )
        (self.path / "caller-revocation.json").write_text(
            json.dumps(
                {"revoked_id": self.operation, "workflow_run_id": 0, "approved": True}
            )
        )
        with self.assertRaisesRegex(
            r.Refused, "SIGNED_COMPLETED_SCANNER_REVOCATION_MISSING"
        ):
            self.check()


if __name__ == "__main__":
    unittest.main()
