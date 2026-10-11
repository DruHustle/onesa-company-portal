"""Exercise the actual pre-job policy's denial paths and authenticated request."""

import io
import json
import os
import unittest
from typing import ClassVar
from unittest.mock import patch

from visibility import verify


class VisibilityTests(unittest.TestCase):
    config: ClassVar = {"repository": "DruHustle/onesa-company-portal"}

    def response(self, private=True, repository="DruHustle/onesa-company-portal"):
        return io.BytesIO(
            json.dumps({"private": private, "full_name": repository}).encode()
        )

    def test_public_and_other_repository_denied(self):
        with patch.dict(
            os.environ,
            {
                "GITHUB_REPOSITORY": self.config["repository"],
                "ONESA_CI_TOKEN": "synthetic-job-token",
            },
        ):
            for response in [self.response(False), self.response(True, "someone/else")]:
                with (
                    patch("visibility.urlopen", return_value=response),
                    self.assertRaises(SystemExit),
                ):
                    verify(self.config)

    def test_private_verified_with_scoped_token(self):
        with (
            patch.dict(
                os.environ,
                {
                    "GITHUB_REPOSITORY": self.config["repository"],
                    "ONESA_CI_TOKEN": "synthetic-job-token",
                },
            ),
            patch("visibility.urlopen", return_value=self.response()) as request,
        ):
            verify(self.config)
            self.assertEqual(
                request.call_args.args[0].headers["Authorization"],
                "Bearer synthetic-job-token",
            )
            self.assertEqual(request.call_args.kwargs["timeout"], 15)

    def test_missing_token_and_api_failure_deny_execution(self):
        with (
            patch.dict(
                os.environ,
                {"GITHUB_REPOSITORY": self.config["repository"], "ONESA_CI_TOKEN": ""},
            ),
            self.assertRaises(SystemExit),
        ):
            verify(self.config)
        with (
            patch.dict(
                os.environ,
                {
                    "GITHUB_REPOSITORY": self.config["repository"],
                    "ONESA_CI_TOKEN": "synthetic-job-token",
                },
            ),
            patch("visibility.urlopen", side_effect=OSError),
            self.assertRaises(SystemExit),
        ):
            verify(self.config)
