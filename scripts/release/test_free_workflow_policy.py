"""Regression checks for credentials and triggers at the private-Free boundary."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class WorkflowBoundaryTests(unittest.TestCase):
    def test_free_workflows_are_credential_free_and_authorization_is_manual(self):
        for name in ("free-qualification.yml", "free-authorization.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn("workflow_dispatch:", text)
            self.assertNotRegex(
                text, r"(?m)^  (push|pull_request|pull_request_target):"
            )
            self.assertNotRegex(text, r"\$\{\{\s*secrets\.")
            if name == "free-authorization.yml":
                self.assertNotIn("workflow_run:", text)
            self.assertNotIn("environment:", text)
            self.assertIn("github.triggering_actor", text)
            self.assertIn("persist-credentials: false", text)

    def test_private_production_jobs_are_disabled_and_json_fallback_removed(self):
        text = (ROOT / ".github/workflows/deploy.yml").read_text()
        self.assertNotIn("RELEASE_QUALIFICATION_JSON", text)
        self.assertNotIn("inputs.approval_run == ''", text)
        self.assertNotRegex(text, r"(?m)^  (push|pull_request|workflow_run):")
        job_conditions = re.findall(r"^    if: (.+)", text, re.MULTILINE)
        self.assertTrue(job_conditions)
        self.assertTrue(
            all(
                "github.event.repository.private == false" in value
                for value in job_conditions
            )
        )

    def test_staging_uses_separate_credentials(self):
        text = (ROOT / ".github/workflows/release-staging.yml").read_text()
        self.assertIn("secrets.STAGING_RENDER_API_KEY", text)
        self.assertIn("secrets.STAGING_VERCEL_TOKEN", text)
        self.assertNotRegex(
            text,
            r"secrets\.(RENDER_API_KEY|VERCEL_TOKEN|VERCEL_PROJECT_ID|VERCEL_AUTOMATION_BYPASS_SECRET)\b",
        )
        self.assertIn("environment: Staging", text)
        # Secret scope is useful without assuming private-Free reviewer enforcement.
        self.assertNotIn("secrets.VERCEL_PROJECT_ID", text)

    def test_git_previews_do_not_enable_native_production_deployment(self):
        config = json.loads(
            (ROOT / (ROOT.name + "-frontend") / "vercel.json").read_text()
        )
        self.assertEqual(
            config["git"]["deploymentEnabled"],
            {
                "main": False,
                "dev": False,
                "staging": True,
            },
        )

    def test_automatic_staging_is_opt_in_owner_main_only_and_preflights_first(self):
        text = (ROOT / ".github/workflows/release-staging.yml").read_text()
        for constraint in (
            "vars.STAGING_AUTOMATION_ENABLED == 'true'",
            "github.event.repository.private == true",
            "github.event.workflow_run.event",
            "== 'push'",
            "head_repository.full_name",
            "head_sha == github.sha",
            "conclusion ==",
            "github.triggering_actor == 'DruHustle'",
        ):
            self.assertIn(constraint, " ".join(text.split()))
        self.assertLess(
            text.index("scripts/release/evidence.py stage-preflight"),
            text.index("secrets.STAGING_"),
        )
        self.assertNotIn("pull_request_target", text)
        self.assertIn("cancel-in-progress: false", text)

    def test_pr_validation_has_no_local_runner_dependency_or_provider_secrets(self):
        ci = {
            "onesa-company-portal": "verify.yml",
            "onesa-ai-platform": "ci.yml",
            "onesa-ai-robot": "scaffold.yml",
        }[ROOT.name]
        for name in (ci, "repository-hygiene.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            self.assertNotIn("local-validation", text)
            self.assertNotIn("self-hosted", text)
            self.assertNotRegex(text, r"\$\{\{\s*secrets\.")
            self.assertIn("pull_request:", text)
            self.assertRegex(text, r"pull_request:\n    branches:\n    - main")


if __name__ == "__main__":
    unittest.main()
