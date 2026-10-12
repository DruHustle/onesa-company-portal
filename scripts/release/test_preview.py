"""Exact-source native staging Preview selection, with synthetic provider responses."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import hosted
from evidence import Rejected


class PreviewTests(unittest.TestCase):
    def preview(self, **overrides):
        item = {
            "url": "synthetic.vercel.app",
            "readyState": "READY",
            "target": None,
            "meta": {"githubCommitSha": "a" * 40, "githubCommitRef": "staging"},
        }
        item.update(overrides)
        return item

    def resolve(self, deployments):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ,
                {
                    "GITHUB_SHA": "a" * 40,
                    "VERCEL_PROJECT_ID": "prj_synthetic",
                    "VERCEL_ORG_ID": "team_synthetic",
                    "VERCEL_TOKEN": "synthetic",
                },
            ),
            patch.object(hosted, "preflight"),
            patch.object(hosted, "provider", return_value={"deployments": deployments}),
            patch.object(hosted, "frontend") as verify,
        ):
            output = Path(directory, "origin.txt")
            origin = hosted.resolve_preview(output, attempts=1)
            verify.assert_called_once_with(origin, "a" * 40, "Staging")
            self.assertEqual(output.read_text().strip(), origin)
            return origin

    def test_ready_candidate_is_reused_and_identity_verified(self):
        self.assertEqual(self.resolve([self.preview()]), "https://synthetic.vercel.app")

    def test_foreign_sha_branch_production_and_pending_never_pass(self):
        for item in [
            self.preview(
                meta={"githubCommitSha": "b" * 40, "githubCommitRef": "staging"}
            ),
            self.preview(meta={"githubCommitSha": "a" * 40, "githubCommitRef": "main"}),
            self.preview(target="production"),
            self.preview(readyState="BUILDING"),
            self.preview(readyState="ERROR"),
        ]:
            with self.subTest(item=item), self.assertRaises(Rejected):
                self.resolve([item])

    def test_duplicate_authorities_are_rejected(self):
        with self.assertRaises(Rejected):
            self.resolve([self.preview(), self.preview(url="second.vercel.app")])
