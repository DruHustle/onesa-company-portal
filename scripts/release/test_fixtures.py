"""Private fixture validation and lifecycle boundaries use synthetic values only."""

import copy
import json
import os
import unittest
from unittest.mock import patch

from fixtures import FixtureError, decode_totp, parse_fixtures

PROJECT = "prj_synthetic"
PORTAL = "onesa-company-portal"


def fixture():
    return {
        "scope": "approved-synthetic-staging",
        "project_id": PROJECT,
        "users": [
            {
                "email": "one@example.com",
                "password": "synthetic-password-123",
                "totp_secret": "JBSWY3DPEHPK3PXP",
            },
            {
                "email": "two@example.com",
                "password": "synthetic-password-456",
                "totp_secret": "JBSWY3DPEHPK3PXP",
            },
        ],
    }


class FixtureTests(unittest.TestCase):
    def test_preview_repair_refuses_wrong_branch_and_actor_before_provider_access(self):
        import hosted

        env = {"GITHUB_REPOSITORY": hosted.REPOSITORY, "GITHUB_REF": "refs/heads/dev", "GITHUB_ACTOR": "DruHustle", "RUNNER_ENVIRONMENT": "github-hosted"}
        for key, value in [("GITHUB_REF", "refs/heads/main"), ("GITHUB_REF", "refs/heads/staging"), ("GITHUB_ACTOR", "other"), ("RUNNER_ENVIRONMENT", "self-hosted"), ("GITHUB_REPOSITORY", "other/project")]:
            with patch.dict(os.environ, {**env, key: value}, clear=True), patch.object(hosted, "preflight") as read:
                with self.assertRaises(ValueError): hosted.configure_staging_preview()
                read.assert_not_called()

    def test_preview_repair_changes_only_staging_branch_server_bindings(self):
        import hosted
        from unittest.mock import MagicMock

        marker = "synthetic-stage-private-key-" + "x" * 32
        env = {"GITHUB_REPOSITORY": hosted.REPOSITORY, "GITHUB_REF": "refs/heads/dev", "GITHUB_ACTOR": "DruHustle", "RUNNER_ENVIRONMENT": "github-hosted", "VERCEL_PROJECT_ID": PROJECT, "VERCEL_ORG_ID": "team_synthetic", "VERCEL_TOKEN": "synthetic-token"}
        production = {"key": "BACKEND_URL", "target": ["production"], "value": "private-production-binding"}
        after = {"envs": [production, {"key": "BACKEND_URL", "target": ["preview"], "gitBranch": "staging", "value": hosted.BACKEND_ORIGINS[PORTAL]}, {"key": "PROXY_SHARED_KEY", "target": ["preview"], "gitBranch": "staging", "value": marker}]}
        response = MagicMock();response.__enter__.return_value.status = 200
        opener = MagicMock();opener.open.return_value = response
        with patch.dict(os.environ, env, clear=True), patch.object(hosted, "preflight", return_value={"settings": {"PROXY_SHARED_KEY": marker}}), patch.object(hosted, "provider", side_effect=[{"envs": [production]}, after]), patch.object(hosted.urllib.request, "build_opener", return_value=opener):
            hosted.configure_staging_preview()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        payload = json.loads(request.data)
        self.assertEqual({item["key"] for item in payload}, {"BACKEND_URL", "PROXY_SHARED_KEY"})
        self.assertTrue(all(item["target"] == ["preview"] and item["gitBranch"] == "staging" for item in payload))
        self.assertNotIn("private-production-binding", request.data.decode())

    def test_valid_credentials_and_unpadded_totp(self):
        self.assertEqual(
            parse_fixtures(json.dumps(fixture()), PROJECT, PORTAL), fixture()
        )
        self.assertEqual(decode_totp("JBSWY3DPEHPK3PXP"), b"Hello!\xde\xad\xbe\xef")
        self.assertEqual(
            decode_totp("jbswy3dpehpk3pxp"), decode_totp("JBSWY3DPEHPK3PXP")
        )

    def test_wrong_scope_project_product_and_non_synthetic_accounts_reject(self):
        for field, value in [
            ("scope", "approved-synthetic-production"),
            ("project_id", "prj_other"),
        ]:
            data = fixture()
            data[field] = value
            with self.assertRaisesRegex(FixtureError, "FIXTURE_BINDING"):
                parse_fixtures(json.dumps(data), PROJECT, PORTAL)
        with self.assertRaisesRegex(FixtureError, "FIXTURE_PRODUCT"):
            parse_fixtures(json.dumps(fixture()), PROJECT, "other")
        for email in [
            "customer@company.invalid",
            "https://one@example.com",
            "one@example.com.evil",
            " one@example.com",
        ]:
            data = fixture()
            data["users"][0]["email"] = email
            with self.assertRaisesRegex(FixtureError, "FIXTURE_EMAIL"):
                parse_fixtures(json.dumps(data), PROJECT, PORTAL)

    def test_missing_password_and_mfa_fields_fail_without_exposing_values(self):
        for field, expected in [
            ("password", "FIXTURE_PASSWORD"),
            ("totp_secret", "FIXTURE_TOTP"),
        ]:
            for bad in [None, 42, "private-value-not-to-be-printed", ""]:
                data = fixture()
                data["users"][0][field] = bad
                if field == "password" and isinstance(bad, str) and len(bad) >= 14:
                    data["users"][0][field] = "short"
                with self.assertRaises(FixtureError) as caught:
                    parse_fixtures(json.dumps(data), PROJECT, PORTAL)
                self.assertEqual(str(caught.exception), expected)
                self.assertNotIn("private-value", str(caught.exception))

    def test_malformed_and_oversized_input_and_duplicate_emails_reject(self):
        for value in [None, "", "[]", "null", "{private", "x" * 20000]:
            with self.assertRaises(FixtureError):
                parse_fixtures(value, PROJECT, PORTAL)
        data = fixture()
        data["users"][1]["email"] = "ONE@example.com"
        with self.assertRaisesRegex(FixtureError, "FIXTURE_USERS"):
            parse_fixtures(json.dumps(data), PROJECT, PORTAL)

    def test_temporary_mode_still_requires_owner_scope_project_and_distinct_synthetic_names(
        self,
    ):
        data = fixture()
        del data["users"][0]["password"]
        del data["users"][0]["totp_secret"]
        parse_fixtures(json.dumps(data), PROJECT, PORTAL, credentials=False)
        data["scope"] = "production"
        with self.assertRaises(FixtureError):
            parse_fixtures(json.dumps(data), PROJECT, PORTAL, credentials=False)

    def test_lifecycle_context_rejects_main_dev_foreign_actor_and_local_before_provider_access(
        self,
    ):
        import fixture_lifecycle as lifecycle

        env = {
            "GITHUB_REPOSITORY": lifecycle.REPOSITORY,
            "GITHUB_REF": "refs/heads/staging",
            "GITHUB_ACTOR": "DruHustle",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "GITHUB_RUN_ID": "123",
            "STAGING_FIXTURE_MODE": "temporary",
        }
        for key, value in [
            ("GITHUB_REF", "refs/heads/main"),
            ("GITHUB_REF", "refs/heads/dev"),
            ("GITHUB_ACTOR", "other"),
            ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("GITHUB_RUN_ID", "not-a-run"),
            ("STAGING_FIXTURE_MODE", "provided"),
        ]:
            with (
                patch.dict(os.environ, {**env, key: value}, clear=True),
                patch.object(lifecycle, "preflight") as provider,
            ):
                with self.assertRaises(ValueError):
                    lifecycle.context()
                provider.assert_not_called()

    def test_cleanup_ownership_rejects_foreign_run_source_and_real_users(self):
        import fixture_lifecycle as lifecycle

        data = {
            "run_id": "123",
            "candidate_commit": "a" * 40,
            "users": [
                {
                    "id": "b" * 8 + "-" + "b" * 27,
                    "email": "release-audit-123-" + "b" * 24 + "@example.com",
                },
                {
                    "id": "c" * 8 + "-" + "c" * 27,
                    "email": "release-audit-123-" + "c" * 24 + "@example.com",
                },
            ],
        }
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_SHA": "a" * 40}):
            lifecycle.validate_owned(data)
            for key, value in [("run_id", "999"), ("candidate_commit", "d" * 40)]:
                changed = copy.deepcopy(data)
                changed[key] = value
                with self.assertRaises(ValueError):
                    lifecycle.validate_owned(changed)
            changed = copy.deepcopy(data)
            changed["users"][0]["email"] = "real-user@example.com"
            with self.assertRaises(ValueError):
                lifecycle.validate_owned(changed)

    def test_safe_http_diagnostics_allow_only_known_auth_reason_codes(self):
        import hosted_suite

        for body, expected in [
            (b'{"error":{"code":"CREDENTIALS"}}', "FIXTURE_CREDENTIALS_REJECTED"),
            (b'{"error":{"code":"MFA"}}', "FIXTURE_MFA_REJECTED"),
            (b'{"error":{"code":"private-value"}}', "HTTP_401"),
            (b"private-response-body", "HTTP_401"),
        ]:
            error = hosted_suite.HostedRequestFailure(401, "/api/v1/auth/login", body)
            self.assertEqual(hosted_suite.safe_suite_failure_code(error), expected)
            self.assertEqual(error.phase, "login")
            self.assertNotIn("private", str(error))
