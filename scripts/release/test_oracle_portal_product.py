"""New public-product scope cannot authorize unrelated source or incomplete views."""

import copy
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import oracle_portal as r


class ProductScopeTests(unittest.TestCase):
    def test_product_mode_is_explicit_and_preserves_auth_and_home_hero_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            folder = root / "artifacts"
            folder.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            prefix = "onesa-company-portal-frontend/"

            def put(name, body):
                p = source / (prefix + name)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body)

            def snapshot(name):
                subprocess.run(["git", "-C", str(source), "add", "."], check=True)
                tree = subprocess.check_output(
                    ["git", "-C", str(source), "write-tree"], text=True
                ).strip()
                (folder / name).write_bytes(
                    subprocess.check_output(["git", "-C", str(source), "archive", tree])
                )
                return tree

            for name in [
                "src/config/products.ts",
                "src/components/home-products.tsx",
                "src/auth.ts",
                "src/components/home-hero.tsx",
            ]:
                put(name, "original")
            old = snapshot("baseline-source.tar")
            plan = {
                "retained_frontend": {
                    "source": "a" * 40,
                    "source_tree": old,
                    "source_sha256": r.sha(folder / "baseline-source.tar"),
                }
            }
            for name in r.DRONE_PRODUCT_FILES:
                put(name, "synthetic public product fixture")
            tree = snapshot("source.tar")
            with patch.object(r, "private", side_effect=lambda p, **_: Path(p)):
                with self.assertRaisesRegex(r.Refused, "REQUIRES_FULL_REQUALIFICATION"):
                    r.source_equivalence(folder, {"source_tree": tree}, plan)
                plan["publication_scope"] = "drone-product"
                v = r.source_equivalence(folder, {"source_tree": tree}, plan)
                self.assertEqual(v["publication_scope"], "drone-product")
                self.assertFalse(v["new_full_business_acceptance_claimed"])
                for name in [
                    "src/auth.ts",
                    "src/components/home-hero.tsx",
                    "src/components/site-header.tsx",
                    "package.json",
                ]:
                    put(name, "out of scope")
                    changed = snapshot("source.tar")
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(
                            r.Refused, "REQUIRES_FULL_REQUALIFICATION"
                        ),
                    ):
                        r.source_equivalence(folder, {"source_tree": changed}, plan)
                    if name in ["src/auth.ts", "src/components/home-hero.tsx"]:
                        put(name, "original")
                    else:
                        (source / (prefix + name)).unlink()
                (source / (prefix + "src/components/drone-product.tsx")).unlink()
                incomplete = snapshot("source.tar")
                with self.assertRaisesRegex(r.Refused, "COMPLETE_DRONE_PRODUCT"):
                    r.source_equivalence(folder, {"source_tree": incomplete}, plan)
                plan["publication_scope"] = "arbitrary"
                with self.assertRaisesRegex(r.Refused, "UNKNOWN_PUBLICATION_SCOPE"):
                    r.source_equivalence(folder, {"source_tree": incomplete}, plan)

    def test_publication_scope_changes_both_signed_configuration_fingerprints(self):
        binding = {
            "repository": "DruHustle/onesa-company-portal",
            "candidate_commit": "b" * 40,
        }
        plan = {
            "project_id": "prj_fixture",
            "team_id": "team_fixture",
            "origins": {
                "staging": "https://fixture.vercel.app",
                "production": "https://onesa.eu",
            },
            "vercel_api_url_variable_ids": {"staging": "stage", "production": "prod"},
            "server_public_configuration": {"staging": {}, "production": {}},
            "server_public_variable_ids": {"staging": {}, "production": {}},
            "staging_proxy_variable_id": "fixture_proxy",
            "staging_proxy_key_sha256": "a" * 64,
            "vercel_protection_sha256": "b" * 64,
            "environment_metadata_sha256": "c" * 64,
            "retained_frontend": {"source": "d" * 40},
            "builds": {},
            "processing_scope": "existing-public-presentation-no-new-processing",
            "privacy_decision": "G14_DEFERRED_BY_OWNER_PRELAUNCH",
            "publication_controls_unchanged": True,
            "physical_hardware_authorized": False,
            "rollback": {"automatic": False},
            "retained_services": {},
        }
        for environment in ["staging", "production"]:
            old = r.configuration_value(binding, plan, environment)
            new = r.configuration_value(
                binding, plan | {"publication_scope": "drone-product"}, environment
            )
            self.assertEqual(old["publication_scope"], "existing-copy")
            self.assertEqual(new["publication_scope"], "drone-product")
            self.assertNotEqual(
                hashlib.sha256(r.canonical(old)).hexdigest(),
                hashlib.sha256(r.canonical(new)).hexdigest(),
            )
            self.assertEqual(old | {"publication_scope": "drone-product"}, new)

    def receipt(self, scope):
        surfaces = ["robot", "drone"] if scope == "drone-product" else ["robot"]
        return {
            "status": "PASS",
            "binding": {"synthetic": "fixture"},
            "environment": "staging",
            "publication_scope": scope,
            "engines": ["chromium", "firefox", "webkit"],
            "views": [
                {
                    "engine": e,
                    "locale": locale,
                    "width": w,
                    "mode": m,
                    "surface": s,
                    "horizontal_overflow": False,
                    **{
                        k: "PASS"
                        for k in [
                            "product_page",
                            "interactive_concept",
                            "existing_enquiry_link",
                            "simulation_only",
                            "on_demand_media",
                            "platform_link",
                        ]
                    },
                }
                for e in ["chromium", "firefox", "webkit"]
                for locale in ["en", "de"]
                for w, m in [(390, "dark"), (1440, "light"), (320, "light")]
                for s in surfaces
            ],
            "operational_mutations": 0,
            "javascript_errors": 0,
            "accessibility_violations": 0,
            "speculative_prefetches": 0,
        }

    def test_complete_surface_matrix_is_required_without_duplicate_inflation(self):
        for scope in ["existing-copy", "drone-product"]:
            receipt = self.receipt(scope)
            plan = {"publication_scope": scope}
            binding = receipt["binding"]
            r.verify_browser_receipt(receipt, binding, "staging", plan)
            for field, value in [
                ("operational_mutations", 1),
                ("javascript_errors", 1),
                ("accessibility_violations", 1),
                ("publication_scope", "foreign"),
            ]:
                with (
                    self.subTest(scope=scope, field=field),
                    self.assertRaises(r.Refused),
                ):
                    r.verify_browser_receipt(
                        receipt | {field: value}, binding, "staging", plan
                    )
            wrong = copy.deepcopy(receipt)
            wrong["views"][0] = wrong["views"][1]
            with self.assertRaises(r.Refused):
                r.verify_browser_receipt(wrong, binding, "staging", plan)
        receipt = self.receipt("drone-product")
        plan = {"publication_scope": "drone-product"}
        for field, value in [
            ("platform_link", "FAIL"),
            ("horizontal_overflow", True),
            ("simulation_only", "SKIPPED"),
        ]:
            wrong = copy.deepcopy(receipt)
            next(v for v in wrong["views"] if v["surface"] == "drone")[field] = value
            with self.subTest(field=field), self.assertRaises(r.Refused):
                r.verify_browser_receipt(wrong, receipt["binding"], "staging", plan)
        with self.assertRaises(r.Refused):
            r.verify_browser_receipt(
                self.receipt("existing-copy"), receipt["binding"], "staging", plan
            )
