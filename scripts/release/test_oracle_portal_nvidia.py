"""Synthetic failure-path tests; none is hosted evidence or a release approval."""

import copy
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_install as installer
import oracle_owner as verifier
import oracle_portal as r
import oracle_portal_frontend as frontend
import test_oracle_install as install_tests
import test_oracle_portal_product as product_tests

ROOT = Path(__file__).resolve().parents[2]
PREFIX = r.NVIDIA_PREFIX


def public_files():
    catalog = json.loads((ROOT / r.NVIDIA_CATALOG).read_bytes())
    names = {r.NVIDIA_CATALOG, r.NVIDIA_LICENSE, PREFIX + "src/config/nvidia-reference-assets.json"}
    names |= {
        PREFIX + "public/models/nvidia/" + asset[key]["path"]
        for asset in catalog["assets"]
        for key in ["glb", "thumbnail", "licenseFile", "sourceFile"]
    }
    return {name: (ROOT / name).read_bytes() for name in names}


def snapshot(source, destination, files):
    for name, body in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    subprocess.run(["git", "-C", str(source), "add", "."], check=True, capture_output=True)
    tree = subprocess.check_output(["git", "-C", str(source), "write-tree"], text=True).strip()
    destination.write_bytes(subprocess.check_output(["git", "-C", str(source), "archive", tree]))
    return tree


class NvidiaScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.source = self.folder / "source"
        self.source.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.source)], check=True, capture_output=True)
        current = json.loads((ROOT / PREFIX / "package.json").read_bytes())
        old = copy.deepcopy(current)
        old["scripts"]["build"] = "next build --webpack"
        for key in ["test:nvidia-assets", "test:nvidia-browser", "test:dependency-security"]:
            old["scripts"].pop(key)
        old["dependencies"].pop("three")
        for key in ["@types/three", "minimatch"]:
            old["devDependencies"].pop(key)
        old["devDependencies"]["eslint"] = "^9.39.0"
        old.pop("overrides")
        current_proxy = (ROOT / PREFIX / "src/proxy.ts").read_bytes()
        previous_proxy = current_proxy
        for original, replacement in r.NVIDIA_PROXY_CHANGES:
            self.assertEqual(previous_proxy.count(replacement), 1)
            previous_proxy = previous_proxy.replace(replacement, original)
        self.files = {
            PREFIX + "src/config/products.ts": b"// unchanged fixture product data\n",
            PREFIX + "src/components/home-products.tsx": b"// unchanged fixture presentation\n",
            PREFIX + "src/auth.ts": b"// retained authentication boundary\n",
            PREFIX + "src/components/home-hero.tsx": b"// retained hero\n",
            PREFIX + "src/components/responsive-link.tsx": b"<Link {...props}>children</Link>",
            PREFIX + "src/components/company-story.tsx": b"Onesa AI Robot / ONESA AI ROBOT\n",
            PREFIX + "src/proxy.ts": previous_proxy,
            PREFIX + "package.json": json.dumps(old).encode(),
        }
        tree = snapshot(self.source, self.folder / "baseline-source.tar", self.files)
        self.baseline = {"source": "a" * 40, "source_tree": tree, "source_sha256": r.sha(self.folder / "baseline-source.tar")}
        self.plan = {"qualification_profile": r.NVIDIA_PROFILE, "retained_frontend": self.baseline.copy()}
        self.files.update(public_files())
        self.files[PREFIX + "src/proxy.ts"] = current_proxy
        self.files[r.NVIDIA_DRONE_LAYOUT] = (ROOT / r.NVIDIA_DRONE_LAYOUT).read_bytes()
        self.files[r.NVIDIA_DRONE_DIAGNOSTIC_TEST] = (ROOT / r.NVIDIA_DRONE_DIAGNOSTIC_TEST).read_bytes()
        for name in set(installer.NVIDIA_ALLOWED.values()) | {
            "scripts/check_tls_bundle.mjs", PREFIX + "package.json", PREFIX + "package-lock.json",
            PREFIX + "vendor/onesa-portal-minimatch-callable-1.0.0.tgz",
        }:
            self.files[name] = (ROOT / name).read_bytes()
        self.refresh()

    def refresh(self):
        tree = snapshot(self.source, self.folder / "source.tar", self.files)
        self.binding = {"candidate_commit": "b" * 40, "source_tree": tree, "source_sha256": r.sha(self.folder / "source.tar")}
        self.tool = {
            "source_commit": self.binding["candidate_commit"],
            "source_tree": tree, "source_sha256": self.binding["source_sha256"],
            "frontend_baseline": self.baseline.copy(),
            "probe_files": r.probe_source_files({name: hashlib.sha256(body).hexdigest() for name, body in self.files.items()}, r.NVIDIA_PROFILE),
        }

    def scope(self, plan=None):
        with patch.object(r, "private", side_effect=lambda path, **_kw: Path(path)), patch.object(r, "trusted_toolchain", return_value=self.tool):
            return r.source_scope(self.folder, self.binding, self.plan if plan is None else plan)

    def test_explicit_profile_accepts_only_reviewed_renderer_delta_and_old_gate_still_refuses(self):
        result = self.scope()
        self.assertEqual(result["qualification_profile"], r.NVIDIA_PROFILE)
        self.assertFalse(result["new_full_business_acceptance_claimed"])
        with self.assertRaisesRegex(r.Refused, "NO_RUNTIME_PACKAGE_CHANGE"):
            self.scope({"retained_frontend": self.baseline})
        with self.assertRaisesRegex(r.Refused, "UNKNOWN_FRONTEND"):
            self.scope(self.plan | {"qualification_profile": "full-frontend"})

    def test_auth_hero_or_unrelated_frontend_changes_require_separate_qualification(self):
        for name in ["src/auth.ts", "src/components/home-hero.tsx", "src/app/layout.tsx"]:
            key = PREFIX + name
            previous = self.files.get(key)
            self.files[key] = b"// outside reviewed public-renderer scope\n"
            self.refresh()
            with self.subTest(name=name), self.assertRaisesRegex(r.Refused, "CHANGED_SCOPE"):
                self.scope()
            if previous is None:
                self.files.pop(key)
                (self.source / key).unlink()
            else:
                self.files[key] = previous
        self.refresh()

    def test_a_real_intermediate_comparison_tree_cannot_replace_retained_baseline(self):
        self.files[PREFIX + "src/auth.ts"] = b"// changed authentication in an intermediate source\n"
        self.refresh()
        intermediate = {"source": "c" * 40, "source_tree": self.binding["source_tree"], "source_sha256": self.binding["source_sha256"]}
        self.tool["frontend_baseline"] = intermediate
        with self.assertRaisesRegex(r.Refused, "COMMISSIONED_FRONTEND_BASELINE_CHANGED"):
            self.scope(self.plan | {"source_comparison_baseline": intermediate})

    def test_candidate_cannot_reuse_tools_from_a_different_installed_source(self):
        self.tool["source_commit"] = "c" * 40
        with self.assertRaisesRegex(r.Refused, "EXACT_INSTALLED_MAIN_SOURCE"):
            self.scope()

    def test_unrelated_dependency_or_build_change_is_refused_even_in_new_profile(self):
        original = self.files[PREFIX + "package.json"]
        for section, key, value in [("dependencies", "next", "unreviewed"), ("scripts", "build", "unreviewed")]:
            package = json.loads(original)
            package[section][key] = value
            self.files[PREFIX + "package.json"] = json.dumps(package).encode()
            self.refresh()
            with self.subTest(section=section), self.assertRaisesRegex(r.Refused, "DEPENDENCY_BUILD_DELTA_ONLY"):
                self.scope()

    def test_brand_only_extension_does_not_allow_other_source_changes(self):
        path = PREFIX + "src/components/company-story.tsx"
        self.files[path] = b"Onesa Robot / ONESA ROBOT\n"
        self.refresh()
        self.scope()
        self.files[path] += b"unreviewed behavior\n"
        self.refresh()
        with self.assertRaisesRegex(r.Refused, "BRAND_TEXT_SUBSTITUTION_ONLY"):
            self.scope()

    def test_exact_model_cache_exception_rejects_auth_csp_and_scope_changes(self):
        path = PREFIX + "src/proxy.ts"
        original = self.files[path]
        self.scope()
        changes = [
            (b"if(current==='unknown')", b"if(false)"),
            (b'"default-src \'self\'"', b'"default-src *"'),
            (b'nvidiaModelPaths.has(request.nextUrl.pathname)', b'request.nextUrl.pathname.startsWith("/models/")'),
            (b'"private, no-cache"', b'"public, max-age=86400"'),
            (b'["GET", "HEAD"]', b'["GET", "HEAD", "POST"]'),
            (b'!request.url.includes("?")', b'true'),
        ]
        for before, after in changes:
            self.assertEqual(original.count(before), 1)
            self.files[path] = original.replace(before, after)
            self.refresh()
            with self.subTest(change=before), self.assertRaisesRegex(r.Refused, "NVIDIA_PUBLIC_MODEL_CACHE_CHANGE_ONLY"):
                self.scope()
        self.files[path] = original
        self.refresh()

    def test_changed_asset_bytes_fail_even_if_candidate_and_tool_source_are_repinned(self):
        catalog = json.loads(self.files[r.NVIDIA_CATALOG])
        path = PREFIX + "public/models/nvidia/" + catalog["assets"][0]["glb"]["path"]
        self.files[path] = self.files[path][:-1] + bytes([self.files[path][-1] ^ 1])
        self.refresh()
        with self.assertRaisesRegex(r.Refused, "SOURCE_ASSET_BYTES_CHANGED"):
            self.scope()

    def test_drone_reflow_cannot_admit_unrelated_css_or_hide_overflow(self):
        path = r.NVIDIA_DRONE_LAYOUT
        original = self.files[path]
        self.scope()
        for change in [
            original + b"\n.hero { display: none; }\n",
            original.replace(b"overflow-wrap: anywhere", b"overflow-x: hidden", 1),
            original.replace(b"grid-template-columns:minmax(0,1fr);gap:30px", b"grid-template-columns:1fr;gap:30px", 1),
        ]:
            self.assertNotEqual(original, change)
            self.files[path] = change
            self.refresh()
            with self.subTest(change=hashlib.sha256(change).hexdigest()), self.assertRaisesRegex(r.Refused, "NVIDIA_REVIEWED_DRONE_REFLOW_ONLY"):
                self.scope()
        self.files.pop(path)
        (self.source / path).unlink()
        self.refresh()
        with self.assertRaisesRegex(r.Refused, "NVIDIA_REVIEWED_DRONE_REFLOW_ONLY"):
            self.scope()
        self.files[path] = original
        self.refresh()

    def test_drone_diagnostics_cannot_force_click_or_replace_error_or_add_output(self):
        path = r.NVIDIA_DRONE_DIAGNOSTIC_TEST
        original = self.files[path]
        self.scope()
        for change in [
            original.replace(b".locator('summary').click();", b".locator('summary').click({force:true});", 1),
            original.replace(b"throw error;}finally", b"return;}finally", 1),
            original + b"\nconsole.log(process.env);\n",
        ]:
            self.assertNotEqual(original, change)
            self.files[path] = change
            self.refresh()
            with self.subTest(change=hashlib.sha256(change).hexdigest()), self.assertRaisesRegex(r.Refused, "NVIDIA_REVIEWED_DRONE_DIAGNOSTICS_ONLY"):
                self.scope()
        self.files.pop(path)
        (self.source / path).unlink()
        self.refresh()
        with self.assertRaisesRegex(r.Refused, "NVIDIA_REVIEWED_DRONE_DIAGNOSTICS_ONLY"):
            self.scope()
        self.files[path] = original
        self.refresh()

    def test_transitive_dependency_or_vendor_change_needs_new_explicit_review(self):
        for path in r.NVIDIA_DEPENDENCY_PINS:
            original = self.files[path]
            self.files[path] += b"\n"
            self.refresh()
            with self.subTest(path=path), self.assertRaisesRegex(r.Refused, "DEPENDENCY_CLOSURE_ONLY"):
                self.scope()
            self.files[path] = original

    def test_metadata_size_is_checked_before_json_parser(self):
        archive = self.folder / "oversize.tar"
        with tarfile.open(archive, "w") as out:
            item = tarfile.TarInfo(r.NVIDIA_CATALOG)
            item.size = 32768
            out.addfile(item, io.BytesIO(b" " * item.size))
        with patch.object(r.json, "load", side_effect=AssertionError("parser must not run")), self.assertRaisesRegex(r.Refused, "BOUNDED_NVIDIA"):
            r.nvidia_source_metadata(archive, {r.NVIDIA_CATALOG: "0" * 64})


class NvidiaReceiptTests(unittest.TestCase):
    def setUp(self):
        catalog = json.loads((ROOT / r.NVIDIA_CATALOG).read_bytes())
        public = {
            "/models/nvidia/manifest.json": {"sha256": r.sha(ROOT / r.NVIDIA_CATALOG), "byte_length": (ROOT / r.NVIDIA_CATALOG).stat().st_size},
            "/licenses/three.txt": {"sha256": r.sha(ROOT / r.NVIDIA_LICENSE), "byte_length": (ROOT / r.NVIDIA_LICENSE).stat().st_size},
        }
        public.update({"/models/nvidia/" + asset[key]["path"]: {"sha256": asset[key]["sha256"], "byte_length": asset[key]["byteLength"]} for asset in catalog["assets"] for key in ["glb", "thumbnail", "licenseFile", "sourceFile"]})
        self.metadata = {"catalog": catalog, "public_files": public}
        self.receipt = product_tests.ProductMatrixTests().receipt()
        self.receipt.update({"qualification_profile": r.NVIDIA_PROFILE, "nvidia": {
            "contract": copy.deepcopy(r.NVIDIA_CONTRACT),
            "catalog_sha256": public["/models/nvidia/manifest.json"]["sha256"],
            "renderer_license_sha256": public["/licenses/three.txt"]["sha256"],
            "network_interceptions": 0, "synthetic_successes": 0,
            "launches": [{"engine": engine, "version": "123.0", "headless": engine != "firefox", "bundled_engine": True} for engine in r.NVIDIA_CONTRACT["engines"]],
            "asset_deliveries": [{"engine": engine, "path": path, "status": 200, "redirects": 0, **metadata} for engine in r.NVIDIA_CONTRACT["engines"] for path, metadata in public.items()],
            "views": [{"engine": engine, "locale": locale, "width": width, "mode": mode, "assets": [
                {"id": asset["id"], "path": "/models/nvidia/" + asset["glb"]["path"], "sha256": asset["glb"]["sha256"], "byte_length": asset["glb"]["byteLength"], "render_state": "ready", "canvas_count": 1, "graphics_api": "WebGL2", "context_lost": False, "keyboard_rotation": 1, "fit_rotation": 0}
                for asset in catalog["assets"]
            ], "theme_model_reload_count": 0, "accessibility_violations": 0, "horizontal_overflow": False, "enlarged_text_overflow": False} for engine in r.NVIDIA_CONTRACT["engines"] for locale in ["en", "de"] for width in [320, 1440] for mode in ["light", "dark"]],
            "fallbacks": [{"engine": engine, "locale": locale, "product_index_state": "ready", "product_index_asset_ids": r.NVIDIA_ASSET_IDS, "context_loss_state": "failed", "context_recovery_state": "ready", "no_graphics_state": "unavailable", "no_graphics_preview_loaded": True, "no_script_preview_loaded": True} for engine in r.NVIDIA_CONTRACT["engines"] for locale in ["en", "de"]],
        }})

    def verify(self, value):
        r.verify_browser_receipt(value, self.receipt["binding"], "staging", nvidia=self.metadata)

    def test_complete_contract_and_mandatory_phase_checks(self):
        self.verify(self.receipt)
        for phase in ["staging", "production"]:
            self.assertTrue(r.NVIDIA_CHECKS <= r.profile_checks({"qualification_profile": r.NVIDIA_PROFILE}, phase))
            self.assertFalse(r.NVIDIA_CHECKS & r.profile_checks({}, phase))

    def test_duplicate_missing_or_foreign_case_cannot_inflate_matrix(self):
        for field in ["views", "fallbacks", "asset_deliveries", "launches"]:
            for mode in ["duplicate", "missing", "foreign"]:
                value = copy.deepcopy(self.receipt)
                rows = value["nvidia"][field]
                if mode == "duplicate":
                    rows[0] = rows[1]
                elif mode == "missing":
                    rows.pop()
                else:
                    rows[0]["engine"] = "unreviewed"
                with self.subTest(field=field, mode=mode), self.assertRaises(r.Refused):
                    self.verify(value)

    def test_generic_or_local_pass_and_catalog_substitution_never_qualify(self):
        for key, changed in [("status", "LOCAL_SYNTHETIC_NOT_HOSTED"), ("qualification_profile", r.PRESENTATION_PROFILE)]:
            with self.subTest(key=key), self.assertRaises(r.Refused):
                self.verify(self.receipt | {key: changed})
        for key, changed in [("catalog_sha256", "0" * 64), ("renderer_license_sha256", "0" * 64), ("network_interceptions", 1), ("synthetic_successes", 1)]:
            value = copy.deepcopy(self.receipt)
            value["nvidia"][key] = changed
            with self.subTest(key=key), self.assertRaises(r.Refused):
                self.verify(value)

    def test_render_fallback_skips_wrong_asset_and_failed_a11y_are_rejected(self):
        for field, key, changed in [("views", "enlarged_text_overflow", True), ("views", "accessibility_violations", 1), ("views", "theme_model_reload_count", 1), ("fallbacks", "context_recovery_state", "SKIPPED"), ("fallbacks", "no_script_preview_loaded", False), ("asset_deliveries", "sha256", "0" * 64), ("asset_deliveries", "redirects", 1), ("launches", "bundled_engine", False), ("launches", "headless", False)]:
            value = copy.deepcopy(self.receipt)
            value["nvidia"][field][0][key] = changed
            with self.subTest(field=field, key=key), self.assertRaises(r.Refused):
                self.verify(value)
        for key, changed in [("id", "other"), ("render_state", "unavailable"), ("canvas_count", 0), ("graphics_api", "synthetic"), ("context_lost", True), ("keyboard_rotation", 0), ("sha256", "0" * 64)]:
            value = copy.deepcopy(self.receipt)
            value["nvidia"]["views"][0]["assets"][0][key] = changed
            with self.subTest(key=key), self.assertRaises(r.Refused):
                self.verify(value)


class NvidiaProfileBindingTests(unittest.TestCase):
    def test_profile_and_observation_contract_change_bound_configuration_bytes(self):
        plan = {
            "project_id": "prj_fixture", "team_id": "team_fixture",
            "origins": {"staging": "https://onesa-company-portal-git-staging-fixture.vercel.app", "production": "https://onesa.eu"},
            "vercel_api_url_variable_ids": {env: "synthetic-routing-id" for env in r.ENV},
            "server_public_configuration": {env: {} for env in r.ENV},
            "server_public_variable_ids": {env: {} for env in r.ENV},
            "staging_proxy_variable_id": "synthetic-proxy-id", "staging_proxy_key_sha256": "0" * 64,
            "vercel_protection_sha256": "1" * 64, "environment_metadata_sha256": "2" * 64,
            "retained_frontend": {"source": "a" * 40}, "builds": {}, "retained_services": {},
            "processing_scope": "existing-public-presentation-no-new-processing", "privacy_decision": "G14_DEFERRED",
            "publication_controls_unchanged": True, "physical_hardware_authorized": False, "rollback": {},
        }
        binding = {"repository": "DruHustle/onesa-company-portal", "candidate_commit": "b" * 40}
        for env in r.ENV:
            legacy = r.configuration_value(binding, plan, env)
            expanded = r.configuration_value(binding, plan | {"qualification_profile": r.NVIDIA_PROFILE}, env)
            self.assertNotEqual(r.canonical(legacy), r.canonical(expanded))
            self.assertEqual(expanded["qualification_profile"], r.NVIDIA_PROFILE)
            self.assertEqual(expanded["nvidia_observation_contract"], r.NVIDIA_CONTRACT)

    def test_profile_cannot_be_selected_by_plan_against_other_commissioned_policy(self):
        binding = {"repository": "DruHustle/onesa-company-portal", "component": "frontend", "target_environment": "production"}
        trust = {key: "0" * 64 for key in ["installation_id", "key_id", "verifier_sha256", "policy_sha256", "openssl_sha256"]}
        for plan_profile, policy_profile in [(r.NVIDIA_PROFILE, r.PRESENTATION_PROFILE), (r.PRESENTATION_PROFILE, r.NVIDIA_PROFILE)]:
            policy = {"components": {binding["repository"] + ":frontend": {"qualification_attempt_limit": 1, "qualification_profile": policy_profile}}}
            values = {
                Path("/synthetic/store/trust.json"): trust,
                Path("/etc/onesa/oracle-release-trust.json"): {"installations": {"/synthetic/store": trust | {"active": True}}},
                Path("/synthetic/store/policy.json"): policy,
            }
            with patch.object(r, "private", side_effect=lambda path, **_kw: Path(path)), patch.object(r, "read", side_effect=lambda path: values[Path(path)]), patch.object(r, "sha", return_value="0" * 64), self.subTest(plan=plan_profile), self.assertRaisesRegex(r.Refused, "COMMISSIONED_FRONTEND_PROFILE_CHANGED"):
                r.verify_toolchain({"verifier_store": "/synthetic/store", "qualification_profile": plan_profile}, binding)

    def test_preflight_requires_actual_retained_provider_source_before_qualification(self):
        plan = {"qualification_profile": r.NVIDIA_PROFILE, "project_id": "prj_fixture", "retained_frontend": {"deployment_id": "dpl_fixture", "source": "a" * 40}}
        deployment = {"id": "dpl_fixture", "projectId": "prj_fixture", "readyState": "READY", "target": "production", "meta": {"githubCommitSha": "b" * 40}}
        with patch.object(r, "validate_plan", return_value=(Path("/synthetic"), plan)), patch.object(r, "retained_services"), patch.object(frontend, "protection", return_value={"targets": {"production": {"id": "dpl_fixture"}}}), patch.object(frontend, "provider", return_value=deployment) as provider, patch.object(r, "readiness_and_denials") as readiness, self.assertRaisesRegex(r.Refused, "MUST_MATCH_ACTUAL_RETAINED_FRONTEND"):
            r.preflight({})
        provider.assert_called_once_with("/v13/deployments/dpl_fixture")
        readiness.assert_not_called()

    def test_headed_graphics_probe_keeps_existing_resource_bounds_and_timeout_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "observations").mkdir()
            metadata = {"public_files": {"/models/nvidia/manifest.json": {"sha256": "1" * 64}, "/licenses/three.txt": {"sha256": "2" * 64}}}
            with patch.object(r, "inventory", return_value={}), patch.object(r, "retained_services", return_value={}), patch.object(frontend, "observe_provider", return_value={"origin": "https://onesa-company-portal-git-staging-fixture.vercel.app", "bypass": "synthetic"}), patch.object(r, "readiness_and_denials", return_value={}), patch.object(r, "source_scope", return_value={"nvidia": metadata}), patch.object(r, "probe_cpu_limit", return_value="1"), patch.object(r.subprocess, "run", side_effect=subprocess.TimeoutExpired("probe", 900)) as execute, self.assertRaises(subprocess.TimeoutExpired):
                r.probe({"component": "frontend"}, "staging", "owned", folder, {"qualification_profile": r.NVIDIA_PROFILE, "probe_image": "sha256:" + "0" * 64})
            args = execute.call_args.args[0]
            self.assertEqual(args[args.index("--entrypoint") + 1], "xvfb-run")
            self.assertEqual(args[args.index("--memory") + 1], "1400m")
            self.assertEqual(args[args.index("--cpus") + 1], "1")
            self.assertEqual(execute.call_args.kwargs["timeout"], 900)
            self.assertIn("--server-args=-screen 0 1920x1080x24", args)
            self.assertFalse((folder / "observations/owned/browser-request.json").exists())


class NvidiaInstallTests(unittest.TestCase):
    def setUp(self):
        self.fixture = install_tests.InstallTests()
        self.fixture.allowed = installer.NVIDIA_ALLOWED
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        fixture = self.fixture
        files = fixture.github.files
        files.update(public_files())
        tree = snapshot(fixture.root / "synthetic-source", fixture.root / "tool-source.tar", files)
        fixture.manifest["source_tree"] = tree
        fixture.manifest["tool_source_sha256"] = r.sha(fixture.root / "tool-source.tar")
        tool = fixture.policy["toolchain"]
        tool.update({"source_tree": tree, "source_sha256": fixture.manifest["tool_source_sha256"]})
        tool["probe_files"] = r.probe_source_files({name: hashlib.sha256(body).hexdigest() for name, body in files.items()}, r.NVIDIA_PROFILE)
        tool["frontend_baseline"] = {"source": "b" * 40, "source_tree": "c" * 40, "source_sha256": "d" * 64}
        fixture.github.baseline_expected = ("b" * 40, "c" * 40)
        self.profile = fixture.policy["components"]["DruHustle/onesa-company-portal:frontend"]
        self.profile["qualification_profile"] = r.NVIDIA_PROFILE
        for phase, runner in self.profile["runners"].items():
            runner["path"] = str(installer.INSTALL_PARENT / ("portal-" + tree) / "runners/oracle_portal_frontend.py")
            self.profile["required_checks"][phase] = sorted(r.profile_checks(self.profile, phase))
        fixture.seal()

    def test_profile_installs_only_current_source_with_all_observers_and_no_authority(self):
        manifest, _target, files, _ci = self.fixture.validate()
        self.assertEqual(set(manifest["files"]), set(installer.NVIDIA_ALLOWED))
        self.assertIn("runners/oracle_portal_nvidia.mjs", files)

    def test_profile_cannot_omit_observer_checks_or_use_legacy_file_set(self):
        self.profile["required_checks"]["staging"].remove("nvidia_renderer")
        self.fixture.seal()
        with self.assertRaises(verifier.Rejected):
            self.fixture.validate()
        self.profile["required_checks"]["staging"].append("nvidia_renderer")
        for name in set(installer.NVIDIA_ALLOWED) - set(installer.ALLOWED):
            self.fixture.manifest["files"].pop(name)
        self.fixture.seal()
        with self.assertRaises(verifier.Rejected):
            self.fixture.validate()

    def test_missing_vendor_or_catalog_pin_and_wrong_baseline_are_refused(self):
        tool = self.fixture.policy["toolchain"]
        for name in [PREFIX + "vendor/onesa-portal-minimatch-callable-1.0.0.tgz", r.NVIDIA_CATALOG]:
            original = tool["probe_files"].pop(name)
            self.fixture.seal()
            with self.subTest(name=name), self.assertRaises(verifier.Rejected):
                self.fixture.validate()
            tool["probe_files"][name] = original
        tool["frontend_baseline"]["source_tree"] = "e" * 40
        self.fixture.seal()
        with self.assertRaises(verifier.Rejected):
            self.fixture.validate()
