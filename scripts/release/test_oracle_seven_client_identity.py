"""The seven-client issuer has separate installation, custody and acceptance boundaries."""
import base64
import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import oracle_install as installer
import oracle_portal as runtime
import oracle_portal_identity as identity
import test_oracle_install as install_tests
import test_oracle_portal_identity as legacy


def seven_inputs():
    binding, plan = legacy.inputs()
    plan["qualification_profile"] = identity.PROFILE_V2
    for env, selected in plan["environments"].items():
        selected["origins"] = (dict(identity.PRODUCTION_ORIGINS) if env == "production" else
                               {key: "https://onesa-" + key + "-stage.vercel.app"
                                for key in identity.PRODUCTION_ORIGINS})
        selected["retained_identity_file"] = None
    legacy.seal(binding, plan)
    return binding, plan


def registration(origins):
    return {
        "issuer": origins["portal"] + "/api/v1/identity",
        "clients": [{
            "product": p, "clientId": "synthetic_client_" + p,
            "clientSecret": "synthetic-fixture-only-" * 3 + p,
            "applicationUrl": origins[p] + ("/account" if p == "mobile" else "/"),
            "redirectUri": origins[p] + callback,
        } for p, callback in identity.CALLBACKS.items()],
        "jwks": {"keys": [{"kty": "RSA", "kid": "synthetic", "n": "synthetic-public-modulus", "e": "AQAB"}]},
        "cookieKeys": ["synthetic-cookie-key"],
    }


def encoded(record):
    return {"ONESA_IDENTITY_ENABLED": "true",
            "ONESA_IDENTITY_CONFIG_B64": base64.b64encode(json.dumps(record).encode()).decode()}


class SevenClientTests(unittest.TestCase):
    def test_distinct_profile_plan_and_016_boundary(self):
        binding, plan = seven_inputs()
        identity.validate_plan(binding, plan, identity.PROFILE_V2)
        with self.assertRaises(runtime.Refused):
            identity.validate_plan(binding, plan)
        b1, old = legacy.inputs()
        with self.assertRaises(runtime.Refused):
            identity.validate_plan(b1, old, identity.PROFILE_V2)
        for mutate in [
            lambda p: p["environments"]["production"]["origins"].pop("mobile"),
            lambda p: p["environments"]["production"]["origins"].update(factory="https://factory.onesa.eu"),
            lambda p: p["environments"]["production"]["origins"].update(pasofi="https://another.example"),
            lambda p: p["environments"]["staging"]["origins"].update(mobile=identity.PRODUCTION_ORIGINS["mobile"]),
            lambda p: p["environments"]["staging"]["origins"].update(mobile="https://*.example"),
            lambda p: p["environments"]["production"].update(retained_identity_file=legacy.pin("/tmp/untrusted")),
        ]:
            changed = copy.deepcopy(plan)
            mutate(changed)
            legacy.seal(binding, changed)
            with self.assertRaises(runtime.Refused):
                identity.validate_plan(binding, changed, identity.PROFILE_V2)
        self.assertEqual(sorted(identity.MIGRATIONS)[-1], "016_engineering_account_links.sql")
        self.assertEqual(set(installer.IDENTITY_V2_ALLOWED) - set(installer.IDENTITY_ALLOWED), {
            "runners/oracle_portal_identity_v2.py", "runners/oracle_portal_identity_acceptance_v2.py",
            "runners/oracle_portal_identity_browser_v2.mjs"})
        self.assertEqual(runtime.canonical_install_files("identity", identity_v2=True), installer.IDENTITY_V2_ALLOWED)
        self.assertEqual(runtime.canonical_install_files("identity"), installer.IDENTITY_ALLOWED)

    def test_exact_product_callback_and_preserved_non_root_launcher(self):
        origins = identity.PRODUCTION_ORIGINS
        valid = registration(origins)
        self.assertEqual(identity.validate_registration(encoded(valid), origins, v2=True), valid)
        for mutate in [
            lambda d: d["clients"].pop(),
            lambda d: d["clients"][-1].update(product="factory"),
            lambda d: d["clients"][-1].update(redirectUri=origins["mobile"] + "/wrong"),
            lambda d: d["clients"][-1].update(redirectUri=origins["mobile"] + identity.CALLBACKS["mobile"] + "?x=1"),
            lambda d: d["clients"][-1].update(clientId=d["clients"][0]["clientId"]),
            lambda d: d["clients"][-1].update(clientSecret=d["clients"][0]["clientSecret"]),
            lambda d: d["clients"][-1].update(applicationUrl=origins["ai"] + "/account"),
            lambda d: d.update(issuer=origins["mobile"] + "/api/v1/identity"),
            lambda d: next(c for c in d["clients"] if c["product"] == "drone").update(clientId="a" * 101),
            lambda d: next(c for c in d["clients"] if c["product"] == "mobile").update(clientSecret=" " + "z" * 64),
            lambda d: d["clients"][0].update(clientSecret="z" * 64 + "\n"),
        ]:
            changed = copy.deepcopy(valid)
            mutate(changed)
            with self.assertRaises(runtime.Refused):
                identity.validate_registration(encoded(changed), origins, v2=True)
        with self.assertRaises(runtime.Refused):
            identity.validate_registration(encoded(valid), origins, v2=False)

    def test_incumbent_issuer_and_every_existing_registration_are_retained(self):
        origins = identity.PRODUCTION_ORIGINS
        new = registration(origins)
        old = copy.deepcopy(new)
        old["clients"] = [c for c in old["clients"] if c["product"] in {"ai", "drone", "robot", "mobile"}]
        previous = encoded(old)
        selected = {"origins": origins, "retained_identity_file": legacy.pin("/etc/onesa/identity/retained.json")}
        with patch.object(identity, "private_bytes", return_value=json.dumps(previous).encode()):
            identity.check_retained_identity(selected, encoded(new), [previous, previous])
            for mutate in [
                lambda d: d.update(cookieKeys=["rotated-cookie"]),
                lambda d: d["jwks"]["keys"][0].update(n="rotated-signing-key"),
                lambda d: d["clients"][0].update(clientSecret="synthetic-changed-secret-" * 3),
                lambda d: d["clients"][0].update(clientId="synthetic_rotated_client"),
                lambda d: d["clients"][-1].update(applicationUrl=origins["mobile"] + "/elsewhere"),
            ]:
                changed = copy.deepcopy(new)
                mutate(changed)
                with self.assertRaises(runtime.Refused):
                    identity.check_retained_identity(selected, encoded(changed), [previous, previous])
            with self.assertRaisesRegex(runtime.Refused, "CUSTODY_CHANGED"):
                identity.check_retained_identity(selected, encoded(new), [previous, {}])
        selected["retained_identity_file"] = None
        identity.check_retained_identity(selected, encoded(new), [{}, {"ONESA_IDENTITY_ENABLED":"false"}])
        with self.assertRaisesRegex(runtime.Refused, "UNDECLARED_ACTIVE"):
            identity.check_retained_identity(selected, encoded(new), [previous, {}])

    def test_separate_stage_credentials_and_exact_observed_configuration(self):
        origins = identity.PRODUCTION_ORIGINS
        data = registration(origins)
        with self.assertRaisesRegex(runtime.Refused, "CREDENTIAL_REUSE"):
            identity.require_independent_credentials(encoded(data), encoded(data))
        second = copy.deepcopy(data)
        second["jwks"]["keys"][0]["n"] += "-new"
        second["cookieKeys"][0] += "-new"
        for client in second["clients"]:
            client["clientSecret"] += "-new"
        identity.require_independent_credentials(encoded(data), encoded(second))
        _, plan = seven_inputs()
        fixture = plan["environments"]["production"]["browser_file"]
        def file(pointer):
            return json.dumps({} if pointer == fixture else encoded(data)).encode()
        applications = [{"product": c["product"], "url": c["applicationUrl"]} for c in data["clients"]]
        def response(origin, path, *_):
            self.assertEqual(origin, origins["portal"])
            if path.endswith("/config"):
                return {"enabled": True, "applications": applications}
            if path.endswith("/jwks"):
                return data["jwks"]
            issuer = data["issuer"]
            return {"issuer": issuer, "authorization_endpoint": issuer + "/auth",
                    "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/jwks"}
        with patch.object(identity, "private_bytes", side_effect=file), patch.object(runtime, "http_read", side_effect=response):
            identity.read_health(plan, "production", True)
            data["jwks"]["keys"][0]["d"] = "synthetic-private-field"
            with self.assertRaisesRegex(runtime.Refused, "PUBLIC_KEYS_DIFFER"):
                identity.read_health(plan, "production", True)
            del data["jwks"]["keys"][0]["d"]
            applications.pop()
            with self.assertRaisesRegex(runtime.Refused, "SERVED_REGISTRY"):
                identity.read_health(plan, "production", True)


class HostedChecks(unittest.TestCase):
    def test_v2_requires_both_pinned_legacy_observations_and_actual_admin_observations(self):
        binding, plan = seven_inputs()
        selected = plan["environments"]["staging"]
        fixtures = {
            "preview_sessions": {"mobile":{"origin":selected["origins"]["mobile"],"bypass_secret":"synthetic-preview"}},
            "fixtures": {"owner":{"email":"owner@example.test"}, "drone_workspace":{"tenant_id":"synthetic"},
                         "member":{"email":"synthetic+onesa-acceptance-{operation_id}-member@example.test"},
                         "administrator":{"email":"synthetic+onesa-acceptance-{operation_id}-administrator@example.test"},
                         "mailbox":{"fixture":"test"}},
        }
        values = encoded(registration(selected["origins"]))
        def read(pointer):
            return json.dumps(fixtures if pointer == selected["browser_file"] else values).encode()
        missing = set()
        observed = []
        def browser(_plan, req, _image, name):
            observed.append(name)
            base = {k:req[k] for k in ["binding","environment","operation_id","scope"]}
            if req["schema_version"] == 1:
                self.assertEqual(set(req["origins"]), {"portal", *identity.LEGACY_PRODUCTS})
                self.assertEqual(set(req["fixtures"]["product_clients"]), set(identity.LEGACY_PRODUCTS))
                self.assertEqual(req["preview_sessions"], {})
                return {**base,"state":"HOSTED_IDENTITY_OBSERVED_NOT_AUTHORIZATION",
                        "physical_hardware_authorized":False, "physical_operations":0,"synthetic_accounts_only":True,
                        "fixture_accounts_disabled":True,"checks":dict.fromkeys(identity.HOSTED_CHECKS,True)}
            self.assertEqual(set(req["fixtures"]), {"owner", "drone_workspace", "product_clients"})
            self.assertEqual(set(req["fixtures"]["product_clients"]), set(identity.CALLBACKS))
            self.assertEqual(req["preview_sessions"], fixtures["preview_sessions"])
            return {**base, "schema_version":2,"state":"HOSTED_ADMINISTRATOR_SIGNIN_OBSERVED_NOT_AUTHORIZATION",
                    "physical_hardware_authorized":False, "physical_operations":0, "observed_at":runtime.now().isoformat(),
                    "checks":dict.fromkeys(identity.hosted_checks(plan,"integrated") - identity.HOSTED_CHECKS - missing,True)}
        with patch.object(identity,"private_bytes",side_effect=read), patch.object(identity,"verify_probe_image",return_value="pinned"), patch.object(identity,"run_hosted_probe",side_effect=browser), patch.object(runtime,"write"):
            op = str(uuid4())
            receipt = identity.hosted(binding,plan,"staging",op,Path("/synthetic"),scope="integrated")
            self.assertEqual(set(receipt["checks"]), identity.hosted_checks(plan,"integrated"))
            self.assertEqual(observed,["oracle_portal_identity_browser.mjs","oracle_portal_identity_browser_v2.mjs"])
            missing.add("mobile_administrator")
            with self.assertRaisesRegex(runtime.Refused,"ADMIN_BROWSER_ACCEPTANCE"):
                identity.hosted(binding,plan,"staging",op,Path("/synthetic"),scope="integrated")


class SevenClientInstallTests(install_tests.IdentityInstallTests):
    allowed = installer.IDENTITY_V2_ALLOWED
    script = "oracle_portal_identity_v2.py"
    prefix = "portal-identity-v2-"

    def setUp(self):
        super().setUp()
        self.profile = self.policy["components"]["DruHustle/onesa-company-portal:identity"]
        self.profile["qualification_profile"] = identity.PROFILE_V2
        self.profile["required_checks"] = {phase: sorted(keys) for phase, keys in identity.CHECKS_V2.items()}
        self.seal()

    def test_cannot_install_seven_client_code_with_three_client_policy_or_incomplete_bundle(self):
        self.validate()
        self.profile["qualification_profile"] = identity.PROFILE
        self.seal()
        with self.assertRaises(installer.verifier.Rejected):
            self.validate()
        self.profile["qualification_profile"] = identity.PROFILE_V2
        self.manifest["files"].pop("runners/oracle_portal_identity_browser_v2.mjs")
        self.seal()
        with self.assertRaises(installer.verifier.Rejected):
            self.validate()


    def test_installed_tools_match_source_and_independent_plan_in_isolated_python(self):
        install_root = self.root / "installed"
        directory = install_root / (self.prefix + self.manifest["source_tree"])
        for item in self.profile["runners"].values():
            item["path"] = str(directory / "runners" / self.script)
        self.seal()
        store = self.root / "authority"
        store.mkdir(mode=0o700)
        (store / "policy.json").write_bytes((self.root / "policy.json").read_bytes())
        (store / "trust.json").write_text(json.dumps({"policy_sha256": self.manifest["policy_sha256"]}))
        with patch.object(installer, "INSTALL_PARENT", install_root):
            _, target, payloads, _ = self.validate()
        self.assertEqual(target, directory)
        for name, data in payloads.items():
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        receipt = {
            "state": "INSTALLED_NOT_COMMISSIONED",
            "source": self.manifest["candidate_commit"],
            "source_tree": self.manifest["source_tree"],
            "policy_sha256": self.manifest["policy_sha256"], "files": self.manifest["files"],
        }
        (target / "installation.json").write_text(json.dumps(receipt))
        for name in ("oracle_portal_identity_v2.py", "oracle_portal_identity_acceptance_v2.py"):
            observation = subprocess.run(
                [sys.executable, "-I", "-c",
                 "import runpy,sys; print(runpy.run_path(sys.argv[1])['PROFILE'])",
                 str(target / "runners" / name)],
                capture_output=True, timeout=15, check=True, text=True,
            )
            self.assertIn(observation.stdout.strip(), (identity.PROFILE_V2, identity.ACCEPTANCE_V2))
        binding = {"repository": self.manifest["repository"], "component": "identity",
                   "candidate_commit": self.manifest["candidate_commit"], "source_tree": self.manifest["source_tree"],
                   "source_sha256": self.manifest["tool_source_sha256"]}
        plan = {"qualification_profile": identity.PROFILE_V2, "verifier_store": str(store)}
        # These fixtures are regular user files. The existing installer suite separately
        # verifies the operating-system owner and directory permissions.
        def fixture_path(path, **_):
            self.assertTrue(path.is_relative_to(self.root) and path.exists())
            return path
        with patch.object(runtime, "INSTALL_PARENT", install_root), patch.object(runtime, "VERIFIER", target / "oracle_owner.py"), patch.object(runtime, "private", side_effect=fixture_path):
            runtime.verify_canonical_component_custody(binding, plan, identity.CHECKS_V2)
            (target / "runners/oracle_portal_identity_browser_v2.mjs").write_text("// changed")
            with self.assertRaisesRegex(runtime.Refused, "HELPER_CHANGED"):
                runtime.verify_canonical_component_custody(binding, plan, identity.CHECKS_V2)


class AcceptanceInstallationTests(install_tests.IdentityAcceptanceInstallTests):
    allowed = installer.IDENTITY_V2_ALLOWED
    script = "oracle_portal_identity_acceptance_v2.py"
    prefix = "portal-identity-acceptance-v2-"

    def setUp(self):
        from oracle_portal_identity_acceptance_v2 import CHECKS, PROFILE
        super().setUp()
        profile = self.policy["components"]["DruHustle/onesa-company-portal:identity-acceptance"]
        profile["qualification_profile"] = PROFILE
        profile["required_checks"] = {phase: sorted(keys) for phase, keys in CHECKS.items()}
        self.seal()

    def test_separate_acceptance_installation_and_profile(self):
        _, target, _, _ = self.validate()
        self.assertEqual(target.name, self.prefix + self.manifest["source_tree"])
        self.policy["components"]["DruHustle/onesa-company-portal:identity-acceptance"]["qualification_profile"] = identity.PROFILE_V2
        self.seal()
        with self.assertRaises(installer.verifier.Rejected):
            self.validate()
