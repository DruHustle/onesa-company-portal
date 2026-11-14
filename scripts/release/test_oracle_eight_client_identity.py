"""The eight-client issuer qualifies the existing customer schema independently."""
import copy
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

import oracle_install as installer
import oracle_portal as runtime
import oracle_portal_identity as identity
import test_oracle_install as install_tests
import test_oracle_portal_identity as legacy
import test_oracle_seven_client_identity as seven


def inputs():
    binding, plan = seven.seven_inputs()
    plan["qualification_profile"] = identity.PROFILE_V3
    plan["environments"]["staging"]["origins"]["factory"] = "https://factory-staging.onesa.eu"
    plan["environments"]["production"]["origins"]["factory"] = "https://factory.onesa.eu"
    legacy.seal(binding, plan)
    return binding, plan


def registry():
    old = seven.registration(identity.PRODUCTION_ORIGINS)
    new = copy.deepcopy(old)
    new["clients"].append({
        "product": "factory", "clientId": "synthetic_client_factory",
        "clientSecret": "synthetic-fixture-only-" * 3 + "factory",
        "applicationUrl": "https://factory.onesa.eu/",
        "redirectUri": "https://factory.onesa.eu/api/auth/onesa/callback",
    })
    return old, new


class Issuer(unittest.TestCase):
    def test_issuer_receipt_cannot_certify_product_sessions(self):
        binding, plan = inputs()
        self.assertIn("portal_mfa_administrator", identity.hosted_checks(plan, "account"))
        with self.assertRaisesRegex(runtime.Refused, "V3_ISSUER_ACCOUNT_SCOPE_ONLY"):
            identity.hosted_checks(plan, "integrated")
        with patch.object(identity, "private_bytes", side_effect=AssertionError("read private fixture")):
            with self.assertRaisesRegex(runtime.Refused, "V3_ISSUER_ACCOUNT_SCOPE_ONLY"):
                identity.hosted(binding, plan, "staging", "unused", Path("/unused"), scope="integrated")

    def test_schema_and_plan_stay_separate(self):
        binding, plan = inputs()
        identity.validate_plan(binding, plan, identity.PROFILE_V3)
        with self.assertRaises(runtime.Refused):
            identity.validate_plan(binding, plan, identity.PROFILE_V2)
        for invalid in (None, "https://factory-foreign.example"):
            changed = copy.deepcopy(plan)
            changed["environments"]["production"]["origins"]["factory"] = invalid or "https://factory-missing.example"
            legacy.seal(binding, changed)
            with self.assertRaises(runtime.Refused):
                identity.validate_plan(binding, changed, identity.PROFILE_V3)
        self.assertEqual(runtime.canonical_install_files("identity", identity_v3=True), installer.IDENTITY_V3_ALLOWED)
        with self.assertRaises(runtime.Refused):
            runtime.canonical_install_files("identity-acceptance", identity_v3=True)

    def test_exact_factory_callback_and_unchanged_prior_registration(self):
        old, new = registry()
        values = seven.encoded(new)
        identity.validate_registration(values, identity.ORIGINS_V3, v2=True, v3=True)
        with self.assertRaises(runtime.Refused):
            identity.validate_registration(values, identity.PRODUCTION_ORIGINS, v2=True)
        selected = {"origins": identity.ORIGINS_V3, "retained_identity_file": {}}
        with patch.object(identity, "retained_identity", return_value=seven.encoded(old)):
            identity.check_retained_identity(selected, values, [seven.encoded(old)] * 2, v3=True)
            changed = copy.deepcopy(new)
            changed["cookieKeys"] = ["different"]
            with self.assertRaisesRegex(runtime.Refused, "ACTIVE_KEYS_CHANGED"):
                identity.check_retained_identity(selected, seven.encoded(changed), [seven.encoded(old)] * 2, v3=True)
        new["clients"][-1]["redirectUri"] = "https://logistics.onesa.eu/api/auth/onesa/callback"
        with self.assertRaisesRegex(runtime.Refused, "EXACT_PRODUCT_CALLBACK"):
            identity.validate_registration(seven.encoded(new), identity.ORIGINS_V3, v2=True, v3=True)

    def test_enrollment_source_and_immutable_sql(self):
        root = Path(__file__).resolve().parents[2]
        backend = root / "onesa-company-portal-backend"
        sources = [*backend.joinpath("src").rglob("*.ts"), *backend.glob("package*.json"), backend / "Dockerfile"]
        migrations = sorted(backend.glob("migrations/*.sql"))
        reviewed = [p for p in migrations if int(p.name[:3]) <= 19]
        files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in [*sources, *reviewed]}
        current = {**files, **{str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in migrations}}
        # V3 is a historical release. The managed Portal schema adds migration 020.
        self.assertIn("onesa-company-portal-backend/migrations/020_managed_portal_login.sql", current)
        with self.assertRaises(runtime.Refused):
            identity.identity_source_files(current, profile=identity.PROFILE_V3)
        self.assertEqual(identity.identity_source_files(files, profile=identity.PROFILE_V3), files)
        with self.assertRaises(runtime.Refused):
            identity.identity_source_files(files, profile=identity.PROFILE_V2)
        files["onesa-company-portal-backend/migrations/019_engineering_enrollment_accounts.sql"] = "a"*64
        with self.assertRaises(runtime.Refused):
            identity.identity_source_files(files, profile=identity.PROFILE_V3)


class EightClientInstall(install_tests.IdentityInstallTests):
    allowed = installer.IDENTITY_V3_ALLOWED
    script = "oracle_portal_identity_v3.py"
    prefix = "portal-identity-v3-"

    def test_current_authority_cannot_be_seven_client(self):
        self.validate()
        scope = "DruHustle/onesa-company-portal:identity"
        self.policy["components"][scope]["qualification_profile"] = identity.PROFILE_V2
        self.seal()
        with self.assertRaises(installer.verifier.Rejected):
            self.validate()
