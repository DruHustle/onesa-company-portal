"""Negative coverage for provider diagnostics and credential disclosure."""

import json
import unittest
from unittest.mock import patch

import inspect_hosting
import repair_hosting


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

    def test_configuration_repairs_do_not_add_secrets_or_remove_release_gates(self):
        for portal, worker in [(True, False), (True, True), (False, False)]:
            configuration = repair_hosting.configuration(portal, worker)
            self.assertEqual(configuration["autoDeployTrigger"], "off")
            self.assertEqual(configuration["branch"], "main")
            self.assertNotIn("plan", configuration["serviceDetails"])
            self.assertNotIn("envVars", configuration)
            self.assertNotIn("preDeployCommand", configuration["serviceDetails"])
        self.assertEqual(
            repair_hosting.configuration(True, True)["serviceDetails"][
                "envSpecificDetails"
            ]["dockerCommand"],
            "node dist/src/jobs/worker.js",
        )

    def test_configuration_repair_refuses_a_different_repository(self):
        with (
            patch.dict("os.environ", {"RENDER_API_KEY": "synthetic-test-token"}),
            patch(
                "repair_hosting.get_json",
                return_value=({"repo": "https://github.com/other/project"}, 200),
            ),
            patch("repair_hosting.write_json") as write,
        ):
            result = repair_hosting.repair_render(
                "DruHustle/onesa-company-portal", "srv-testonly", True
            )
            self.assertFalse(result["repository_matches"])
            write.assert_not_called()

    def test_commit_output_rejects_arbitrary_provider_text(self):
        self.assertIsNone(inspect_hosting.safe_commit("private-marker"))
        self.assertEqual(inspect_hosting.safe_commit("a" * 40), "a" * 40)


if __name__ == "__main__":
    unittest.main()
