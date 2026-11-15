"""Documentation negative gates use isolated synthetic repositories."""

import tempfile
import unittest
from pathlib import Path

from check_repository_docs import check


class RepositoryDocumentationTests(unittest.TestCase):
    def fixture(self, root):
        (root / "AGENTS.md").write_text("# Engineering policies\n")
        (root / "README.md").write_text("# Synthetic product\n")
        (root / "CHANGELOG.md").write_text(
            "# Changelog\nThis project is undergoing initial setup and production qualification.\n"
        )

    def test_valid_setup_has_no_invented_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            self.assertEqual(check(root), [])

    def test_agents_policy_size_guard_is_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "AGENTS.md").write_text("x" * (12 * 1024 + 1))
            self.assertTrue(any("12 KiB guard" in issue for issue in check(root)))

    def test_account_ownership_table_rejects_literal_escaped_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            guide = root / "docs/engineering/ONESA_ACCOUNT.md"
            guide.parent.mkdir(parents=True)
            guide.write_text("| Component | Responsibility |\\n| Onesa Identity | Accounts |")
            self.assertTrue(any("malformed escaped newline" in issue for issue in check(root)))
            guide.write_text("| Component | Responsibility |\n| Onesa Identity | Accounts |")
            self.assertEqual(check(root), [])

    def test_obsolete_policy_generator_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "SECURITY.md").write_text("generated obsolete policy")
            self.assertTrue(any("recreated" in issue for issue in check(root)))

    def test_broken_relative_link_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "README.md").write_text("[Setup](missing-setup.md)")
            self.assertTrue(any("broken local link" in issue for issue in check(root)))

    def test_unknown_public_classification_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            public = root / "docs/public"
            public.mkdir(parents=True)
            (public / "unclassified.md").write_text("# Confidential source")
            self.assertTrue(any("public classification" in issue for issue in check(root)))

    def test_unsubstantiated_baseline_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "CHANGELOG.md").write_text("First verified protected governance deployment v1.0.0")
            self.assertTrue(any("provenance" in issue for issue in check(root)))


if __name__ == "__main__":
    unittest.main()
