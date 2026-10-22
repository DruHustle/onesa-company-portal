"""Synthetic APT fixtures; never modify a workstation or production host."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import browser_dependencies as browser


class BrowserDependenciesTests(unittest.TestCase):
    def test_legacy_preserves_suites_components_keys_and_other_hosts(self):
        text = (
            "# http://azure.archive.ubuntu.com/ubuntu/ remains a comment\n"
            "deb [arch=amd64 signed-by=/keys/ubuntu.gpg] "
            "http://azure.archive.ubuntu.com/ubuntu/ noble-updates main universe\n"
            "deb https://packages.microsoft.com/ubuntu noble main\n"
        )
        result, count = browser.rewrite_sources(text)
        self.assertEqual(count, 1)
        self.assertEqual(
            result,
            text.replace(
                "http://azure.archive.ubuntu.com/ubuntu/ noble-updates",
                "https://archive.ubuntu.com/ubuntu/ noble-updates",
            ),
        )

    def test_deb822_preserves_all_non_uri_fields_and_continuations(self):
        text = (
            "Types: deb deb-src\nURIs: http://azure.archive.ubuntu.com/ubuntu/\n"
            " https://archive.ubuntu.com/ubuntu/\n"
            "Suites: noble noble-updates noble-security\n"
            "Components: main restricted universe multiverse\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        )
        result, count = browser.rewrite_sources(text, True)
        self.assertEqual(count, 1)
        self.assertEqual(
            result,
            text.replace(
                "http://azure.archive.ubuntu.com/ubuntu/",
                "https://archive.ubuntu.com/ubuntu/",
            ),
        )

    def test_lookalike_host_is_unchanged(self):
        text = "deb https://azure.archive.ubuntu.com.example/ubuntu noble main\n"
        self.assertEqual(browser.rewrite_sources(text), (text, 0))

    def test_credentialed_or_unexpected_mirror_is_rejected(self):
        for uri in [
            "https://user:password@azure.archive.ubuntu.com/ubuntu",
            "https://azure.archive.ubuntu.com:444/ubuntu",
            "https://azure.archive.ubuntu.com/other",
            "https://azure.archive.ubuntu.com/ubuntu?override=1",
        ]:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                browser.rewrite_sources("deb " + uri + " noble main\n")

    def test_refuses_local_persistent_and_unrelated_runner(self):
        for values in [
            {},
            {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted"},
            {
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux",
                "GITHUB_REPOSITORY": "someone/else",
            },
        ]:
            with (
                patch.dict(os.environ, values, clear=True),
                self.assertRaises(ValueError),
            ):
                browser.require_runner()

    def test_accepts_only_the_expected_disposable_root_runner(self):
        values = {
            "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux",
            "GITHUB_REPOSITORY": "DruHustle/onesa-company-portal",
        }
        with (
            patch.dict(os.environ, values, clear=True),
            patch.object(browser.platform, "system", return_value="Linux"),
            patch.object(browser.os, "geteuid", return_value=0),
        ):
            browser.require_runner()

    def fixture(self, root):
        apt = root / "etc/apt"
        (apt / "sources.list.d").mkdir(parents=True)
        (apt / "apt.conf.d").mkdir()
        source = apt / "sources.list.d/ubuntu.sources"
        source.write_text(
            "URIs: http://azure.archive.ubuntu.com/ubuntu/\n"
            "Suites: noble noble-security\nSigned-By: /keys/ubuntu.gpg\n"
        )
        source.chmod(0o644)
        return apt, source

    def test_fixture_rewrite_is_idempotent_and_config_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            first = browser.prepare(root)
            second = browser.prepare(root)
            self.assertEqual(first["mirror_URIs_updated"], 1)
            self.assertEqual(second["mirror_URIs_updated"], 0)
            self.assertIn("Signed-By: /keys/ubuntu.gpg", source.read_text())
            self.assertEqual(
                (apt / "apt.conf.d/99-onesa-ci-network").read_text(), browser.NETWORK
            )
            self.assertIn('APT::Update::Error-Mode "any";', browser.NETWORK)
            self.assertNotIn("AllowUnauthenticated", browser.NETWORK)
            self.assertNotIn("AllowInsecure", browser.NETWORK)

    def test_conflicting_config_preserves_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            config = apt / "apt.conf.d/99-onesa-ci-network"
            config.write_text("OWNER_CONFIG\n")
            config.chmod(0o644)
            before = source.read_bytes()
            with self.assertRaises(ValueError):
                browser.prepare(root)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(config.read_text(), "OWNER_CONFIG\n")

    def test_actual_runner_indirection_preserves_sources_and_other_mirrors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            source.write_text(
                "URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-security\nSigned-By: /keys/ubuntu.gpg\n"
            )
            before = source.read_text()
            mirror = apt / "apt-mirrors.txt"
            mirror.write_text(
                "# hosted Ubuntu archive failover\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n"
            )
            mirror.chmod(0o644)
            result = browser.prepare(root)
            self.assertEqual(result["mirror_list_files_updated"], 1)
            self.assertEqual(result["mirror_URIs_updated"], 1)
            self.assertEqual(source.read_text(), before)
            self.assertEqual(
                mirror.read_text(),
                "# hosted Ubuntu archive failover\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n",
            )
            self.assertEqual(browser.prepare(root)["mirror_URIs_updated"], 0)

    def test_mirror_list_rejects_custom_entries_or_missing_canonical_archive(self):
        for text in [
            "http://azure.archive.ubuntu.com/ubuntu/ priority:1\n",
            "https://user:secret@archive.ubuntu.com/ubuntu/ priority:2\n",
            "https://unrelated.example/ubuntu/ priority:2\n",
            "https://archive.ubuntu.com/ubuntu/ shell-option\n",
        ]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                browser.rewrite_mirror_list(text)

    def test_invalid_referenced_mirror_preserves_all_existing_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            source.write_text(
                source.read_text() + "URIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
            )
            before = source.read_bytes()
            mirror = apt / "apt-mirrors.txt"
            mirror.write_text("https://unrelated.example/ubuntu/\n")
            mirror.chmod(0o644)
            with self.assertRaises(ValueError):
                browser.prepare(root)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse((apt / "apt.conf.d/99-onesa-ci-network").exists())

    def test_unreferenced_mirror_file_is_never_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, _source = self.fixture(root)
            mirror = apt / "apt-mirrors.txt"
            mirror.write_text("UNRELATED OWNER CONFIGURATION\n")
            before = mirror.read_bytes()
            browser.prepare(root)
            self.assertEqual(mirror.read_bytes(), before)

    def test_referenced_mirror_alias_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            source.write_text(
                "URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n"
            )
            (apt / "apt-mirrors.txt").symlink_to(source)
            before = source.read_bytes()
            with self.assertRaises(ValueError):
                browser.prepare(root)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse((apt / "apt.conf.d/99-onesa-ci-network").exists())

    def test_source_alias_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            apt, source = self.fixture(root)
            (apt / "sources.list.d/alias.sources").symlink_to(source)
            before = source.read_bytes()
            with self.assertRaises(ValueError):
                browser.prepare(root)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse((apt / "apt.conf.d/99-onesa-ci-network").exists())


if __name__ == "__main__":
    unittest.main()
