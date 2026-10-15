"""Production preparation guards; synthetic unit tests are not hosted evidence."""

import unittest
from copy import deepcopy
from unittest.mock import patch

import oracle_production as production


class ProductionBindingGuards(unittest.TestCase):
    def setUp(self):
        self.service = {
            "id": production.SERVICE,
            "branch": "main",
            "autoDeployTrigger": "off",
            "repo": "https://github.com/DruHustle/onesa-company-portal",
        }
        self.values = {
            "DATABASE_URL": "postgresql://onesa_portal_app:synthetic-only@"
            + production.DATABASE_HOST
            + "/neondb?sslmode=verify-full&channel_binding=require",
            "S3_ENDPOINT": "https://" + production.BUCKET_HOST,
            "S3_BUCKET": "synthetic-bucket",
            "PUBLIC_ORIGIN": "https://company.example.invalid",
            "SESSION_KEY": "p" * 48,
            "PROXY_SHARED_KEY": "q" * 48,
            "AWS_ACCESS_KEY_ID": "synthetic-production-access",
            "AWS_SECRET_ACCESS_KEY": "synthetic-production-secret",
            "UNUSED_SETTING": "omit",
        }
        self.staging = {
            "DATABASE_URL": "postgresql://synthetic@stage.example.invalid/staging",
            "S3_ENDPOINT": "https://stage-storage.example.invalid",
        }

    def test_only_supported_production_values_are_selected(self):
        selected = production.production_values(self.service, self.values, self.staging)
        self.assertNotIn("UNUSED_SETTING", selected)
        self.assertEqual(selected["DATABASE_URL"], self.values["DATABASE_URL"])

    def test_wrong_target_owner_role_or_unverified_tls_is_rejected(self):
        for key, value in [
            (
                "DATABASE_URL",
                self.values["DATABASE_URL"].replace("onesa_portal_app", "neondb_owner"),
            ),
            (
                "DATABASE_URL",
                self.values["DATABASE_URL"].replace("verify-full", "require"),
            ),
            (
                "DATABASE_URL",
                self.values["DATABASE_URL"].replace("channel_binding=require", ""),
            ),
            (
                "DATABASE_URL",
                self.values["DATABASE_URL"].replace(
                    production.DATABASE_HOST, "stage.invalid"
                ),
            ),
            ("S3_ENDPOINT", "http://" + production.BUCKET_HOST),
            ("PUBLIC_ORIGIN", "https://company.example.invalid/path"),
            ("SESSION_KEY", ""),
            ("SESSION_KEY", "p" * 48 + "\nBAD=value"),
        ]:
            values = deepcopy(self.values)
            values[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                production.production_values(self.service, values, self.staging)

    def test_explicit_publication_stage_is_preserved_and_unknown_modes_rejected(self):
        for stage in ["prelaunch", "launch"]:
            values = {**self.values, "PUBLICATION_STAGE": stage}
            self.assertEqual(production.production_values(
                self.service, values, self.staging)["PUBLICATION_STAGE"], stage)
        with self.assertRaises(ValueError):
            production.production_values(self.service,
                                         {**self.values, "PUBLICATION_STAGE": "bypass"},
                                         self.staging)

    def test_staging_secrets_are_never_reused(self):
        for name in [
            "SESSION_KEY",
            "PROXY_SHARED_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
        ]:
            staging = {**self.staging, name: self.values[name]}
            with self.subTest(name=name), self.assertRaises(ValueError):
                production.production_values(self.service, self.values, staging)

    def test_wrong_service_branch_or_auto_deploy_never_passes(self):
        for key, value in [
            ("id", production.STAGING_SERVICE),
            ("branch", "staging"),
            ("autoDeployTrigger", "commit"),
            ("repo", "https://github.com/other/repo"),
        ]:
            service = {**self.service, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                production.production_values(service, self.values, self.staging)

    def test_incomplete_or_duplicate_provider_inventory_is_rejected(self):
        entry = {"envVar": {"key": "NAME", "value": "synthetic"}}
        for entries in [[entry, entry], [entry] * 100, {}]:
            with self.assertRaises(ValueError):
                production.inventory(entries)

    def test_failed_source_qualification_cannot_read_credentials_or_write_vm(self):
        with (
            patch.object(production.worker, "qualified_source", side_effect=ValueError),
            patch.object(production, "run") as remote,
            patch.object(production, "provider") as provider,
        ):
            with self.assertRaises(ValueError):
                production.prepare("a" * 40)
            remote.assert_not_called()
            provider.assert_not_called()

    def test_preparation_process_never_starts_service_loop_or_exposes_ports(self):
        command = production.container("a" * 40)
        self.assertIn("--read-only", command)
        self.assertIn("portal-production.env", command)
        self.assertNotIn("--publish", command)
        self.assertNotIn("dist/src/jobs/worker.js", command)

    def test_existing_production_mail_reuse_requires_identity_and_distinct_secret(self):
        service = {**self.service, "id": production.LEGACY_WORKER}
        mail = {
            "MAIL_PROVIDER": "resend",
            "RESEND_API_KEY": "re_" + "synthetic" * 5,
            "MAIL_FROM": "qualification@example.invalid",
            "UNUSED_SETTING": "omit",
        }
        selected = production.legacy_mail_profile(service, mail, self.staging)
        self.assertNotIn("UNUSED_SETTING", selected)
        for target, values, staging in [
            ({**service, "id": production.STAGING_SERVICE}, mail, self.staging),
            (service, {**mail, "RESEND_API_KEY": ""}, self.staging),
            (service, mail, {"RESEND_API_KEY": mail["RESEND_API_KEY"]}),
        ]:
            with self.assertRaises(ValueError):
                production.legacy_mail_profile(target, values, staging)


if __name__ == "__main__":
    unittest.main()
