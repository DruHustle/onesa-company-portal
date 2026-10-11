"""Demonstrate deployment denial independently of Git push acceptance."""

import copy
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import evidence as e
import free_gate as f
from test_evidence import FINGERPRINT, SHA, fixtures, run


class GitHub:
    def __init__(self):
        fixture = fixtures()[0]
        self.builds, self.stage = fixture["builds"], fixture["staging"]["record"]
        self.stage["verified_at"] = datetime.now(timezone.utc).isoformat()
        self.runs_by_id = {
            10: run(10, e.POLICY["ci"], event="push"),
            11: run(11, "repository-hygiene.yml", event="push"),
            20: run(20, "release-staging.yml", branch=e.POLICY["staging_branch"]),
            30: run(30, f.QUALIFICATION),
            40: run(40, f.WORKFLOW),
        }
        for value in self.runs_by_id.values():
            value["created_at"] = value["updated_at"] = datetime.now(
                timezone.utc
            ).isoformat()
        self.ci_jobs = [
            {
                "name": name,
                "conclusion": "success",
                "html_url": "https://example.invalid/job",
                "steps": [],
            }
            for name in e.POLICY["jobs"]
        ]
        self.pr = {
            "number": 1,
            "merged_at": "2026-10-11T00:00:00Z",
            "merge_commit_sha": SHA,
            "base": {"ref": "main", "repo": {"full_name": e.REPOSITORY}},
            "head": {"ref": "feature/verified"},
            "merged_by": {"login": e.OWNER},
            "html_url": "https://github.com/" + e.REPOSITORY + "/pull/1",
        }
        self.main_sha = SHA
        self.issue = {
            "state": "open",
            "user": {"login": e.OWNER},
            "html_url": "https://github.com/" + e.REPOSITORY + "/issues/2",
            "body": "",
        }
        self.latest = 40
        self.record = None
        self.approval = None

    def api(self, path, pages=False):
        if "/branches/main" in path:
            return {"commit": {"sha": self.main_sha}}
        if "/commits/" in path:
            return [[{"number": 1}]] if self.pr else [[]]
        if "/pulls/" in path:
            return self.pr
        if "/issues/" in path:
            return self.issue
        raise AssertionError(path)

    def run(self, identifier):
        return self.runs_by_id[int(identifier)]

    def runs(self, workflow, sha):
        if workflow == f.WORKFLOW:
            return [self.run(self.latest)]
        return sorted(
            [
                value
                for value in self.runs_by_id.values()
                if value["path"] == ".github/workflows/" + workflow
            ],
            key=lambda value: value["id"],
            reverse=True,
        )

    def jobs(self, value):
        if value["id"] == 10:
            return self.ci_jobs
        if value["id"] == 50:
            return [dict(job, conclusion="success") for job in self.ci_jobs]
        return [
            {
                "name": "publication-hygiene",
                "conclusion": "success",
                "html_url": "https://example.invalid/job",
            }
        ]

    def artifact(self, value, name):
        if name.startswith("runtime-"):
            build = next(
                x for x in self.builds if name == "runtime-" + x["application"]
            )
            return {
                "repository": e.REPOSITORY,
                "candidate_commit": SHA,
                "image_digest": build["image_digest"],
                "security": "PASS",
            }, build["artifact"]
        record = (
            self.stage
            if name == "staging-verification"
            else self.record
            if name == "free-release-qualification"
            else self.approval
        )
        return copy.deepcopy(record), {
            "run_id": value["id"],
            "record_sha256": e.digest(record),
        }


class FreeGateTests(unittest.TestCase):
    def setUp(self):
        self.github = GitHub()
        self.fingerprint = patch.object(e, "source_hash", return_value=FINGERPRINT)
        self.fingerprint.start()
        self.addCleanup(self.fingerprint.stop)

    def prepare(self):
        self.github.record = f.qualification(self.github, SHA, self.github.run(30), 20)
        fingerprint = e.digest(self.github.record)
        self.github.issue["body"] = (
            SHA
            + " "
            + fingerprint
            + " OPERATIONS_APPROVED CONTENT_LEGAL_APPROVED EXTERNAL_PRODUCTION_CONTROLS_VERIFIED"
        )
        self.github.approval = f.authorize(
            self.github, SHA, self.github.run(40), 30, fingerprint, 2, "approve"
        )

    def test_automatic_qualification_derives_evidence_without_human_pass(self):
        value = self.github.run(30)
        value["event"] = "workflow_run"
        result = f.qualification(self.github, SHA, value, 20)
        self.assertEqual(result["CODE_VERIFIED"], "PASS")
        self.assertEqual(result["STAGING_VERIFIED"], "PASS")
        self.assertEqual(result["OPERATIONS_VERIFIED"], "BLOCKED")
        self.assertEqual(result["CONTENT_LEGAL_APPROVED"], "BLOCKED")
        self.assertIsNone(result["approval_provenance"])

    def test_automatic_staging_requires_exact_branch_pointers(self):
        value = self.github.run(20)
        value["event"] = "workflow_run"
        value["head_branch"] = "main"
        with patch.object(self.github, "api", return_value={"commit": {"sha": SHA}}):
            e.trusted_staging_run(self.github, value, SHA)
        with (
            patch.object(
                self.github, "api", return_value={"commit": {"sha": "b" * 40}}
            ),
            self.assertRaises(e.Rejected),
        ):
            e.trusted_staging_run(self.github, value, SHA)

    def test_automatic_staging_rejects_foreign_owner_sha_event_and_failure(self):
        original = copy.deepcopy(self.github.run(20))
        original.update(event="workflow_run", head_branch="main")
        for field, value in [
            ("head_sha", "b" * 40),
            ("event", "pull_request"),
            ("actor", {"login": "attacker"}),
            ("triggering_actor", {"login": "attacker"}),
            ("head_repository", {"full_name": "attacker/fork"}),
            ("conclusion", "failure"),
        ]:
            with self.subTest(field=field):
                candidate = copy.deepcopy(original)
                candidate[field] = value
                with self.assertRaises(e.Rejected):
                    e.trusted_staging_run(self.github, candidate, SHA)

    def test_successful_external_handoff_does_not_trigger_deployment_or_block_git(self):
        self.prepare()
        result = f.verify(self.github, SHA, 40)
        self.assertEqual(result["status"], "AUTHORIZED_EXTERNAL_HANDOFF")
        self.assertFalse(result["deployment_triggered"])
        self.assertFalse(result["git_push_prevented"])
        self.assertFalse(result["approval"]["physical_hardware_authorized"])

    def test_failing_essential_ci_blocks_handoff_before_provider_call(self):
        self.prepare()
        self.github.ci_jobs[0]["conclusion"] = "failure"
        with self.assertRaisesRegex(e.Rejected, "Essential exact-commit CI"):
            f.verify(self.github, SHA, 40)

    def test_missing_skipped_cancelled_security_jobs_block(self):
        for conclusion in (None, "skipped", "cancelled", "failure"):
            with self.subTest(conclusion=conclusion):
                self.github.ci_jobs[-1]["conclusion"] = conclusion
                with self.assertRaises(e.Rejected):
                    f.qualification(self.github, SHA, self.github.run(30), 20)

    def test_direct_push_is_deploy_ineligible_but_not_rejected_by_git(self):
        self.github.pr = None
        with self.assertRaisesRegex(e.Rejected, "direct push is deploy-ineligible"):
            f.qualification(self.github, SHA, self.github.run(30), 20)

    def test_wrong_sha_fork_owner_and_attempt_block(self):
        for field, value in [
            ("head_sha", "b" * 40),
            ("head_repository", {"full_name": "attacker/fork"}),
            ("actor", {"login": "attacker"}),
            ("triggering_actor", {"login": "attacker"}),
            ("run_attempt", 2),
        ]:
            with self.subTest(field=field):
                value_run = copy.deepcopy(self.github.run(30))
                value_run[field] = value
                with self.assertRaises(e.Rejected):
                    f.qualification(self.github, SHA, value_run, 20)

    def test_arbitrary_pass_json_cannot_authorize(self):
        self.prepare()
        self.github.record = {"CODE_VERIFIED": "PASS", "STAGING_VERIFIED": "PASS"}
        with self.assertRaises(e.Rejected):
            f.verify(self.github, SHA, 40)

    def test_owner_record_changes_revoke(self):
        self.prepare()
        self.github.issue["body"] += " amended"
        with self.assertRaisesRegex(e.Rejected, "Approval or owner review changed"):
            f.verify(self.github, SHA, 40)

    def test_closed_owner_issue_and_unreviewed_digest_block(self):
        self.prepare()
        self.github.issue["state"] = "closed"
        with self.assertRaises(e.Rejected):
            f.verify(self.github, SHA, 40)
        self.github.issue["state"] = "open"
        with self.assertRaisesRegex(e.Rejected, "exact derived evidence digest"):
            f.authorize(
                self.github, SHA, self.github.run(40), 30, "f" * 64, 2, "approve"
            )

    def test_latest_pending_or_revoked_authorization_blocks_older(self):
        self.prepare()
        self.github.runs_by_id[41] = run(41, f.WORKFLOW)
        self.github.latest = 41
        with self.assertRaisesRegex(e.Rejected, "latest owner authorization"):
            f.verify(self.github, SHA, 40)
        self.github.latest = 40
        self.github.approval["decision"] = "revoke"
        with self.assertRaisesRegex(e.Rejected, "revoked"):
            f.verify(self.github, SHA, 40)

    def test_stale_staging_and_current_main_movement_block(self):
        self.prepare()
        self.github.stage["verified_at"] = (
            datetime.now(timezone.utc) - timedelta(days=2)
        ).isoformat()
        with self.assertRaises(e.Rejected):
            f.verify(self.github, SHA, 40)
        self.github.main_sha = "b" * 40
        with self.assertRaisesRegex(e.Rejected, "current main"):
            f.verify(self.github, SHA, 40)

    def test_main_failure_cannot_be_hidden_by_newer_successful_staging_ci(self):
        alternate = run(
            50, e.POLICY["ci"], branch=e.POLICY["staging_branch"], event="push"
        )
        # Robot staging is main; this condition applies to Portal and Platform.
        if e.POLICY["staging_branch"] == "main":
            return
        self.github.runs_by_id[50] = alternate
        self.github.ci_jobs[0]["conclusion"] = "failure"
        with self.assertRaises(e.Rejected):
            f.qualification(self.github, SHA, self.github.run(30), 20)


if __name__ == "__main__":
    unittest.main()
