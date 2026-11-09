"""Exercise source pinning and publication boundaries with real disposable Git."""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from config import PRODUCTS, ROOT
from materialize_docs_source import materialize, safe_relative
from product_security import export_product
from runtime_manifest import source_identity
from test_boundaries import command, commit, initialize, module

sys.path.insert(0, str(ROOT / "scripts"))
hygiene = module(ROOT / "scripts/repository_hygiene.py", "root_hygiene")


class ContractSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        initialize(self.root)
        source = self.root / "docs/contract.md"
        source.parent.mkdir()
        source.write_text("reviewed public contract\n")
        (source.parent / "unlisted.md").write_text("must never materialize\n")
        self.revision = commit(self.root)
        self.manifest = (
            self.root / "onesa-ai-platform/docs/ecosystem/source-revisions.json"
        )
        self.manifest.parent.mkdir(parents=True)
        self.record = {
            "repository": "https://github.com/DruHustle/onesa-company-portal",
            "commit": self.revision,
            "sources": {
                "docs/contract.md": hashlib.sha256(source.read_bytes()).hexdigest()
            },
        }
        self.destination = self.root / "onesa-ai-platform/data/docs-sources/portal"

    def write_manifest(self):
        self.manifest.write_text(json.dumps({"onesa-company-portal": self.record}))

    def test_reads_only_digest_pinned_files_from_preserved_ancestor(self):
        self.write_manifest()
        (self.root / "docs/contract.md").write_text("changed current source\n")
        commit(self.root)
        materialize(self.root, "portal")
        self.assertEqual(
            (self.destination / "docs/contract.md").read_text(),
            "reviewed public contract\n",
        )
        self.assertFalse((self.destination / "docs/unlisted.md").exists())
        with self.assertRaises(ValueError):
            materialize(self.root, "portal")

    def test_mismatched_digest_writes_no_partial_inventory(self):
        self.record["sources"]["docs/unlisted.md"] = "0" * 64
        self.write_manifest()
        with self.assertRaises(ValueError):
            materialize(self.root, "portal")
        self.assertFalse(self.destination.exists())

    def test_rejects_wrong_identity_unpinned_revision_and_alias_destination(self):
        for field, value in (
            ("repository", "https://github.com/someone/onesa-company-portal"),
            ("commit", "main"),
            ("commit", None),
        ):
            previous = self.record[field]
            self.record[field] = value
            self.write_manifest()
            with self.assertRaises(ValueError):
                materialize(self.root, "portal")
            self.record[field] = previous
        self.write_manifest()
        data = self.root / "onesa-ai-platform/data"
        data.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            materialize(self.root, "portal")

    def test_rejects_traversal_absolute_noncanonical_or_control_paths(self):
        for value in (
            "../private.md",
            "/tmp/private.md",
            "docs//a.md",
            ".git/config",
            "docs/../a.md",
            "a\nb",
            "",
            None,
        ):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                safe_relative(value)


class RuntimeProvenanceTests(unittest.TestCase):
    def test_manifest_binds_origin_revision_product_tree_and_clean_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initialize(root)
            command(
                root,
                "remote",
                "add",
                "origin",
                "https://github.com/DruHustle/onesa-ug.git",
            )
            path = root / "onesa-robot/source.txt"
            path.parent.mkdir()
            path.write_text("public source\n")
            revision = commit(root)
            environment = {
                "GITHUB_REPOSITORY": "DruHustle/onesa-ug",
                "GITHUB_SHA": revision,
            }
            git = lambda *args: command(root, *args)
            record = source_identity("robot", environment, git)
            self.assertTrue(record["verification_only"])
            self.assertFalse(record["release_authorized"])
            self.assertEqual(record["candidate_commit"], revision)
            self.assertEqual(
                record["product_source_tree"],
                command(root, "rev-parse", "HEAD:onesa-robot"),
            )
            for key, value in (
                ("GITHUB_REPOSITORY", "DruHustle/onesa-robot"),
                ("GITHUB_SHA", "a" * 40),
            ):
                with self.assertRaises(ValueError):
                    source_identity("robot", {**environment, key: value}, git)
            path.write_text("unverified source\n")
            with self.assertRaises(ValueError):
                source_identity("robot", environment, git)
            command(root, "checkout", "--", "onesa-robot")
            command(
                root,
                "remote",
                "set-url",
                "origin",
                "https://github.com/someone/onesa-ug.git",
            )
            with self.assertRaises(ValueError):
                source_identity("robot", environment, git)


class PublicationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        initialize(self.root)
        for product in PRODUCTS.values():
            scanner = self.root / product / "scripts/repository_hygiene.py"
            scanner.parent.mkdir(parents=True)
            scanner.write_bytes(
                (ROOT / product / "scripts/repository_hygiene.py").read_bytes()
            )
        commit(self.root)

    def test_staged_secret_cannot_hide_behind_clean_working_copy(self):
        path = self.root / "onesa-drone/source.txt"
        credential = "ghp_" + "A" * 36
        path.write_text(credential + "\n")
        command(self.root, "add", "onesa-drone/source.txt")
        path.write_text("clean working copy\n")
        findings = hygiene.scan(self.root)
        self.assertTrue(
            any(
                row["scope"] == "index" and row["rule"] == "github-token"
                for row in findings
            )
        )
        self.assertNotIn(credential, json.dumps(findings))

    def test_root_private_paths_and_product_aliases_fail_closed(self):
        private = self.root / "private/record.txt"
        private.parent.mkdir()
        private.write_text("synthetic private fixture\n")
        alias = self.root / "onesa-drone/alias.txt"
        alias.symlink_to(private)
        findings = hygiene.scan(self.root)
        self.assertTrue(
            any(
                row["path"] == "private/record.txt"
                and row["rule"] == "restricted-or-generated-path"
                for row in findings
            )
        )
        self.assertTrue(
            any(
                row["path"] == "onesa-drone/alias.txt"
                and row["rule"] == "source-alias-or-gitlink"
                for row in findings
            )
        )

    def test_product_scope_and_ancestor_boundaries_are_explicit(self):
        path = self.root / "onesa-drone/private/file.txt"
        path.parent.mkdir()
        path.write_text("synthetic private fixture\n")
        self.assertTrue(hygiene.scan(self.root, "onesa-drone"))
        self.assertEqual(hygiene.scan(self.root, "onesa-robot"), [])
        with self.assertRaises(ValueError):
            hygiene.validate_root(self.root / "onesa-drone")
        with self.assertRaises(ValueError):
            hygiene.scan(self.root, "unknown")

    def test_security_export_preserves_product_git_namespace_and_public_files(self):
        product = self.root / "onesa-drone"
        (product / ".gitignore").write_text("ignored.txt\n")
        (product / "source.txt").write_text("public source\n")
        (product / "ignored.txt").write_text("excluded local fixture\n")
        with tempfile.TemporaryDirectory() as destination:
            exported = export_product(Path(destination), "drone", self.root)
            self.assertEqual(
                Path(command(exported, "rev-parse", "--show-toplevel")), exported
            )
            self.assertEqual((exported / "source.txt").read_text(), "public source\n")
            self.assertFalse((exported / "ignored.txt").exists())
            self.assertTrue((exported / "scripts/repository_hygiene.py").is_file())

    def test_security_export_refuses_source_aliases(self):
        (self.root / "onesa-drone/alias.txt").symlink_to(
            self.root / "onesa-robot/scripts/repository_hygiene.py"
        )
        with (
            tempfile.TemporaryDirectory() as destination,
            self.assertRaises(ValueError),
        ):
            export_product(Path(destination), "drone", self.root)

    def test_history_finds_deleted_credentials_in_arbitrary_root_paths(self):
        imported = command(self.root, "rev-parse", "HEAD")
        source = self.root / "render.yaml"
        credential = "ghp_" + "B" * 36
        source.write_text(credential + "\n")
        commit(self.root)
        source.unlink()
        commit(self.root)
        with patch.object(
            hygiene, "IMPORTED_HEADS", {name: imported for name in PRODUCTS.values()}
        ):
            findings = hygiene.scan(self.root, history=True)
        self.assertTrue(
            any(
                row["scope"].startswith("history:")
                and row["path"] == "render.yaml"
                and row["rule"] == "github-token"
                for row in findings
            )
        )
        self.assertNotIn(credential, json.dumps(findings))


if __name__ == "__main__":
    unittest.main()
