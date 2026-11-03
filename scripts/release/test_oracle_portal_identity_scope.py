"""Source/profile boundary regressions; no live deployment or acceptance."""
import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_portal as portal
import oracle_portal_identity_scope as identity

ROOT = Path(__file__).resolve().parents[2]


class FrontendIdentityScopeTests(unittest.TestCase):
    def inventories(self):
        new = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
               for name in identity.PINS}
        old = dict(new)
        old[identity.PREFIX + "src/features/account/account.tsx"] = "1" * 64
        return old, new

    def test_reviewed_account_source_is_exact_and_default_profile_is_unchanged(self):
        old, new = self.inventories()
        self.assertEqual(identity.reviewed_delta(old, new),
                         [identity.PREFIX + "src/features/account/account.tsx"])
        self.assertEqual(portal.qualification_profile({}), portal.PRESENTATION_PROFILE)
        self.assertEqual(portal.qualification_profile({"qualification_profile": identity.PROFILE}), identity.PROFILE)
        with patch.object(portal, "source_equivalence", return_value="legacy") as original:
            self.assertEqual(portal.source_scope(None, {}, {}), "legacy")
            original.assert_called_once_with(None, {}, {})

    def test_account_proxy_or_manifest_changes_require_an_explicit_new_review(self):
        for name in ["src/features/account/account.tsx", "src/lib/domains.ts",
                     "src/app/api/v1/[...path]/route.ts", "package.json", "package-lock.json",
                     "public/models/nvidia/manifest.json"]:
            old, new = self.inventories()
            new[identity.PREFIX + name] = "2" * 64
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "REVIEWED_SOURCE_CHANGED"):
                identity.reviewed_delta(old, new)

    def test_unrelated_hero_or_runtime_changes_and_deletions_are_rejected(self):
        for path in ["src/components/home-hero.tsx", "src/app/layout.tsx", "next.config.ts"]:
            old, new = self.inventories()
            old[identity.PREFIX + path] = "1" * 64
            new[identity.PREFIX + path] = "2" * 64
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "CHANGED_SCOPE"):
                identity.reviewed_delta(old, new)
        old, new = self.inventories()
        del new[identity.PREFIX + "src/features/account/account.tsx"]
        with self.assertRaisesRegex(ValueError, "REVIEWED_SOURCE_CHANGED"):
            identity.reviewed_delta(old, new)
        old, new = self.inventories()
        with self.assertRaisesRegex(ValueError, "CHANGED_SCOPE"):
            identity.reviewed_delta(new, new)

    def test_all_existing_public_renderer_checks_and_probe_closure_are_retained(self):
        profile = {"qualification_profile": identity.PROFILE}
        for phase in portal.CHECKS:
            with self.subTest(phase=phase):
                self.assertEqual(portal.profile_checks(profile, phase),
                                 portal.profile_checks({"qualification_profile": portal.NVIDIA_PROFILE}, phase))
        files = {str(path.relative_to(ROOT)): "pinned" for path in (ROOT / "scripts/release").glob("*") if path.is_file()}
        for path in [portal.NVIDIA_CATALOG, portal.NVIDIA_LICENSE,
                     identity.PREFIX + "src/config/nvidia-reference-assets.json",
                     "scripts/check_tls_bundle.mjs", "scripts/oracle_backup_store.mjs",
                     identity.PREFIX + "package.json", identity.PREFIX + "package-lock.json",
                     identity.PREFIX + "vendor/onesa-portal-minimatch-callable-1.0.0.tgz"]:
            files[path] = "pinned"
        old = portal.probe_source_files(files, portal.NVIDIA_PROFILE)
        new = portal.probe_source_files(files, identity.PROFILE)
        self.assertEqual(set(new) - set(old), {"scripts/release/oracle_portal_identity_scope.py"})
        del files["scripts/release/oracle_portal_identity_scope.py"]
        with self.assertRaisesRegex(portal.Refused, "COMPLETE_COMMISSIONED_PROBE_SOURCE_REQUIRED"):
            portal.probe_source_files(files, identity.PROFILE)


if __name__ == "__main__":
    unittest.main()
