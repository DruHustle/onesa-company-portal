"""Negative coverage for provider diagnostics and credential disclosure."""

import json
import unittest
from unittest.mock import patch

import inspect_hosting


class HostingInspectionTests(unittest.TestCase):
    def test_only_required_environment_presence_is_returned(self):
        marker = "synthetic-private-value-must-not-be-logged"
        entries = [
            {"envVar": {"key": "SESSION_KEY", "value": marker}},
            {"envVar": {"key": "UNRELATED", "value": marker}},
        ]
        result = inspect_hosting.environment_checks(
            entries, ["SESSION_KEY", "DATABASE_URL"], "envVar"
        )
        self.assertEqual(result, {"SESSION_KEY": True, "DATABASE_URL": False})
        self.assertNotIn(marker, json.dumps(result))

    def test_health_refuses_foreign_hosts_and_credentials(self):
        with patch("inspect_hosting.urllib.request.urlopen") as request:
            for origin in [
                "http://example.onrender.com",
                "https://example.com",
                "https://example.onrender.com.evil.test",
                "https://user:password@example.onrender.com",
                "https://example.onrender.com/path",
                "https://example.onrender.com?token=private",
            ]:
                self.assertIsNone(inspect_hosting.health(origin, "/ready"))
            request.assert_not_called()

    def test_provider_errors_do_not_echo_response_bodies(self):
        from urllib.error import HTTPError

        error = HTTPError("https://api.render.com", 401, "private-marker", {}, None)
        with patch("inspect_hosting.urllib.request.urlopen", side_effect=error):
            self.assertEqual(
                inspect_hosting.get_json(
                    "https://api.render.com/", "v1/services/test", "private-token"
                ),
                ({}, 401),
            )

    def test_commit_output_rejects_arbitrary_provider_text(self):
        self.assertIsNone(inspect_hosting.safe_commit("private-marker"))
        self.assertEqual(inspect_hosting.safe_commit("a" * 40), "a" * 40)


if __name__ == "__main__":
    unittest.main()
