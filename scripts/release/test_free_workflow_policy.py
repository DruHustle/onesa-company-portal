"""Regression checks for credentials and triggers at the private-Free boundary."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class WorkflowBoundaryTests(unittest.TestCase):
    def test_free_workflows_are_manual_and_credential_free(self):
        for name in ("free-qualification.yml", "free-authorization.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn("workflow_dispatch:", text)
            self.assertNotRegex(
                text, r"(?m)^  (push|pull_request|pull_request_target|workflow_run):"
            )
            self.assertNotRegex(text, r"\$\{\{\s*secrets\.")
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
        self.assertNotIn("environment: Staging", text)

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
