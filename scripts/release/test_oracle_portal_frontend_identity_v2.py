import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_install as installer
import oracle_portal as portal
import oracle_portal_frontend as frontend
import oracle_portal_frontend_identity_v2 as seven
import test_oracle_portal_frontend as provider_fixture
from test_oracle_portal_nvidia import snapshot


class SevenClientFrontendTests(unittest.TestCase):
    def setUp(self):
        staging = {name: "https://" + name + ".staging.example" for name in seven.PRODUCTION}
        self.origins = {"staging": staging, "production": dict(seven.PRODUCTION)}
        self.issuer = {"qualification_profile": "portal-shared-identity-v2",
                       "environments": {env: {"origins": origins} for env, origins in self.origins.items()}}
        self.binding = {"repository": "DruHustle/onesa-company-portal", "component": "frontend"}
        self.fixture = provider_fixture.ProviderConfigurationTests()
        self.fixture.setUp()
        self.fixture.plan.update(qualification_profile=seven.PROFILE, binding=self.binding)
        self.urls = {}
        for env, origins in self.origins.items():
            key = seven.CALLBACK_KEY
            self.urls[env] = [origins[product] + path for product, path in seven.CALLBACK_PATHS.items()]
            encoded = json.dumps(self.urls[env])
            identifier = "fixture_" + env + "_callbacks"
            self.fixture.plan["server_public_configuration"][env][key] = encoded
            self.fixture.plan["server_public_variable_ids"][env][key] = identifier
            self.fixture.variables[identifier] = {
                "id": identifier, "key": key, "value": encoded, "type": "plain",
                "target": ["preview" if env == "staging" else "production"],
                "gitBranch": "staging" if env == "staging" else None, "updatedAt": 1,
            }

    def protect(self):
        self.fixture.seal()
        def read(path):
            if path == seven.ISSUER_PLAN:
                return self.issuer
            self.assertEqual(path, frontend.PROVIDER)
            return self.fixture.cfg
        with (patch.object(portal, "read", side_effect=read),
              patch.object(portal, "runtime_values", return_value={"PROXY_SHARED_KEY": "s" * 48}),
              patch.object(frontend, "provider", side_effect=self.fixture.provider)):
            return frontend.protection(self.fixture.plan)

    def test_named_public_variables_are_observed_independently(self):
        self.protect()
        for env in self.origins:
            self.assertTrue(any(path.endswith("/fixture_" + env + "_callbacks") for path in self.fixture.calls))
        self.fixture.variables["fixture_production_callbacks"]["value"] = json.dumps(self.urls["staging"])
        with self.assertRaisesRegex(portal.Refused, "EXISTING_SERVER_CONFIGURATION_CHANGED"):
            self.protect()

    def test_mixed_targets_wrong_product_callback_and_reused_stage_are_rejected(self):
        row = self.fixture.variables["fixture_production_callbacks"]
        row["target"].append("preview")
        with self.assertRaisesRegex(portal.Refused, "ISOLATED_FRONTEND_CALLBACK_VARIABLE_REQUIRED"):
            self.protect()
        row["target"].pop()
        urls = list(self.urls["staging"])
        urls[0] += "/different-path"
        self.fixture.plan["server_public_configuration"]["staging"][seven.CALLBACK_KEY] = json.dumps(urls)
        with self.assertRaisesRegex(portal.Refused, "FRONTEND_CALLBACKS_DIFFER"):
            self.protect()
        self.origins["staging"]["farmer"] = seven.PRODUCTION["farmer"]
        with self.assertRaisesRegex(portal.Refused, "EXACT_ISOLATED_SEVEN_CLIENT_ORIGINS_REQUIRED"):
            self.protect()

    def test_v1_has_no_new_public_key_or_installer(self):
        for plan in [{}, {"qualification_profile": portal.IDENTITY_PROFILE}]:
            self.assertNotIn(seven.CALLBACK_KEY, portal.public_server_keys(plan))
        self.assertNotIn("runners/oracle_portal_frontend_identity_v2.py", installer.IDENTITY_FRONTEND_ALLOWED)
        self.assertNotIn("runners/oracle_portal_identity_scope.py", installer.IDENTITY_FRONTEND_V2_ALLOWED)
        self.assertIn("runners/oracle_portal_frontend_identity_v2.py", installer.IDENTITY_FRONTEND_V2_ALLOWED)
        self.assertEqual(portal.qualification_profile({"qualification_profile": seven.PROFILE}), seven.PROFILE)

    def test_full_subtree_includes_unlisted_files_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            source = root / "source"
            source.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            prefix = portal.NVIDIA_PREFIX
            files = {prefix+"src/config/products.ts": b"products", prefix+"src/components/home-products.tsx": b"home",
                     prefix+"unexpected.js": b"original"}
            archive = root / "reviewed.tar"
            whole = snapshot(source, archive, files)
            subtree = subprocess.check_output(["git", "-C", str(source), "rev-parse",
                                                whole + ":onesa-company-portal-frontend"], text=True).strip()
            portal.source_inventory(archive, {"source_tree": whole}, frontend_trees={subtree})
            (source / (prefix+"unexpected.js")).chmod(0o755)
            modified = snapshot(source, archive, files)
            with self.assertRaisesRegex(portal.Refused, "EXACT_SOURCE_TREE_REQUIRED"):
                portal.source_inventory(archive, {"source_tree": modified}, frontend_trees={subtree})
