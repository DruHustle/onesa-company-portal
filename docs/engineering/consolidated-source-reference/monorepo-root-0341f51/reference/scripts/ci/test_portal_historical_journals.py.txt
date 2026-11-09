"""Real retained Ed25519 journals across distinct immutable verifier versions.

Only disposable files and signatures are used. No historical code is imported,
no provider is contacted, and the reader never opens an issuing Store.
"""

import copy
import json
import os
from pathlib import Path
import stat
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "onesa-company-portal/scripts/release"
sys.path.insert(0, str(RELEASE))
import oracle_owner as owner
import oracle_portal as portal
import oracle_portal_api as api
import oracle_portal_worker as worker
import oracle_portal_scanner as scanner
import test_oracle_owner as owner_fixture
from test_oracle_portal_nvidia import snapshot
from test_source_consumer import SourceFixture

REAL_READ = portal.read


def write_fixture(path, value):
    path.write_bytes(portal.canonical(value))
    path.chmod(0o600)


class HistoricalJournalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        owner_fixture.OwnerStoreTests.setUpClass()

    def fixture(self, component="api", *, consolidated=False):
        fixture = owner_fixture.OwnerStoreTests()
        private_temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(private_temp.cleanup)
        with patch.object(owner_fixture.tempfile, "TemporaryDirectory", return_value=private_temp):
            fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.store.db.close()
        fixture.binding["component"] = component
        mapping = portal.canonical_install_files(component)
        # Retained old closures genuinely lack later helpers. The reader must
        # compare their original bytes, never demand an upgraded installation.
        mapping = {local: upstream for local, upstream in mapping.items() if local not in {
            "runtime_lifecycle.py", "runners/oracle_portal_browser_session.mjs",
            "runners/oracle_portal_api_recovery.py",
        }}
        files = {upstream: (ROOT / "onesa-company-portal" / upstream).read_bytes()
                 for upstream in mapping.values()}
        for name in ("src/config/products.ts", "src/components/home-products.tsx"):
            files["onesa-company-portal-frontend/" + name] = b"// retained synthetic source\n"
        archive = fixture.root / "retained-source.tar"
        source_root = fixture.root / "source"
        source_root.mkdir(mode=0o700)
        subprocess.run(["git", "init", "--quiet", str(source_root)], check=True, capture_output=True)
        tree = snapshot(source_root, archive, files)
        fixture.binding.update(source_tree=tree, source_sha256=portal.sha(archive))
        tool = {"source_commit": fixture.binding["candidate_commit"],
                "source_tree": tree, "source_sha256": portal.sha(archive)}
        if consolidated:
            source = SourceFixture(owner, branch="main").source
            source["product_source_tree"] = tree
            fixture.binding.update(source)
            tool.update(source_commit=source["candidate_commit"], source_tree=source["source_tree"],
                        source_binding=copy.deepcopy(source))
        parent = fixture.root / "installations"
        parent.mkdir(mode=0o700)
        directory = parent / ("portal-" + component
                             + ("-canonical-" if consolidated else "-") + tool["source_tree"])
        directory.mkdir(mode=0o700)
        (directory / "runners").mkdir(mode=0o700)
        pins = {}
        for local, upstream in mapping.items():
            path = directory / local
            path.write_bytes(files[upstream])
            path.chmod(0o600)
            pins[local] = portal.sha(path)
        (directory / "tool-source.tar").write_bytes(archive.read_bytes())
        (directory / "tool-source.tar").chmod(0o600)
        profile = copy.deepcopy(next(iter(fixture.policy["components"].values())))
        profile["qualification_attempt_limit"] = 1
        script = "runners/oracle_portal_" + component + ".py"
        for phase in owner.PHASES:
            profile["runners"][phase].update(path=str(directory / script), sha256=pins[script])
        fixture.policy = {"schema_version": 2 if consolidated else 1,
                          "components": {owner.component_scope(fixture.binding): profile},
                          "toolchain": tool}
        for destination in (fixture.root / "policy.json", directory / "policy.json"):
            write_fixture(destination, fixture.policy)
        trust = json.loads((fixture.root / "trust.json").read_bytes())
        trust.update(policy_sha256=portal.sha(fixture.root / "policy.json"),
                     runner_root=str(directory / "runners"))
        write_fixture(fixture.root / "trust.json", trust)
        receipt = {"state": "INSTALLED_NOT_COMMISSIONED", "repository": fixture.binding["repository"],
                   "source": tool["source_commit"], "source_tree": tool["source_tree"],
                   "files": pins, "policy_sha256": trust["policy_sha256"], "provider_requests": 0}
        if consolidated:
            receipt["source_binding"] = copy.deepcopy(tool["source_binding"])
        write_fixture(directory / "installation.json", receipt)
        fixture.commission_fixture()
        fixture.store = fixture.open()
        self.addCleanup(fixture.store.db.close)
        new_verifier = fixture.root / "new-verifier.py"
        new_verifier.write_bytes((directory / "oracle_owner.py").read_bytes() + b"\n# new installation\n")
        new_verifier.chmod(0o600)
        def fixture_custody(path, *, directory=False):
            # Substitute only the unprivileged disposable root boundary. Real
            # file type, owner, permissions, hardlink and alias checks remain.
            path = Path(path)
            portal.require(path.is_absolute() and
                (path == fixture.root or fixture.root in path.parents), "FIXTURE_CUSTODY_SCOPE")
            parents = list(path.parents)
            selected = ([path, *parents[:parents.index(fixture.root) + 1]]
                        if path != fixture.root else [path])
            portal.require(not any(item.is_symlink() for item in selected), "CUSTODY_PATH_ALIAS")
            info = path.stat()
            portal.require((stat.S_ISDIR(info.st_mode) if directory else
                stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                and all(item.stat().st_uid == os.getuid() and item.stat().st_mode & 0o077 == 0
                        for item in selected), "PRIVATE_CUSTODY_REQUIRED")
            return path

        self.enterContext(patch.object(portal, "private", side_effect=fixture_custody))
        self.enterContext(patch.object(portal, "read", side_effect=lambda path:
            REAL_READ(fixture.anchor if str(path) == "/etc/onesa/oracle-release-trust.json" else path)))
        self.enterContext(patch.object(portal, "INSTALL_PARENT", parent))
        self.enterContext(patch.object(portal, "VERIFIER", new_verifier))
        fixture.directory, fixture.receipt = directory, receipt
        return fixture

    def journal(self, fixture, *, accepted=True):
        store, binding = fixture.store, fixture.binding
        context = store.put("context", binding, {"ci": [{"run_id": 123}]})["record"]
        qualification = store.put("qualification", binding, {}, parent=context["id"])["record"]
        authorization = store.put("authorization", binding, {}, parent=qualification["id"])["record"]
        intent = store.put("deployment-intent", binding,
                           {"provider_request_budget": 1, "automatic_retry": False},
                           parent=authorization["id"])["record"]
        state = "accepted" if accepted else "request-recorded"
        store.db.execute("INSERT INTO deployments(id,authorization,qualification,state) VALUES(?,?,?,?)",
                         (intent["id"], authorization["id"], qualification["id"], state))
        if accepted:
            store.put("production-verification", binding, {}, parent=intent["id"])
        root = fixture.root / "journal"
        root.mkdir(mode=0o700)
        (root / "deployments").mkdir(mode=0o700)
        path = root / "deployments" / intent["id"]
        path.mkdir(mode=0o700)
        request = {"binding": binding, "context": {"operation_id": intent["id"],
                   "authorization_id": authorization["id"]}, "verifier_store": str(fixture.root),
                   "request_budget": 1, "automatic_retry": False}
        write_fixture(path / "scanner-override.json", {"services": {"scanner": {"image": binding["artifact_digest"]}}})
        request["override_sha256"] = portal.sha(path / "scanner-override.json")
        write_fixture(path / "request.json", request)
        fixture.journal_root, fixture.operation, fixture.request = root, intent, request
        return path

    def observe(self, fixture, *, accepted=True):
        return portal.verify_historical_operation(fixture.binding, fixture.operation["id"],
                                                   str(fixture.root), require_accepted=accepted)

    def test_real_legacy_and_canonical_journals_survive_verifier_change_without_new_authority(self):
        for component, consolidated in [("api", False), ("worker", False),
                                        ("scanner", False), ("api", True)]:
            with self.subTest(component=component, consolidated=consolidated):
                fixture = self.fixture(component, consolidated=consolidated)
                self.journal(fixture)
                before = {name: portal.sha(fixture.root / name) for name in
                          ("records.sqlite", "trust.json", "policy.json", "fixture-anchor.json", "signing.pem")}
                with self.assertRaisesRegex(portal.Refused, "ISSUER_CUSTODY_PIN_CHANGED"):
                    portal.verify_invocation(fixture.binding,
                        {"operation_id": fixture.operation["id"], "read_only": True}, "production",
                        {"verifier_store": str(fixture.root)}, dependency=True)
                module = {"api": api, "worker": worker, "scanner": scanner}[component]
                read_bytes = Path.read_bytes

                def public_record_bytes(path):
                    self.assertNotEqual(path.name, "signing.pem", "reader must not access signing keys")
                    return read_bytes(path)

                with (patch.object(owner, "Store", side_effect=AssertionError("must not open issuing Store")),
                      patch.object(portal, "docker", side_effect=AssertionError("no provider operation")),
                      patch.object(Path, "read_bytes", public_record_bytes),
                      patch.object(module, "ROOT", fixture.journal_root)):
                    module.previous_operations()
                self.assertEqual(before, {name: portal.sha(fixture.root / name) for name in before})
                self.assertNotEqual(portal.sha(portal.VERIFIER), fixture.store.trust["verifier_sha256"])

    def test_unaccepted_legacy_request_remains_a_global_hold_for_each_component(self):
        for component, module in [("api", api), ("worker", worker), ("scanner", scanner)]:
            with self.subTest(component=component):
                fixture = self.fixture(component)
                self.journal(fixture, accepted=False)
                with (patch.object(module, "ROOT", fixture.journal_root),
                      self.assertRaisesRegex(portal.Refused, "ACCEPTED_API_VERIFICATION_REQUIRED")):
                    module.previous_operations()

    def test_revocation_in_an_accepted_original_chain_still_blocks(self):
        fixture = self.fixture()
        self.journal(fixture)
        context = fixture.store.db.execute("SELECT id FROM records WHERE kind='context'").fetchone()[0]
        fixture.store.db.execute("UPDATE records SET revoked=1 WHERE id=?", (context,))
        with self.assertRaisesRegex(portal.Refused, "SIGNED_LEDGER_RECORD_MISSING_OR_REVOKED"):
            self.observe(fixture)

    def test_original_anchor_key_policy_helpers_source_and_installation_remain_required(self):
        fixture = self.fixture()
        self.journal(fixture)
        for path in [fixture.anchor, fixture.root / "public.pem", fixture.root / "policy.json",
                     fixture.directory / "oracle_owner.py", fixture.directory / "runners/oracle_portal_api.py",
                     fixture.directory / "policy.json", fixture.directory / "tool-source.tar"]:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                if path == fixture.anchor:
                    anchor = json.loads(original)
                    anchor["installations"][str(fixture.root)]["active"] = False
                    write_fixture(path, anchor)
                else:
                    path.write_bytes(original + b"\nchanged\n")
                with self.assertRaises(portal.Refused):
                    self.observe(fixture)
                path.write_bytes(original)
        path = fixture.directory / "oracle_owner.py"
        original = path.read_bytes()
        path.unlink()
        path.symlink_to(portal.VERIFIER)
        with self.assertRaisesRegex(portal.Refused, "CUSTODY_PATH_ALIAS"):
            self.observe(fixture)
        path.unlink()
        path.write_bytes(original)
        path.chmod(0o600)

    def test_receipt_cannot_select_unknown_paths_or_replace_original_source_identity(self):
        fixture = self.fixture()
        self.journal(fixture)
        for field, value in [("repository", "DruHustle/onesa-robot"), ("source_tree", "f" * 40),
                             ("source", "e" * 40), ("policy_sha256", "0" * 64)]:
            changed = copy.deepcopy(fixture.receipt)
            changed[field] = value
            write_fixture(fixture.directory / "installation.json", changed)
            with self.subTest(field=field), self.assertRaises(portal.Refused):
                self.observe(fixture)
        for local in ["../oracle_owner.py", "/foreign/helper.py", "runners/foreign.py"]:
            changed = copy.deepcopy(fixture.receipt)
            changed["files"][local] = "a" * 64
            write_fixture(fixture.directory / "installation.json", changed)
            with self.subTest(path=local), self.assertRaises(portal.Refused):
                self.observe(fixture)

    def test_signed_record_mutation_is_not_authorized_by_the_historical_reader(self):
        fixture = self.fixture()
        self.journal(fixture)
        operation = fixture.operation["id"]
        row = fixture.store.db.execute("SELECT envelope FROM records WHERE id=?", (operation,)).fetchone()[0]
        envelope = json.loads(row)
        envelope["record"]["details"]["automatic_retry"] = True
        fixture.store.db.execute("UPDATE records SET envelope=? WHERE id=?", (portal.canonical(envelope).decode(), operation))
        with self.assertRaisesRegex(portal.Refused, "PINNED_COMMAND_FAILED"):
            self.observe(fixture)

    def test_unaccepted_reader_cannot_be_selected_for_api_worker_or_current_invocation(self):
        fixture = self.fixture()
        self.journal(fixture, accepted=False)
        for component in ("api", "worker", "frontend"):
            with self.subTest(component=component), self.assertRaisesRegex(portal.Refused, "HISTORICAL_ACCEPTANCE_SCOPE"):
                portal.verify_historical_operation({**fixture.binding, "component": component},
                    fixture.operation["id"], str(fixture.root), require_accepted=False)
        with self.assertRaises(TypeError):
            portal.verify_invocation(fixture.binding, {}, "deploy", {}, historical_custody=True)

    def test_scanner_completed_revocation_is_read_without_accepting_or_replaying_old_operation(self):
        fixture = self.fixture("scanner")
        path = self.journal(fixture, accepted=False)
        next_binding = {**fixture.binding, **SourceFixture(owner, branch="main").source,
                        "candidate_commit": "f" * 40, "source_tree": "e" * 40}
        write_fixture(path / "provider-command-result.json", {
            "operation_id": path.name, "returncode": 0, "observed_at": portal.now().isoformat(),
            "automatic_retry": False})
        fixture.store.put("revocation", fixture.binding, {"revoked_id": path.name})
        fixture.store.db.execute("UPDATE records SET revoked=1 WHERE id=?", (path.name,))
        before = portal.sha(fixture.root / "records.sqlite")
        with (patch.object(scanner, "ROOT", fixture.journal_root),
              patch.object(owner, "Store", side_effect=AssertionError("must not open issuing Store"))):
            scanner.previous_operations(next_binding)
        self.assertEqual(portal.sha(fixture.root / "records.sqlite"), before)
        self.assertEqual(fixture.store.db.execute("SELECT state FROM deployments").fetchone()[0], "request-recorded")
        self.assertFalse(scanner.acknowledged_completed_request(path, fixture.request, fixture.binding))
        result = portal.read(path / "provider-command-result.json")
        result["returncode"] = 1
        write_fixture(path / "provider-command-result.json", result)
        with self.assertRaisesRegex(portal.Refused, "PREVIOUS_SCANNER_PROVIDER_OUTCOME_UNRESOLVED"):
            scanner.acknowledged_completed_request(path, fixture.request, next_binding)

    def test_scanner_needs_signed_explicit_revocation_and_exact_retained_request(self):
        fixture = self.fixture("scanner")
        path = self.journal(fixture, accepted=False)
        next_binding = {**fixture.binding, "candidate_commit": "f" * 40, "source_tree": "e" * 40}
        write_fixture(path / "provider-command-result.json", {
            "operation_id": path.name, "returncode": 0, "observed_at": portal.now().isoformat(),
            "automatic_retry": False})
        fixture.store.db.execute("UPDATE records SET revoked=1 WHERE id=?", (path.name,))
        with self.assertRaisesRegex(portal.Refused, "SIGNED_COMPLETED_SCANNER_REVOCATION_MISSING"):
            scanner.acknowledged_completed_request(path, fixture.request, next_binding)
        fixture.store.put("revocation", fixture.binding, {"revoked_id": path.name})
        changed = {**fixture.request, "request_budget": 2}
        with self.assertRaisesRegex(portal.Refused, "PREVIOUS_SCANNER_REQUEST_IDENTITY_CHANGED"):
            scanner.acknowledged_completed_request(path, changed, next_binding)


if __name__ == "__main__":
    unittest.main()
