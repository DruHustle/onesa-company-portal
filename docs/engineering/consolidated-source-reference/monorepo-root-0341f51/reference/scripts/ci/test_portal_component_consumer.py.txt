"""Canonical Portal contract fixtures, never installed or hosted acceptance.

Reuse the original legacy installer/Ed25519 Store fixtures and the strict root
source-consumer API fixture. No provider, private host or network is consulted.
"""

import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

from test_source_consumer import SourceFixture

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "onesa-company-portal/scripts/release"
sys.path.insert(0, str(RELEASE))
import oracle_owner as owner
import oracle_install as installer
import oracle_portal as portal
import oracle_frontend_build as builder
import oracle_portal_frontend as frontend
import test_oracle_install as legacy_install
import test_oracle_owner as legacy_owner
import test_oracle_portal_frontend as legacy_frontend
import test_oracle_portal_nvidia as legacy_nvidia
import oracle_portal_api as portal_api
import oracle_portal_worker as portal_worker
import oracle_portal_scanner as portal_scanner
import oracle_portal_identity as portal_identity
import oracle_portal_identity_acceptance as portal_acceptance
import test_oracle_portal_api as legacy_api
import test_oracle_portal_worker as legacy_worker
import test_oracle_portal_scanner as legacy_scanner
import test_oracle_portal_identity as legacy_identity


def archive_pins(source):
    return {name: hashlib.sha256(base64.b64decode(data)).hexdigest()
            for name, data in source.archives.items()}


class CanonicalInstallTests(unittest.TestCase):
    def setUp(self):
        fixture = legacy_install.InstallTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.configure(fixture)

    def configure(self, fixture):
        self.fixture = fixture
        self.source = SourceFixture(owner, branch="main")
        self.source.baseline_reads = []
        source = self.source.source
        source["product_source_tree"] = fixture.manifest["source_tree"]
        self.source.tree["tree"][0]["sha"] = source["product_source_tree"]
        for name, manifest in self.source.manifests.items():
            manifest["product_source_tree"] = source["product_source_tree"]
            self.source.repack(name)
        fixture.manifest.update(source)
        legacy = fixture.github

        def api(path):
            if (hasattr(legacy, "baseline_expected") and path ==
                    "repos/DruHustle/onesa-company-portal/git/commits/" + legacy.baseline_expected[0]):
                self.source.baseline_reads.append(path)
                return legacy.api(path)
            if path == self.source.prefix + "git/trees/" + source["product_source_tree"] + "?recursive=1":
                return {**legacy.api(path), "sha": source["product_source_tree"]}
            if path.startswith(self.source.prefix + "git/blobs/"):
                return legacy.api(path)
            return self.source.api(path)

        self.source.github.api = api
        # Keep the original installer's explicit synthetic owner identity.
        # The real Actions custody refusal is checked independently below.
        self.source.github.owner = legacy.owner
        fixture.github = self.source.github
        fixture.policy["schema_version"] = 2
        profile = fixture.policy["components"].pop("DruHustle/onesa-company-portal:" + fixture.component)
        fixture.policy["components"]["DruHustle/onesa-ug:portal:" + fixture.component] = profile
        target = installer.INSTALL_PARENT / (fixture.prefix + "canonical-" + source["source_tree"])
        for runner in profile["runners"].values():
            runner["path"] = str(target / "runners" / fixture.script)
        fixture.policy["toolchain"].update(
            source_tree=source["source_tree"], source_binding=copy.deepcopy(source),
            source_archives=archive_pins(self.source),
        )
        for name, data in self.source.archives.items():
            fixture.put("source-artifacts/" + name + ".zip", base64.b64decode(data))
        fixture.seal()

    def test_product_archive_and_root_identity_are_both_qualified_without_authority(self):
        manifest, target, payloads, ci = self.fixture.validate()
        self.assertEqual(manifest["source_tree"], self.source.source["source_tree"])
        self.assertNotEqual(manifest["source_tree"], manifest["product_source_tree"])
        self.assertEqual(target.name, "portal-canonical-" + manifest["source_tree"])
        self.assertEqual(ci[0]["source"], self.source.source)
        self.assertTrue(ci[0]["verification_only"])
        self.assertFalse(ci[0]["release_authorized"])
        for name, data in self.source.archives.items():
            self.assertEqual(payloads["source-artifacts/" + name + ".zip"], base64.b64decode(data))
        self.assertFalse(any(path.name in {"records.sqlite", "signing.pem", "installation.json"}
                             for path in self.fixture.root.iterdir()))

    def test_wrong_identity_or_operational_component_cannot_reuse_portal_source(self):
        for key, value in [("repository_id", 1), ("product", "platform"),
                           ("source_path", "onesa-robot"), ("branch", "staging"),
                           ("source_tree", "f" * 40), ("product_source_tree", "e" * 40)]:
            with self.subTest(key=key):
                original = self.fixture.manifest[key]
                self.fixture.manifest[key] = value
                self.fixture.seal()
                with self.assertRaises(owner.Rejected):
                    self.fixture.validate()
                self.fixture.manifest[key] = original
        self.fixture.seal()
        binding = {**self.source.source, "component": "database"}
        with self.assertRaises(owner.Rejected):
            self.source.github.qualify(binding, self.source.archives)

    def test_source_only_policy_cannot_be_used_as_an_installation_policy(self):
        self.fixture.policy = copy.deepcopy(self.source.policy)
        self.fixture.seal()
        with self.assertRaises(owner.Rejected):
            self.fixture.validate()

    def test_real_owner_custody_refuses_actions_before_any_api_request(self):
        github = owner.GitHub("synthetic-owner-refusal")
        with (patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}),
              patch.object(github, "api") as api):
            with self.assertRaisesRegex(owner.Rejected, "Owner custody cannot run in Actions"):
                github.owner()
            api.assert_not_called()

    def test_other_complete_component_installers_cannot_inherit_frontend_policy(self):
        original = self.fixture.manifest["files"]
        for allowed in [installer.SCANNER_ALLOWED, installer.WORKER_ALLOWED,
                        installer.API_ALLOWED, installer.IDENTITY_ALLOWED]:
            self.fixture.manifest["files"] = {name: "a" * 64 for name in allowed}
            self.fixture.seal()
            with self.subTest(paths=len(allowed)), self.assertRaisesRegex(owner.Rejected, "selected independent"):
                self.fixture.validate()
        self.fixture.manifest["files"] = original

    def test_existing_profile_and_first_attempt_source_gates_stay_required(self):
        profile = self.fixture.policy["components"]["DruHustle/onesa-ug:portal:frontend"]
        profile["required_checks"]["staging"].remove("persistence")
        self.fixture.seal()
        with self.assertRaises(owner.Rejected):
            self.fixture.validate()
        profile["required_checks"]["staging"].append("persistence")
        self.fixture.seal()
        self.source.run["conclusion"] = "failure"
        with self.assertRaises(owner.Rejected):
            self.fixture.validate()

    def test_missing_changed_or_linked_source_zip_is_refused_without_fallback(self):
        name = next(iter(self.source.archives))
        path = self.fixture.root / "source-artifacts" / (name + ".zip")
        original = path.read_bytes()
        path.write_bytes(original + b"changed")
        with self.assertRaises(owner.Rejected):
            self.fixture.validate()
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.fixture.validate()
        other = self.fixture.root / "other-archive.zip"
        other.write_bytes(original)
        other.chmod(0o600)
        path.symlink_to(other)
        with self.assertRaises(owner.Rejected):
            self.fixture.validate()

    def test_current_main_and_root_to_product_mapping_are_reobserved(self):
        for value, key, replacement in [
            (self.source.api_values[self.source.prefix + "branches/main"]["commit"], "sha", "d" * 40),
            (self.source.tree["tree"][0], "sha", "d" * 40),
            (self.source.review["head"], "ref", "temporary-candidate"),
        ]:
            with self.subTest(key=key, replacement=replacement):
                old = value[key]
                value[key] = replacement
                with self.assertRaises(owner.Rejected):
                    self.fixture.validate()
                value[key] = old

    def test_tar_cannot_substitute_root_tree_for_the_pinned_product_subtree(self):
        binding = copy.deepcopy(self.source.source)
        binding["product_source_tree"] = binding["source_tree"]
        with self.assertRaisesRegex(portal.Refused, "ARCHIVE_DIFFERS"):
            portal.source_inventory(self.fixture.root / "tool-source.tar", binding)


class CanonicalBackendComponentTests(unittest.TestCase):
    fixtures = {
        "api": legacy_install.APIInstallTests,
        "worker": legacy_install.WorkerInstallTests,
        "scanner": legacy_install.ScannerInstallTests,
        "identity": legacy_install.IdentityInstallTests,
        "identity-acceptance": legacy_install.IdentityAcceptanceInstallTests,
    }
    modules = {"api": portal_api, "worker": portal_worker, "scanner": portal_scanner,
               "identity": portal_identity, "identity-acceptance": portal_acceptance}

    def component_fixture(self, component):
        fixture = self.fixtures[component]()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        CanonicalInstallTests.configure(self, fixture)
        return fixture

    def test_each_complete_backend_closure_has_one_independent_non_authorizing_installation(self):
        for component in self.fixtures:
            with self.subTest(component=component):
                fixture = self.component_fixture(component)
                manifest, target, payloads, ci = fixture.validate()
                self.assertEqual(target.name, fixture.prefix + "canonical-" + manifest["source_tree"])
                self.assertEqual(set(fixture.policy["components"]), {"DruHustle/onesa-ug:portal:" + component})
                self.assertEqual(portal.canonical_install_files(component), fixture.allowed)
                self.assertEqual(set(portal.SOURCE_ARCHIVES), set(owner.CONSOLIDATED_ARTIFACTS["portal"]))
                self.assertFalse(ci[0]["release_authorized"])
                self.assertTrue(ci[0]["verification_only"])
                self.assertFalse({"signing.pem", "records.sqlite", "trust.json"} & set(payloads))
                if component == "api":
                    self.assertEqual(self.source.baseline_reads, [
                        "repos/DruHustle/onesa-company-portal/git/commits/" + "b" * 40])

    def test_another_component_extra_profile_or_context_allowance_cannot_inherit_source_proof(self):
        for component in self.fixtures:
            with self.subTest(component=component):
                fixture = self.component_fixture(component)
                scope = "DruHustle/onesa-ug:portal:" + component
                profile = fixture.policy["components"][scope]
                for allowance in (True, 2):
                    profile["qualification_attempt_limit"] = allowance
                    fixture.seal()
                    with self.assertRaises(owner.Rejected):
                        fixture.validate()
                profile["qualification_attempt_limit"] = 1
                fixture.policy["components"]["DruHustle/onesa-ug:portal:frontend"] = copy.deepcopy(profile)
                fixture.seal()
                with self.assertRaises(owner.Rejected):
                    fixture.validate()

    def test_runtime_rechecks_complete_original_helper_closure_and_fixed_source_archives(self):
        for component in self.fixtures:
            with self.subTest(component=component):
                fixture = self.component_fixture(component)
                manifest, _target, payloads, ci = fixture.validate()
                parent = fixture.root / "installed"
                parent.mkdir(mode=0o700)
                target = parent / (fixture.prefix + "canonical-" + manifest["source_tree"])
                target.mkdir(mode=0o700)
                profile = next(iter(fixture.policy["components"].values()))
                for item in profile["runners"].values():
                    item["path"] = str(target / "runners" / fixture.script)
                fixture.seal()
                payloads["policy.json"] = (fixture.root / "policy.json").read_bytes()
                for name, data in payloads.items():
                    path = target / name
                    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    path.write_bytes(data)
                    path.chmod(0o600)
                receipt = {"state": "INSTALLED_NOT_COMMISSIONED", "source": manifest["candidate_commit"],
                           "source_tree": manifest["source_tree"], "source_binding": self.source.source,
                           "files": manifest["files"], "policy_sha256": fixture.manifest["policy_sha256"], "ci": ci}
                (target / "installation.json").write_bytes(owner.canonical(receipt))
                (target / "installation.json").chmod(0o600)
                fixture.put("trust.json", owner.canonical({"policy_sha256": fixture.manifest["policy_sha256"]}))
                binding = {**self.source.source, "component": component,
                           "source_sha256": fixture.manifest["tool_source_sha256"]}
                plan = {"verifier_store": str(fixture.root)}

                def fixture_private(path, *, directory=False):
                    path = Path(path)
                    self.assertTrue(path == fixture.root or fixture.root in path.parents)
                    owner.private(path, directory=directory, uid=os.getuid())
                    return path

                with (patch.object(portal, "private", side_effect=fixture_private),
                      patch.object(portal, "VERIFIER", target / "oracle_owner.py"),
                      patch.object(portal, "INSTALL_PARENT", parent)):
                    portal.verify_canonical_component_custody(binding, plan, self.modules[component].CHECKS)
                    for name in ("runners/" + fixture.script, "tool-source.tar",
                                 "source-artifacts/" + next(iter(self.source.archives)) + ".zip"):
                        path = target / name
                        original = path.read_bytes()
                        path.write_bytes(original + b"changed")
                        with self.assertRaises(portal.Refused):
                            portal.verify_canonical_component_custody(binding, plan, self.modules[component].CHECKS)
                        path.write_bytes(original)
                    changed = {**binding, "product_source_tree": "f" * 40}
                    with self.assertRaises(portal.Refused):
                        portal.verify_canonical_component_custody(changed, plan, self.modules[component].CHECKS)

    def test_private_plans_bind_all_source_dimensions_and_preserve_runtime_limits(self):
        for module, legacy in [(portal_api, legacy_api), (portal_worker, legacy_worker),
                               (portal_scanner, legacy_scanner), (portal_identity, legacy_identity)]:
            with self.subTest(component=module.__name__):
                binding, plan = legacy.inputs()
                source = SourceFixture(owner, branch="main").source
                binding.update(source)
                plan.update(schema_version=2, source_binding=copy.deepcopy(source))
                if "workflow" in plan:
                    plan["workflow"]["application_binding"].update(source)
                if module is portal_scanner:
                    directory = str(portal.component_artifact_folder(module.ROOT, binding))
                    plan["recipe"]["directory"] = directory
                    for item in plan["recipe"]["files"]:
                        item["path"] = directory + "/" + Path(item["path"]).name
                legacy.seal(binding, plan)
                self.assertEqual(module.validate_plan(binding, plan), portal.component_artifact_folder(module.ROOT, binding))
                self.assertNotEqual(portal.component_plan_path(binding, module.PLAN), module.PLAN)
                self.assertEqual(owner.lifecycle_scope(binding), "DruHustle/onesa-company-portal:" + binding["component"])
                for key in owner.PORTAL_SOURCE_FIELDS:
                    wrong = copy.deepcopy(plan)
                    wrong["source_binding"].pop(key)
                    legacy.seal(binding, wrong)
                    with self.assertRaises(portal.Refused):
                        module.validate_plan(binding, wrong)
                if "runtime" in plan:
                    plan["runtime"]["privileged"] = True
                    legacy.seal(binding, plan)
                    with self.assertRaises(portal.Refused):
                        module.validate_plan(binding, plan)


class CanonicalDependencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        legacy_identity.SignatureTests.setUpClass()

    def setUp(self):
        fixture = self.fixture = legacy_identity.SignatureTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.source = SourceFixture(owner, branch="main").source
        fixture.binding.update(self.source, component="identity")
        scope = owner.component_scope(fixture.binding)
        profile = copy.deepcopy(next(iter(fixture.policy["components"].values())))
        profile["qualification_attempt_limit"] = 1
        fixture.policy = {"schema_version": 2, "components": {scope: profile}, "toolchain": {
            "source_binding": copy.deepcopy(self.source), "source_commit": self.source["candidate_commit"],
            "source_tree": self.source["source_tree"], "source_sha256": fixture.binding["source_sha256"],
            "source_archives": {name: "a" * 64 for name in owner.CONSOLIDATED_ARTIFACTS["portal"]},
        }}
        fixture.store.policy = fixture.policy
        (fixture.root / "policy.json").write_bytes(owner.canonical(fixture.policy))
        trust = json.loads((fixture.root / "trust.json").read_bytes())
        trust["policy_sha256"] = owner.file_digest(fixture.root / "policy.json")
        (fixture.root / "trust.json").write_bytes(owner.canonical(trust))
        fixture.store.trust = trust
        fixture.commission_fixture()

    def records(self, *, wrong_ci=False):
        fixture = self.fixture
        ci = {"run_id": 123, "run_attempt": 1, "source": copy.deepcopy(self.source),
              "workflow": ".github/workflows/verify.yml", "verification_only": True, "release_authorized": False}
        if wrong_ci:
            ci["source"]["product_source_tree"] = "f" * 40
        context = fixture.store.put("context", fixture.binding, {"ci": [ci]})["record"]
        observation = {"binding": fixture.binding, "environment": "staging",
                       "checks": {name: "PASS" for name in owner.REQUIRED_CHECKS["staging"]}}
        qualified = fixture.store.put("qualification", fixture.binding, {
            "staging": {"observations": observation}, "operations": {"observations": {
                "checks": {name: "PASS" for name in owner.REQUIRED_CHECKS["operations"]}}}},
            parent=context["id"])["record"]
        return {"store": str(fixture.root), "record_id": qualified["id"], "binding": fixture.binding}, context

    def test_real_signed_canonical_dependency_preserves_product_scope_and_revocation(self):
        reference, context = self.records()
        proof = portal_acceptance.signed_dependency(reference, "staging")
        self.assertEqual(proof["operation"], context["id"])
        scope = self.fixture.store.db.execute("SELECT scope FROM records WHERE id=?", (context["id"],)).fetchone()[0]
        self.assertEqual(scope, "DruHustle/onesa-ug:portal:identity")
        self.fixture.store.db.execute("UPDATE records SET revoked=1 WHERE id=?", (context["id"],))
        with self.assertRaises(portal.Refused):
            portal_acceptance.signed_dependency(reference, "staging")

    def test_even_signed_foreign_source_ci_cannot_supply_canonical_dependency_acceptance(self):
        reference, _context = self.records(wrong_ci=True)
        with self.assertRaisesRegex(portal.Refused, "CANONICAL_DEPENDENCY_CI_SCOPE"):
            portal_acceptance.signed_dependency(reference, "staging")

    def test_independent_product_references_cannot_cross_namespaces_or_share_source_policy(self):
        for product, literal, path, component in [
            ("portal", "portal", "onesa-company-portal", "identity"),
            ("ai", "platform", "onesa-ai-platform", "api"),
            ("robot", "robot", "onesa-robot", "api"),
            ("drone", "drone", "onesa-drone", "backend"),
        ]:
            binding = {**self.fixture.binding, "product": literal, "source_path": path, "component": component}
            self.assertEqual(portal_acceptance.dependency_scope(binding, product, "backend"),
                             "DruHustle/onesa-ug:" + literal + ":" + component)
            with self.assertRaises(portal.Refused):
                portal_acceptance.dependency_scope(binding, product, "frontend")
            if product != "portal":
                with self.assertRaises(portal.Refused):
                    portal_acceptance.dependency_binding_valid(binding, self.fixture.policy)
            for key, wrong in [("repository_id", True), ("branch", "staging"),
                               ("source_path", "foreign"), ("component", "identity-api")]:
                with self.subTest(product=product, field=key), self.assertRaises(portal.Refused):
                    portal_acceptance.dependency_scope({**binding, key: wrong}, product, "backend")


class CanonicalExtendedProfileTests(unittest.TestCase):
    def fixture_for(self, identity=False):
        existing = legacy_nvidia.NvidiaInstallTests()
        existing.setUp()
        self.addCleanup(existing.doCleanups)
        fixture = existing.fixture
        if identity:
            files = fixture.github.files
            for local, source in installer.IDENTITY_FRONTEND_ALLOWED.items():
                if local not in installer.NVIDIA_ALLOWED:
                    data = (ROOT / "onesa-company-portal" / source).read_bytes()
                    files[source] = data
                    fixture.put(local, data)
                    fixture.manifest["files"][local] = hashlib.sha256(data).hexdigest()
            tree = legacy_nvidia.snapshot(fixture.root / "synthetic-source", fixture.root / "tool-source.tar", files)
            fixture.manifest["source_tree"] = tree
            fixture.manifest["tool_source_sha256"] = portal.sha(fixture.root / "tool-source.tar")
            fixture.policy["toolchain"].update(source_tree=tree, source_sha256=fixture.manifest["tool_source_sha256"],
                probe_files=portal.probe_source_files({name: hashlib.sha256(data).hexdigest() for name, data in files.items()}, portal.IDENTITY_PROFILE))
            existing.profile["qualification_profile"] = portal.IDENTITY_PROFILE
            for phase in owner.PHASES:
                existing.profile["required_checks"][phase] = sorted(portal.profile_checks(existing.profile, phase))
        CanonicalInstallTests.configure(self, fixture)
        return fixture

    def test_reviewed_extended_frontend_profiles_keep_the_original_baseline_repository(self):
        for identity in [False, True]:
            with self.subTest(identity=identity):
                fixture = self.fixture_for(identity)
                baseline = copy.deepcopy(fixture.policy["toolchain"]["frontend_baseline"])
                _manifest, _target, _payloads, ci = fixture.validate()
                self.assertEqual(self.source.baseline_reads, [
                    "repos/DruHustle/onesa-company-portal/git/commits/" + baseline["source"]])
                self.assertEqual(fixture.policy["toolchain"]["frontend_baseline"], baseline)
                self.assertFalse(ci[0]["release_authorized"])
                fixture.policy["toolchain"]["frontend_baseline"]["source_tree"] = "e" * 40
                fixture.seal()
                with self.assertRaisesRegex(owner.Rejected, "baseline commit/tree differs"):
                    fixture.validate()


class CanonicalStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        legacy_owner.OwnerStoreTests.setUpClass()

    def setUp(self):
        fixture = self.fixture = legacy_owner.OwnerStoreTests()
        # A real lifecycle fixture needs private ancestors on non-root runners,
        # where the legacy Store-only fixture otherwise defaults to /tmp.
        private_temp = legacy_owner.tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(private_temp.cleanup)
        with patch.object(legacy_owner.tempfile, "TemporaryDirectory", return_value=private_temp):
            fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.source = SourceFixture(owner, branch="main")
        self.binding = {**fixture.binding, **self.source.source, "component": "frontend"}
        profile = copy.deepcopy(fixture.policy["components"]["DruHustle/onesa-company-portal:api"])
        profile["qualification_attempt_limit"] = 1
        policy = {"schema_version": 2, "components": {
            "DruHustle/onesa-ug:portal:frontend": profile,
        }, "toolchain": {
            "source_binding": copy.deepcopy(self.source.source),
            "source_commit": self.binding["candidate_commit"],
            "source_tree": self.binding["source_tree"],
            "source_sha256": self.binding["source_sha256"],
            "source_archives": archive_pins(self.source),
        }}
        fixture.store.policy = policy
        fixture.store.github = self.source.github
        self.store = fixture.store
        self.installed = fixture.root / "installed"
        self.installed.mkdir(mode=0o700)
        for name in ["oracle_owner.py", "runtime_lifecycle.py"]:
            (self.installed / name).write_bytes((RELEASE / name).read_bytes())
            (self.installed / name).chmod(0o600)
        directory = self.installed / "source-artifacts"
        directory.mkdir(mode=0o700)
        for name, data in self.source.archives.items():
            (directory / (name + ".zip")).write_bytes(base64.b64decode(data))
            (directory / (name + ".zip")).chmod(0o600)
        self.enterContext(patch.object(owner, "__file__", str(self.installed / "oracle_owner.py")))
        # Route the real lifecycle helper only to this disposable fixture.
        self.lifecycle = owner.lifecycle_module()
        for key, value in {"CONFIG": fixture.root / "lifecycle-config.json",
                           "STATE": fixture.root / "lifecycle-state",
                           "LOCK": fixture.root / "lifecycle-state/lock",
                           "HOLD": fixture.root / "lifecycle-state/hold.json",
                           "OWNER_UID": os.getuid()}.items():
            self.enterContext(patch.object(self.lifecycle, key, value))

    def context(self):
        return self.store.issue_context(self.binding)["record"]["id"]

    def qualification(self):
        return self.store.qualify(self.context())["record"]["id"]

    def authorization(self):
        return self.store.authorize(self.qualification())["record"]["id"]

    def damage_zip(self):
        path = next((self.installed / "source-artifacts").iterdir())
        path.write_bytes(path.read_bytes() + b"changed")

    def test_full_signed_chain_rechecks_source_four_times_with_a_separate_namespace(self):
        result = self.store.deploy(self.authorization())
        self.assertEqual(result["record"]["kind"], "production-verification")
        self.assertEqual(result["record"]["binding"], self.binding)
        self.assertEqual(self.source.calls.count(self.source.prefix.rstrip("/")), 4)
        self.assertEqual({row[0] for row in self.store.db.execute("SELECT scope FROM records")},
                         {"DruHustle/onesa-ug:portal:frontend"})
        self.assertEqual(owner.lifecycle_scope(self.binding), "DruHustle/onesa-company-portal:frontend")
        for (raw,) in self.store.db.execute("SELECT envelope FROM records WHERE kind IN ('context','qualification','authorization')"):
            record = json.loads(raw)["record"]
            self.assertEqual(record["schema_version"], 1)
            self.assertTrue(record["details"]["ci"][0]["verification_only"])
            self.assertFalse(record["details"]["ci"][0]["release_authorized"])
        self.assertEqual((self.fixture.root / "provider-count").read_text(), "1")

    def test_source_only_policy_cannot_issue_any_context(self):
        self.store.policy = copy.deepcopy(self.source.policy)
        with self.assertRaises(owner.Rejected):
            self.context()
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 0)

    def test_changed_pin_is_refused_before_context(self):
        self.damage_zip()
        with self.assertRaises(owner.Rejected):
            self.context()
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 0)

    def test_changed_pin_consumes_reserved_context_before_any_runner(self):
        context = self.context()
        self.damage_zip()
        with self.assertRaises(owner.Rejected):
            self.store.qualify(context)
        self.assertEqual(self.store.db.execute("SELECT state FROM contexts WHERE id=?", (context,)).fetchone()[0], "reserved")
        self.assertFalse((self.fixture.root / "provider-count").exists())

    def test_changed_pin_preserves_pending_owner_decision_without_authorization(self):
        qualification = self.qualification()
        self.damage_zip()
        with self.assertRaises(owner.Rejected):
            self.store.authorize(qualification)
        kinds = [row[0] for row in self.store.db.execute("SELECT kind FROM records")]
        self.assertIn("authorization-attempt", kinds)
        self.assertNotIn("authorization", kinds)

    def test_changed_pin_cannot_reserve_or_repeat_a_provider_request(self):
        authorization = self.authorization()
        self.damage_zip()
        with self.assertRaises(owner.Rejected):
            self.store.deploy(authorization)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM deployments").fetchone()[0], 0)
        self.assertFalse((self.fixture.root / "provider-count").exists())

    def test_current_source_binding_and_finite_allowance_are_not_inherited(self):
        for key, value in [("component", "api"), ("repository_id", 2), ("product", "robot"),
                           ("source_path", "onesa-robot"), ("branch", "staging"),
                           ("source_tree", "d" * 40), ("product_source_tree", "d" * 40),
                           ("source_sha256", "d" * 64)]:
            with self.subTest(key=key), self.assertRaises(owner.Rejected):
                self.store.issue_context({**self.binding, key: value})
        self.context()
        with self.assertRaisesRegex(owner.Rejected, "allowance exhausted"):
            self.context()

    def test_old_controller_hold_is_retained_and_blocks_before_canonical_observation(self):
        self.lifecycle.STATE.mkdir(mode=0o700)
        with self.lifecycle.lifecycle_lock() as guard:
            guard.begin_hold("owner-deploy", "DruHustle/onesa-company-portal:frontend", "retained-old-store:operation")
        original = self.lifecycle.HOLD.read_bytes()
        context = self.context()
        with self.assertRaisesRegex(owner.Rejected, "LIFECYCLE_MAINTENANCE_HOLD"):
            self.store.qualify(context)
        self.assertEqual(self.lifecycle.HOLD.read_bytes(), original)
        self.assertEqual(self.store.db.execute("SELECT state FROM contexts WHERE id=?", (context,)).fetchone()[0], "issued")
        self.assertFalse((self.fixture.root / "provider-count").exists())

    def test_real_lifecycle_refuses_a_writable_ancestor(self):
        ancestor = self.fixture.root / "writable-ancestor"
        ancestor.mkdir(mode=0o700)
        child = ancestor / "private.json"
        child.write_text("{}")
        child.chmod(0o600)
        ancestor.chmod(0o777)
        try:
            with self.assertRaisesRegex(self.lifecycle.LifecycleError, "LIFECYCLE_ANCESTOR_CUSTODY"):
                self.lifecycle.private_path(child)
        finally:
            ancestor.chmod(0o700)


class CanonicalProviderTests(unittest.TestCase):
    def setUp(self):
        self.source = SourceFixture(owner, branch="main")
        self.binding = {**self.source.source, "component": "frontend", "source_sha256": "d" * 64,
                        "target_environment": "production"}

    def test_every_backend_component_retains_the_original_global_lifecycle_hold(self):
        CanonicalStoreTests.setUpClass()
        for component in ("api", "worker", "scanner", "identity", "identity-acceptance"):
            fixture = CanonicalStoreTests()
            fixture.setUp()
            try:
                fixture.binding["component"] = component
                profile = fixture.store.policy["components"].pop("DruHustle/onesa-ug:portal:frontend")
                fixture.store.policy["components"]["DruHustle/onesa-ug:portal:" + component] = profile
                fixture.lifecycle.STATE.mkdir(mode=0o700)
                with fixture.lifecycle.lifecycle_lock() as guard:
                    guard.begin_hold("owner-deploy", "DruHustle/onesa-company-portal:" + component,
                                     "retained-original-store:operation")
                original = fixture.lifecycle.HOLD.read_bytes()
                context = fixture.context()
                with self.subTest(component=component), self.assertRaisesRegex(owner.Rejected, "LIFECYCLE_MAINTENANCE_HOLD"):
                    fixture.store.qualify(context)
                self.assertEqual(fixture.lifecycle.HOLD.read_bytes(), original)
                self.assertEqual(fixture.store.db.execute("SELECT state FROM contexts WHERE id=?", (context,)).fetchone()[0], "issued")
                self.assertFalse((fixture.fixture.root / "provider-count").exists())
            finally:
                fixture.doCleanups()

    def test_project_root_is_exact_without_requiring_an_optional_git_link(self):
        fixture = legacy_frontend.ProviderConfigurationTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.project["rootDirectory"] = portal.frontend_provider_root(self.binding)
        with (patch.object(portal, "read", return_value=fixture.cfg),
              patch.object(portal, "runtime_values", return_value={"PROXY_SHARED_KEY": "s" * 48}),
              patch.object(frontend, "provider", side_effect=fixture.provider)):
            self.assertEqual(frontend.protection(fixture.plan, self.binding)["id"], "prj_fixture")
            self.assertNotIn("link", fixture.project)
            for root in ["onesa-company-portal-frontend", "onesa-robot", "../onesa-company-portal"]:
                fixture.project["rootDirectory"] = root
                with self.subTest(root=root), self.assertRaises(portal.Refused):
                    frontend.protection(fixture.plan, self.binding)

    def test_actual_browser_source_guard_preserves_legacy_and_refuses_foreign_canonical_input(self):
        program = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {assertFrontendSourceBinding:check}=await import(process.argv[1]);
const binding=JSON.parse(fs.readFileSync(0,'utf8'));
check({repository:'DruHustle/onesa-company-portal',component:'frontend'});
check(binding);
for(const [key,value] of Object.entries({schema_version:1,repository:'DruHustle/onesa-robot',repository_id:'1444746154',product:'robot',source_path:'onesa-robot',branch:'staging',component:'api',target_environment:'staging',candidate_commit:'bad',source_tree:'bad',product_source_tree:'bad',source_sha256:'bad'})){
 assert.throws(()=>check({...binding,[key]:value}));
}
for(const key of ['schema_version','repository_id','product','source_path','branch','candidate_commit','source_tree','product_source_tree','source_sha256','target_environment']){
 const missing={...binding};delete missing[key];assert.throws(()=>check(missing));
}
assert.throws(()=>check({repository:'DruHustle/onesa-company-portal',component:'api'}));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", program,
                                 (RELEASE / "oracle_portal_browser_session.mjs").as_uri()],
                                input=json.dumps(self.binding), text=True, capture_output=True,
                                timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_provider_receipt_must_bind_every_canonical_source_dimension(self):
        row = {"id": "dpl_fixture", "projectId": "prj_fixture", "target": "production",
               "regions": ["fra1"], "meta": {"githubCommitSha": self.binding["candidate_commit"],
                                               **frontend.source_metadata(self.binding)}}
        plan = {"project_id": "prj_fixture", "serverless_function_region": "fra1"}
        with patch.object(frontend, "provider", return_value=row):
            self.assertEqual(frontend.check_deployment("dpl_fixture", self.binding, "production", plan), row)
            for key in frontend.source_metadata(self.binding):
                old = row["meta"].pop(key)
                with self.subTest(key=key), self.assertRaises(portal.Refused):
                    frontend.check_deployment("dpl_fixture", self.binding, "production", plan)
                row["meta"][key] = old

    def test_legacy_component_namespace_and_source_identity_remain_unchanged(self):
        legacy = {"repository": "DruHustle/onesa-company-portal", "component": "frontend",
                  "candidate_commit": "a" * 40, "source_tree": "b" * 40, "source_sha256": "c" * 64}
        self.assertEqual(owner.component_scope(legacy), "DruHustle/onesa-company-portal:frontend")
        self.assertEqual(owner.lifecycle_scope(legacy), owner.component_scope(legacy))
        self.assertEqual(portal.frontend_provider_root(legacy), "onesa-company-portal-frontend")
        self.assertEqual(frontend.source_metadata(legacy), {})

    def test_build_receipt_cannot_substitute_any_source_dimension(self):
        binding = {**self.binding, "build_sha256": "2" * 64, "artifact_digest": "sha256:" + "4" * 64}
        plan = {"builds": {}, "builder_sha256": "5" * 64}
        receipts, hashes = {}, {}
        for env, receipt_pin, archive_pin in [("staging", "1" * 64, "3" * 64),
                                               ("production", "2" * 64, "4" * 64)]:
            plan["builds"][env] = {"archive": env + ".tar.gz", "archive_sha256": archive_pin,
                                    "receipt": env + ".json", "receipt_sha256": receipt_pin}
            receipts[env + ".json"] = {"binding": copy.deepcopy(binding), "environment": env,
                "source_tree_verified": True, "provider_credentials_mounted": False,
                "builder_sha256": "5" * 64, "tool_image": "sha256:" + "6" * 64,
                "artifact_sha256": archive_pin}
            hashes[env + ".json"] = receipt_pin
            hashes[env + ".tar.gz"] = archive_pin
        with (patch.object(portal, "trusted_toolchain", return_value={"builder_sha256": "5" * 64,
                                                                      "builder_image": "sha256:" + "6" * 64}),
              patch.object(portal, "read", side_effect=lambda path: receipts[Path(path).name]),
              patch.object(portal, "private", side_effect=lambda path: path),
              patch.object(portal, "sha", side_effect=lambda path: hashes[Path(path).name])):
            portal.validate_frontend_builds(Path("/synthetic"), binding, plan)
            for key in portal.frontend_source_identity(binding):
                candidate = receipts["staging.json"]["binding"]
                old = candidate[key]
                candidate[key] = 3 if type(old) is int else "different"
                with self.subTest(key=key), self.assertRaises(portal.Refused):
                    portal.validate_frontend_builds(Path("/synthetic"), binding, plan)
                candidate[key] = old

    def test_preview_mismatch_is_refused_before_deployment_or_alias_reads(self):
        preview = {"environment": "staging", "binding": copy.deepcopy(self.binding),
                   "deployment_id": "dpl_fixture"}
        plan = {"preview_receipt_path": "/synthetic/preview.json"}
        cfg = {"project_id": "prj_fixture", "staging_origin": "https://preview.invalid"}
        with (patch.object(portal, "read", side_effect=lambda path: cfg if Path(path) == frontend.PROVIDER else preview),
              patch.object(frontend, "protection", return_value={}),
              patch.object(frontend, "provider") as provider):
            for key in portal.frontend_source_identity(self.binding):
                old = preview["binding"][key]
                preview["binding"][key] = 3 if type(old) is int else "different"
                with self.subTest(key=key), self.assertRaises(portal.Refused):
                    frontend.observe_provider(self.binding, "staging", plan, "synthetic-operation")
                preview["binding"][key] = old
            provider.assert_not_called()

    def test_retained_legacy_frontend_remains_a_read_only_exact_source_rollback(self):
        plan = {"project_id": "prj_fixture", "rollback": {"automatic": False},
                "retained_frontend": {"deployment_id": "dpl_legacy", "source": "e" * 40}}
        old = {"id": "dpl_legacy", "projectId": "prj_fixture", "readyState": "READY",
               "meta": {"githubCommitSha": "e" * 40}}
        with patch.object(frontend, "provider", return_value=old) as provider:
            self.assertEqual(portal.verify_rollback_frontend(plan), {"deployment_id": "dpl_legacy", "source": "e" * 40})
            provider.assert_called_once_with("/v13/deployments/dpl_legacy")
            old["meta"]["githubCommitSha"] = "f" * 40
            with self.assertRaises(portal.Refused):
                portal.verify_rollback_frontend(plan)


class CanonicalBuildTests(unittest.TestCase):
    def test_product_relative_build_retains_original_canonical_provider_metadata(self):
        fixture = CanonicalInstallTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        product = fixture.fixture.root / "synthetic-source"
        (product / "onesa-company-portal-frontend/vercel.json").write_text('{"regions":["fra1"]}')
        subprocess.run(["git", "-C", str(product), "add", "."], check=True, capture_output=True)
        tree = subprocess.check_output(["git", "-C", str(product), "write-tree"], text=True).strip()
        archive = subprocess.check_output(["git", "-C", str(product), "archive", tree])
        folder = fixture.fixture.root / "build-input"
        folder.mkdir(mode=0o700)
        (folder / "source.tar").write_bytes(archive)
        binding = {**fixture.source.source, "product_source_tree": tree, "component": "frontend",
                   "target_environment": "production", "source_sha256": hashlib.sha256(archive).hexdigest()}
        metadata = {"projectId": "prj_fixture", "orgId": "team_fixture", "projectName": "fixture",
                    "settings": {"framework": "nextjs", "rootDirectory": portal.frontend_provider_root(binding),
                                 "nodeVersion": "24.x", "buildCommand": None,
                                 "installCommand": None, "outputDirectory": None},
                    "public_environment": {"BACKEND_URL": portal.API_ORIGINS["staging"],
                                           "SITE_URL": "https://onesa.eu", "PUBLIC_RELEASE_ENABLED": "false"}}
        original = copy.deepcopy(metadata)
        tool = "sha256:" + "7" * 64
        calls = []

        def container(args, **kwargs):
            # A deterministic container protocol fixture; no build or TLS test
            # success is claimed for an actual image by this contract test.
            calls.append(args)
            if args[1:3] == ["image", "inspect"]:
                return subprocess.CompletedProcess(args, 0, json.dumps([{
                    "Id": tool, "Architecture": "amd64", "Config": {"Labels": {"org.onesa.vercel-cli": builder.CLI}},
                }]).encode())
            if "build" in args:
                work = Path(next(value.removesuffix(":/workspace:rw") for value in args if value.endswith(":/workspace:rw")))
                local = json.loads((work / ".vercel/project.json").read_bytes())
                self.assertEqual(local["settings"]["rootDirectory"], "onesa-company-portal-frontend")
                output = work / ".vercel/output"
                (output / "static").mkdir(parents=True)
                (output / "config.json").write_text('{"version":3}')
                (output / "static/app.js").write_text("/* synthetic prebuilt contract fixture */")
                return subprocess.CompletedProcess(args, 0)
            self.assertIn("/workspace/scripts/check_tls_bundle.mjs", args)
            return subprocess.CompletedProcess(args, 0, b'{"actual_vercel_functions":2,"browser_policy_leaks":0}')

        with patch.object(builder.subprocess, "run", side_effect=container):
            receipt = builder.build(folder, binding, metadata, tool, environment="staging")
        self.assertEqual(len(calls), 3)
        self.assertEqual(metadata, original)
        self.assertEqual(receipt["binding"], binding)
        self.assertEqual(receipt["metadata_sha256"], hashlib.sha256(portal.canonical(original)).hexdigest())
        with tarfile.open(receipt["artifact_path"]) as output:
            saved = json.loads(output.extractfile(".vercel/project.json").read())
        self.assertEqual(saved["settings"], original["settings"])
        receipt_path = next(folder.glob("build-*-complete.json"))
        destination = folder / "prebuilt-check"
        destination.mkdir(mode=0o700)
        build = {"receipt": receipt_path.name, "archive": Path(receipt["artifact_path"]).name}
        real_read = portal.read

        def fixture_file(path):
            # /tmp is deliberately not a production custody ancestor. This
            # protocol fixture permits only its own regular, private files;
            # owner/ancestor refusal is covered by the existing custody suite.
            path = Path(path)
            self.assertTrue(path.resolve().is_relative_to(folder))
            self.assertTrue(path.is_file() and not path.is_symlink())
            self.assertEqual(path.stat().st_mode & 0o077, 0)
            return path

        with (patch.object(portal, "private", side_effect=fixture_file),
              patch.object(portal, "read", side_effect=lambda path: {"project_id": "prj_fixture", "team_id": "team_fixture"}
                           if Path(path) == frontend.PROVIDER else real_read(path))):
            frontend.unpack(folder, build, destination, {"serverless_function_region": "fra1"}, binding)
        self.assertTrue((destination / original["settings"]["rootDirectory"]).is_dir())
        self.assertFalse((destination / "onesa-company-portal-frontend").exists())


if __name__ == "__main__":
    unittest.main()
