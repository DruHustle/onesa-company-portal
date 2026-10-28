"""Synthetic mixed CI-event fixtures; never hosted evidence or release authority."""

import unittest
from datetime import timedelta

import oracle_owner as owner
import test_oracle_owner as fixtures


class CISelectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GitHubEvidenceTests()
        self.fixture.setUp()
        self.original_api = self.fixture.api
        self.fixture.github.api = self.api
        self.no_push = False
        self.manual_change = {}
        self.listing_count = None

    def api(self, path):
        mapped = path
        for manual, push in [(101, 1), (102, 2)]:
            marker = "/actions/runs/" + str(manual)
            if marker not in path:
                continue
            mapped = path.replace(marker, "/actions/runs/" + str(push), 1)
            old = self.fixture.bad
            self.fixture.bad = {}
            try:
                result = self.original_api(mapped)
            finally:
                self.fixture.bad = old
            if path.endswith(marker):
                result.update(
                    id=manual,
                    event="workflow_dispatch",
                    actor={"login": owner.OWNER},
                    triggering_actor={"login": owner.OWNER},
                )
                result.update(self.manual_change)
            return result
        result = self.original_api(path)
        if "/actions/workflows/" in path:
            pushes = result["workflow_runs"]
            manual = [
                dict(row, id=row["id"] + 100, event="workflow_dispatch")
                for row in pushes
            ]
            result["workflow_runs"] = manual if self.no_push else pushes + manual
            result["total_count"] = len(result["workflow_runs"])
            if self.listing_count is not None:
                result["total_count"] = self.listing_count
        return result

    def qualify(self):
        return self.fixture.github.qualify(self.fixture.binding)

    def test_existing_successful_push_keeps_its_real_ids_and_event(self):
        result = self.qualify()
        self.assertEqual([row["run_id"] for row in result], [1, 2])
        self.assertTrue(all(row["event"] == "push" for row in result))

    def test_newer_successful_manual_run_cannot_hide_unqualified_push(self):
        for status, conclusion in [
            ("completed", "failure"),
            ("completed", "skipped"),
            ("completed", "cancelled"),
            ("in_progress", None),
        ]:
            self.fixture.bad = {"run": {"status": status, "conclusion": conclusion}}
            with (
                self.subTest(status=status, conclusion=conclusion),
                self.assertRaises(owner.Rejected),
            ):
                self.qualify()
        for value in ["failure", "skipped"]:
            self.fixture.bad = {"job": value}
            with self.subTest(job=value), self.assertRaises(owner.Rejected):
                self.qualify()

    def test_absent_push_allows_full_owner_dispatch_without_relabeling(self):
        self.no_push = True
        result = self.qualify()
        self.assertEqual([row["run_id"] for row in result], [101, 102])
        self.assertTrue(all(row["event"] == "workflow_dispatch" for row in result))
        self.assertTrue(all(row["run_attempt"] == 1 for row in result))

    def test_dispatch_rejects_foreign_missing_owner_identity_and_bad_run(self):
        self.no_push = True
        for change in [
            {"actor": {"login": "foreign"}},
            {"triggering_actor": {"login": "foreign"}},
            {"triggering_actor": {}},
            {"triggering_actor": None},
            {"run_attempt": 2},
            {"conclusion": "failure"},
            {"updated_at": (owner.timestamp() - timedelta(hours=25)).isoformat()},
        ]:
            self.manual_change = change
            with self.subTest(change=change), self.assertRaises(owner.Rejected):
                self.qualify()

    def test_incomplete_or_truncated_run_listing_cannot_hide_push_evidence(self):
        for count in [3, 101, -1]:
            self.listing_count = count
            with self.subTest(total_count=count), self.assertRaises(owner.Rejected):
                self.qualify()


if __name__ == "__main__":
    unittest.main()
