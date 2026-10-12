"""Synthetic, isolated release-gate regressions; these do not approve a release."""

import copy
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import evidence as e

SHA = "a" * 40
FINGERPRINT = "b" * 64
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
STAMP = NOW.isoformat()


def run(identifier, workflow, branch="main", event="workflow_dispatch"):
    return {
        "id": identifier,
        "workflow_id": identifier,
        "repository": {"full_name": e.REPOSITORY, "id": 7},
        "head_repository": {"full_name": e.REPOSITORY},
        "head_sha": SHA,
        "head_branch": branch,
        "path": ".github/workflows/" + workflow,
        "event": event,
        "run_attempt": 1,
        "actor": {"login": e.OWNER},
        "triggering_actor": {"login": e.OWNER},
        "status": "completed",
        "conclusion": "success",
        "created_at": STAMP,
        "updated_at": STAMP,
    }


def fixtures():
    builds = [
        {
            "application": name,
            "image_digest": "sha256:" + "c" * 64,
            "artifact": {
                "id": index,
                "digest": "sha256:" + "d" * 64,
                "name": "runtime-" + name,
                "run_id": 10,
                "record_sha256": "e" * 64,
            },
        }
        for index, name in enumerate([e.PRODUCT + "-backend", e.PRODUCT + "-frontend"])
    ]
    checks = {
        name: "PASS"
        for name in [
            "deployed_commit",
            "backend_readiness",
            "frontend_availability",
            "authentication",
            "database_connectivity",
            "critical_workflows",
            "user_data_isolation",
            "storage_integrations",
            "streaming",
            "inference",
            "embeddings",
        ]
    }
    stage = {
        "repository": e.REPOSITORY,
        "candidate_commit": SHA,
        "source_sha256": FINGERPRINT,
        "environment": "Staging",
        "builds_sha256": e.digest(builds),
        "verified_at": STAMP,
        "checks": checks,
        "status": "PASS",
        "render_deployment_id": "dep-test",
        "vercel_deployment_id": "dpl_test",
    }
    stage_origin = {
        "run_id": 20,
        "id": 200,
        "digest": "sha256:" + "f" * 64,
        "name": "staging-verification",
        "record_sha256": e.digest(stage),
    }
    evidence = {
        "schema_version": 1,
        "repository": e.REPOSITORY,
        "workflow_run_id": 30,
        "candidate_commit": SHA,
        "reviewed_commit": SHA,
        "valid_for_source_sha256": FINGERPRINT,
        "content_version": FINGERPRINT,
        "verification_timestamp": STAMP,
        "CODE_VERIFIED": "PASS",
        "STAGING_VERIFIED": "PASS",
        "OPERATIONS_VERIFIED": "BLOCKED",
        "CONTENT_LEGAL_APPROVED": "BLOCKED",
        "builds": builds,
        "staging": {"record": stage, "artifact": stage_origin},
    }
    origin = {
        "run_id": 30,
        "id": 300,
        "digest": "sha256:" + "f" * 64,
        "name": "release-qualification",
        "record_sha256": e.digest(evidence),
    }
    approval = {
        "schema_version": 1,
        "repository": e.REPOSITORY,
        "candidate_commit": SHA,
        "source_sha256": FINGERPRINT,
        "target_environment": "Production",
        "content_version": FINGERPRINT,
        "builds_sha256": e.digest(builds),
        "qualification": origin,
        "evidence_sha256": e.digest(evidence),
        "decision": "approve",
        "operations_review": "approved",
        "legal_review": "approved",
        "review_url": "https://github.com/" + e.REPOSITORY + "/issues/1",
        "approver": e.OWNER,
        "approved_at": STAMP,
        "workflow_run_id": 40,
    }
    manifest = {
        "repository": e.REPOSITORY,
        "candidate_commit": SHA,
        "workflow_run_id": 50,
        "target_environment": "Production",
        "source_sha256": FINGERPRINT,
        "build_sha256": "1" * 64,
        "encrypted_sha256": "2" * 64,
    }
    build_origin = {
        "run_id": 50,
        "id": 500,
        "digest": "sha256:" + "3" * 64,
        "name": "production-build-manifest",
        "record_sha256": e.digest(manifest),
    }
    bundle_origin = {
        "run_id": 50,
        "id": 501,
        "digest": "sha256:" + "4" * 64,
        "name": "production-build-encrypted",
        "record_sha256": manifest["encrypted_sha256"],
    }
    evidence["frontend_build"] = {
        "manifest": manifest,
        "artifact": build_origin,
        "bundle_artifact": bundle_origin,
    }
    origin["record_sha256"] = e.digest(evidence)
    approval["evidence_sha256"] = e.digest(evidence)
    return evidence, origin, approval


class GateTests(unittest.TestCase):
    def setUp(self):
        self.evidence, self.origin, self.approval = fixtures()
        self.run = run(40, "release-review.yml")

    def validate(self):
        e.validate_approval(
            self.approval, self.evidence, self.origin, self.run, SHA, now=NOW
        )

    def test_registered_staging_entrypoint_keeps_commit_branch_event_and_owner_guards(self):
        stage = run(11, "deploy.yml", branch="staging")
        e.trusted_staging_run(None, stage, SHA)
        for key, value in [("head_branch", "main"), ("head_branch", "dev"),
                           ("head_sha", "f" * 40), ("event", "workflow_run"),
                           ("path", ".github/workflows/repair-hosting.yml")]:
            rejected = dict(stage, **{key: value})
            with self.subTest(key=key, value=value), self.assertRaises(e.Rejected):
                e.trusted_staging_run(None, rejected, SHA)
        foreign = copy.deepcopy(stage)
        foreign["actor"]["login"] = "unapproved-operator"
        with self.assertRaises(e.Rejected):
            e.trusted_staging_run(None, foreign, SHA)

    def test_exact_approval_accepted_only_with_explicit_human_reviews(self):
        self.validate()
        self.assertEqual(self.evidence["CONTENT_LEGAL_APPROVED"], "BLOCKED")

    def test_negative_approval_fields(self):
        for key, bad in [
            ("candidate_commit", "f" * 40),
            ("source_sha256", "0" * 64),
            ("evidence_sha256", "0" * 64),
            ("builds_sha256", "0" * 64),
            ("content_version", "old"),
            ("repository", "attacker/repo"),
            ("target_environment", "Preview"),
            ("approver", "attacker"),
            ("operations_review", "blocked"),
            ("legal_review", "blocked"),
            ("decision", "revoke"),
            ("workflow_run_id", 99),
            ("approved_at", (NOW - timedelta(days=2)).isoformat()),
        ]:
            with self.subTest(key=key):
                original = self.approval[key]
                self.approval[key] = bad
                with self.assertRaises(e.Rejected):
                    self.validate()
                self.approval[key] = original

    def test_evidence_altered_after_approval(self):
        self.evidence["CODE_VERIFIED"] = "FAIL"
        with self.assertRaises(e.Rejected):
            self.validate()

    def test_stage_missing_failed_foreign_stale_build(self):
        original = self.evidence["staging"]["record"]
        for key, bad in [
            ("candidate_commit", "d" * 40),
            ("source_sha256", "0" * 64),
            ("builds_sha256", "0" * 64),
            ("verified_at", (NOW - timedelta(days=2)).isoformat()),
            ("vercel_deployment_id", None),
        ]:
            with self.subTest(key=key):
                stage = dict(original, **{key: bad})
                with self.assertRaises(e.Rejected):
                    e.verify_stage(
                        stage, SHA, FINGERPRINT, self.evidence["builds"], now=NOW
                    )
        for name in original["checks"]:
            stage = copy.deepcopy(original)
            stage["checks"][name] = "FAIL"
            if (
                name in {"streaming", "inference", "embeddings"}
                and e.PRODUCT != "onesa-ai-platform"
            ):
                continue
            with self.subTest(check=name), self.assertRaises(e.Rejected):
                e.verify_stage(
                    stage, SHA, FINGERPRINT, self.evidence["builds"], now=NOW
                )
        stage = copy.deepcopy(original)
        del stage["checks"]["authentication"]
        with self.assertRaises(e.Rejected):
            e.verify_stage(stage, SHA, FINGERPRINT, self.evidence["builds"], now=NOW)

    def test_untrusted_origin_rejected(self):
        for key, bad in [
            ("head_sha", "d" * 40),
            ("head_branch", "feature/attacker"),
            ("path", ".github/workflows/untrusted.yml"),
            ("event", "pull_request"),
            ("run_attempt", 2),
            ("conclusion", "failure"),
            ("actor", {"login": "attacker"}),
            ("head_repository", {"full_name": "attacker/repo"}),
        ]:
            with self.subTest(key=key), self.assertRaises(e.Rejected):
                e.trusted_run(
                    dict(self.run, **{key: bad}), "release-review.yml", SHA, {"main"}
                )

    def test_zip_integrity_and_no_extraction(self):
        def archive(name, data):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as bundle:
                bundle.writestr(name, json.dumps(data))
            return buffer.getvalue()

        data = archive("record.json", self.evidence)
        self.assertEqual(
            e.decode_artifact(data, "sha256:" + hashlib.sha256(data).hexdigest()),
            self.evidence,
        )
        with self.assertRaises(e.Rejected):
            e.decode_artifact(data, "sha256:" + "0" * 64)
        data = archive("../../script.py", self.evidence)
        with self.assertRaises(e.Rejected):
            e.decode_artifact(data, "sha256:" + hashlib.sha256(data).hexdigest())

    def test_ci_failure_missing_security_not_pass(self):
        class API:
            def runs(self, workflow, sha):
                return [run(10, workflow, event="push")]

            def jobs(self, workflow):
                names = (
                    e.POLICY["jobs"]
                    if workflow["path"].endswith(e.POLICY["ci"])
                    else ["publication-hygiene"]
                )
                return [
                    {
                        "name": name,
                        "conclusion": "failure" if name == names[0] else "success",
                        "html_url": "https://github.com/synthetic",
                        "steps": [],
                    }
                    for name in names
                ]

        status, _ = e.checked_ci(API(), SHA)
        self.assertEqual(status, "FAIL")

        class Missing(API):
            def jobs(self, workflow):
                return []

        status, _ = e.checked_ci(Missing(), SHA)
        self.assertEqual(status, "BLOCKED")

    def test_source_hash_is_legacy_algorithm(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        spec = e.importlib.util.spec_from_file_location(
            "original", e.ROOT / "scripts/release/qualify.py"
        )
        module = e.importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(e.source_hash(), module.source_hash())

    def test_freshness_expired_and_future(self):
        self.assertTrue(e.fresh(STAMP, NOW))
        self.assertFalse(e.fresh(STAMP, NOW + timedelta(days=1)))
        self.assertFalse(e.fresh(STAMP, NOW - timedelta(seconds=1)))

    def test_protection_cannot_be_assumed(self):
        github = e.GitHub()
        with (
            patch.object(
                github, "api", return_value={"protected": False, "commit": {"sha": SHA}}
            ),
            self.assertRaises(e.Rejected),
        ):
            github.protected_main(SHA)

    def test_security_blocker_and_artifact_mismatch(self):
        class API:
            def run(self, identifier):
                return run(identifier, e.POLICY["ci"], event="push")

            def artifact(self, workflow, name):
                return {
                    "repository": e.REPOSITORY,
                    "candidate_commit": SHA,
                    "image_digest": "sha256:" + "c" * 64,
                    "security": "FAIL",
                }, {}

        with self.assertRaises(e.Rejected):
            e.artifacts_for_ci(API(), [{"workflow": e.POLICY["ci"], "run_id": 10}])

    def test_superseded_or_pending_approval_rejects(self):
        class API:
            def protected_main(self, sha):
                pass

            def runs(self, workflow, sha):
                return [run(41, workflow), run(40, workflow)]

        with self.assertRaises(e.Rejected):
            e.promote(API(), SHA, 40)

    def test_hosted_staging_unavailable_rejects(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        import hosted

        record = self.evidence["staging"]["record"]
        record.update(
            {
                "render_service_id": hosted.STAGING_SERVICES[e.PRODUCT],
                "backend_origin": hosted.BACKEND_ORIGINS[e.PRODUCT],
                "frontend_origin": "https://synthetic.vercel.app",
            }
        )
        with (
            patch.object(hosted, "render", side_effect=e.Rejected("Unavailable")),
            patch.object(hosted, "verify_stage", return_value="PASS"),
            self.assertRaises(e.Rejected),
        ):
            hosted.recheck(self.evidence)

    def test_reviewed_build_encryption_roundtrip_and_tampering(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        import os
        import subprocess

        script = e.ROOT / "scripts/release/bundle.mjs"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / ".vercel/output").mkdir(parents=True)
            (directory / ".vercel/output/config.json").write_text('{"version":3}')
            env = {
                **os.environ,
                "RELEASE_BUILD_KEY": "1" * 64,
                "GITHUB_SHA": SHA,
                "GITHUB_REPOSITORY": e.REPOSITORY,
                "GITHUB_RUN_ID": "50",
            }
            packed = subprocess.run(
                ["node", str(script), "pack", "bundle"],
                cwd=directory,
                env=env,
                capture_output=True,
                check=False,
            )
            self.assertEqual(
                packed.returncode, 0, "Synthetic Vercel bundle should encrypt"
            )
            blob = (directory / "bundle/bundle.enc").read_bytes()
            self.assertNotIn(b'"version":3', blob)
            (directory / ".vercel/output/config.json").unlink()
            restored = subprocess.run(
                ["node", str(script), "unpack", "bundle"],
                cwd=directory,
                env=env,
                capture_output=True,
                check=False,
            )
            self.assertEqual(restored.returncode, 0)
            self.assertEqual(
                (directory / ".vercel/output/config.json").read_text(), '{"version":3}'
            )
            for changed in [{"RELEASE_BUILD_KEY": "2" * 64}, {"GITHUB_SHA": "f" * 40}]:
                rejected = subprocess.run(
                    ["node", str(script), "unpack", "bundle"],
                    cwd=directory,
                    env={**env, **changed},
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(rejected.returncode, 0)
            (directory / "bundle/bundle.enc").write_bytes(
                blob[:-1] + bytes([blob[-1] ^ 1])
            )
            rejected = subprocess.run(
                ["node", str(script), "unpack", "bundle"],
                cwd=directory,
                env=env,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)

    def test_generator_never_issues_human_or_hardware_approval(self):
        class API:
            def runs(self, workflow, sha):
                return []

        with patch.object(e, "source_hash", return_value=FINGERPRINT):
            record = e.generate(API(), SHA, run(30, "release-qualification.yml"))
        self.assertEqual(record["CODE_VERIFIED"], "BLOCKED")
        self.assertEqual(record["STAGING_VERIFIED"], "BLOCKED")
        self.assertEqual(record["OPERATIONS_VERIFIED"], "BLOCKED")
        self.assertEqual(record["CONTENT_LEGAL_APPROVED"], "BLOCKED")
        if e.PRODUCT == "onesa-ai-robot":
            self.assertEqual(record["ROS2_VERIFIED"], "NOT TESTED")
            self.assertEqual(record["PHYSICAL_HARDWARE_READY"], "BLOCKED")

    def test_missing_synthetic_credentials_remain_blocked(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        import hosted_suite

        with patch.dict("os.environ", {"GITHUB_SHA": SHA}, clear=True):
            record = hosted_suite.run_suite("https://synthetic.vercel.app")
        self.assertEqual(record["status"], "BLOCKED")
        self.assertNotIn("PASS", record["checks"].values())

    def test_synthetic_suite_failure_cannot_pass(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        import hosted_suite

        users = [
            {"email": "first@example.com", "password": "synthetic-only"},
            {"email": "second@example.com", "password": "synthetic-only"},
        ]
        config = {
            "scope": "approved-synthetic-staging",
            "project_id": "prj_synthetic",
            "users": users,
        }

        class Unavailable:
            def __init__(self, origin):
                pass

            def login(self, user):
                raise e.Rejected("Synthetic service unavailable")

        with (
            patch.dict(
                "os.environ",
                {
                    "GITHUB_SHA": SHA,
                    "VERCEL_PROJECT_ID": "prj_synthetic",
                    "STAGING_FIXTURES_JSON": json.dumps(config),
                },
                clear=True,
            ),
            patch.object(hosted_suite, "Session", Unavailable),
        ):
            record = hosted_suite.run_suite("https://synthetic.vercel.app")
        self.assertEqual(record["status"], "FAIL")
        self.assertEqual(record["checks"]["authentication"], "FAIL")
        self.assertEqual(record["checks"]["storage_integrations"], "BLOCKED")

    def test_foreign_fixture_project_rejected_before_login(self):
        if e.PRODUCT == "onesa-ai-robot":
            return
        import hosted_suite

        config = {
            "scope": "approved-synthetic-staging",
            "project_id": "prj_foreign",
            "users": [],
        }
        with (
            patch.dict(
                "os.environ",
                {
                    "GITHUB_SHA": SHA,
                    "VERCEL_PROJECT_ID": "prj_synthetic",
                    "STAGING_FIXTURES_JSON": json.dumps(config),
                },
                clear=True,
            ),
            self.assertRaises(e.Rejected),
        ):
            hosted_suite.run_suite("https://synthetic.vercel.app")

    def test_production_metrics_require_observed_signals_and_no_server_errors(self):
        if e.PRODUCT == "onesa-ai-robot":
            self.skipTest("Robot has no production promotion")
        import hosted

        key = "METRICS_TOKEN" if e.PRODUCT.endswith("portal") else "ONESA_METRICS_TOKEN"
        prefix = (
            "onesa_portal_http_requests_total"
            if e.PRODUCT.endswith("portal")
            else "onesa_http_requests_total"
        )
        good = (prefix + '{status="200"} 2\n').encode()
        with (
            patch.dict("os.environ", {"RENDER_API_KEY": "synthetic-only"}, clear=True),
            patch.object(
                hosted,
                "provider",
                return_value=[
                    {"envVar": {"key": key, "value": "synthetic-metrics-token"}}
                ],
            ),
            patch.object(hosted, "request", return_value=(200, good)),
        ):
            observed = hosted.production_metrics(
                "https://synthetic.onrender.com", "srv-synthetic"
            )
        self.assertEqual(observed["application_errors"], "PASS")
        self.assertEqual(observed["monitoring_signals"], "PASS")
        bad = good + (prefix + '{status="500"} 1\n').encode()
        with (
            patch.dict("os.environ", {"RENDER_API_KEY": "synthetic-only"}, clear=True),
            patch.object(
                hosted,
                "provider",
                return_value=[
                    {"envVar": {"key": key, "value": "synthetic-metrics-token"}}
                ],
            ),
            patch.object(hosted, "request", return_value=(200, bad)),
        ):
            observed = hosted.production_metrics(
                "https://synthetic.onrender.com", "srv-synthetic"
            )
        self.assertEqual(observed["application_errors"], "FAIL")
        with (
            patch.dict("os.environ", {"RENDER_API_KEY": "synthetic-only"}, clear=True),
            patch.object(hosted, "provider", return_value=[]),
        ):
            observed = hosted.production_metrics(
                "https://synthetic.onrender.com", "srv-synthetic"
            )
        self.assertEqual(observed["monitoring_signals"], "BLOCKED")

    def test_missing_production_fixture_never_passes_smoke(self):
        if e.PRODUCT == "onesa-ai-robot":
            self.skipTest("Robot has no production promotion")
        import hosted_suite

        with patch.dict("os.environ", {}, clear=True):
            observed = hosted_suite.production_probes("https://synthetic.vercel.app")
        self.assertNotIn("PASS", observed.values())

    def test_illustrative_dry_run_end_to_end(self):
        # Fixed synthetic timestamps/checks: this records software behavior, not hosted acceptance.
        class API:
            def protected_main(self, sha):
                e.require(sha == SHA, "Wrong main")

            def runs(self, workflow, sha):
                return [run(40, workflow)]

            def run(self, identifier):
                if identifier == 50:
                    return run(50, "release-build.yml")
                return run(
                    identifier,
                    "release-qualification.yml"
                    if identifier == 30
                    else "release-staging.yml",
                    branch="main" if identifier == 30 else e.POLICY["staging_branch"],
                )

            def artifact(inner, workflow, name, **kwargs):
                if name == "production-build-manifest":
                    return self.evidence["frontend_build"]["manifest"], self.evidence[
                        "frontend_build"
                    ]["artifact"]
                if name == "production-build-encrypted":
                    return b"synthetic-ciphertext", self.evidence["frontend_build"][
                        "bundle_artifact"
                    ]
                if name == "release-approval":
                    return self.approval, {}
                if name == "release-qualification":
                    return self.evidence, self.origin
                return self.evidence["staging"]["record"], self.evidence["staging"][
                    "artifact"
                ]

            def api(self, path):
                return {"state": "open", "user": {"login": e.OWNER}}

        if e.PRODUCT == "onesa-ai-robot":
            return
        with (
            patch.object(e, "source_hash", return_value=FINGERPRINT),
            patch.object(e, "fresh", return_value=True),
            patch.object(e, "checked_ci", return_value=("PASS", [])),
            patch.object(e, "artifacts_for_ci", return_value=self.evidence["builds"]),
        ):
            approved = e.promote(API(), SHA, 40)
        self.assertEqual(approved["qualification_status"], "APPROVED")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.json"
            e.save(approved, path)
            self.assertEqual(
                json.loads(path.read_text())["approval_provenance"]["approver"], e.OWNER
            )


if __name__ == "__main__":
    unittest.main()
