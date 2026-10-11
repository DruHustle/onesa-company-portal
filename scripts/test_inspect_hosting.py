"""Negative coverage for provider diagnostics and credential disclosure."""

import json
from copy import deepcopy
import unittest
from unittest.mock import patch

import inspect_hosting
import repair_hosting


class HostingInspectionTests(unittest.TestCase):
    @staticmethod
    def staging_service():
        return {"id": repair_hosting.PORTAL_STAGING_SERVICE,
                "repo": "https://github.com/DruHustle/onesa-company-portal.git",
                "type": "web_service", "autoDeployTrigger": "commit",
                "serviceDetails": {"runtime": "docker", "plan": "free", "region": "frankfurt"}}

    def test_staging_layout_refuses_wrong_identity_type_runtime_plan_and_region(self):
        for change in [{"id": "srv-another"}, {"repo": "https://github.com/other/project"},
                       {"type": "background_worker"}, {"serviceDetails": {"runtime": "node"}},
                       {"serviceDetails": {"plan": "starter"}}, {"serviceDetails": {"region": "oregon"}}]:
            data = self.staging_service()
            for key, value in change.items():
                if isinstance(value, dict): data[key].update(value)
                else: data[key] = value
            with self.subTest(change=change), patch.dict("os.environ", {"RENDER_API_KEY": "fixture-token"}), \
                 patch("repair_hosting.get_json", return_value=(data, 200)), patch("repair_hosting.write_json") as write:
                self.assertFalse(repair_hosting.repair_portal_staging_layout()["target_verified"])
                write.assert_not_called()

    def test_staging_layout_requires_verified_pause_before_layout_changes(self):
        data = self.staging_service()
        with patch.dict("os.environ", {"RENDER_API_KEY": "fixture-token"}), \
             patch("repair_hosting.get_json", return_value=(data, 200)), \
             patch("repair_hosting.write_json", return_value=200) as write:
            self.assertFalse(repair_hosting.repair_portal_staging_layout()["layout_verified"])
        self.assertEqual(write.call_count, 1)
        self.assertEqual(write.call_args.args[3], {"autoDeployTrigger": "off"})

    def test_staging_layout_changes_only_identified_nonsecret_fields_and_checks_readback(self):
        data = self.staging_service()
        paused = {**data, "autoDeployTrigger": "off"}
        fixed = deepcopy(paused)
        fixed.update(repair_hosting.configuration(True, False))
        fixed["branch"] = "audit/portal-master-acceptance"
        fixed["serviceDetails"].update(data["serviceDetails"])
        with patch.dict("os.environ", {"RENDER_API_KEY": "fixture-token"}), \
             patch("repair_hosting.get_json", side_effect=[(data, 200), (paused, 200), (fixed, 200)]), \
             patch("repair_hosting.write_json", return_value=200) as write:
            result = repair_hosting.repair_portal_staging_layout()
        self.assertTrue(result["layout_verified"])
        self.assertFalse(result["deployment_requested"])
        self.assertEqual(write.call_count, 2)
        for call in write.call_args_list:
            self.assertEqual(call.args[1], "services/" + repair_hosting.PORTAL_STAGING_SERVICE)
            self.assertEqual(call.args[4], "PATCH")
        payload = write.call_args.args[3]
        self.assertEqual(set(payload), {"autoDeployTrigger", "branch", "rootDir", "serviceDetails"})
        self.assertNotIn("plan", payload["serviceDetails"])
        self.assertNotIn("envVars", payload)
        self.assertNotIn("fixture-token", json.dumps(result))

    def test_staging_layout_does_not_claim_success_for_failed_provider_readback(self):
        data = self.staging_service()
        paused = {**data, "autoDeployTrigger": "off"}
        with patch.dict("os.environ", {"RENDER_API_KEY": "fixture-token"}), \
             patch("repair_hosting.get_json", side_effect=[(data, 200), (paused, 200), ({}, 503)]), \
             patch("repair_hosting.write_json", return_value=200):
            self.assertFalse(repair_hosting.repair_portal_staging_layout()["layout_verified"])

    def test_staging_repair_entrypoint_refuses_main_and_other_repositories(self):
        for repo, ref in [("DruHustle/onesa-company-portal", "refs/heads/main"),
                          ("DruHustle/onesa-ai-platform", repair_hosting.PORTAL_AUDIT_REF)]:
            with patch.dict("os.environ", {"PORTAL_REPAIR_SCOPE": "staging", "GITHUB_REPOSITORY": repo, "GITHUB_REF": ref}), \
                 patch("repair_hosting.get_json") as read:
                with self.assertRaises(SystemExit): repair_hosting.main()
                read.assert_not_called()

    def test_staging_inspection_selects_only_the_owner_supplied_targets(self):
        with patch.dict("os.environ", {"RENDER_BACKEND_SERVICE_ID": "srv-productionapi", "RENDER_WORKER_SERVICE_ID": "srv-productionworker"}):
            self.assertEqual(inspect_hosting.portal_services("production"), ("srv-productionapi", "srv-productionworker"))
            self.assertEqual(inspect_hosting.portal_services("staging"), ("srv-db5k5had0e5s73fos4g0", "srv-db5k4mlckfvc73agdr40"))
            with self.assertRaises(SystemExit):
                inspect_hosting.portal_services("unrecognized")

    def test_inventory_filters_foreign_repositories_and_never_returns_provider_values(self):
        marker = "synthetic-private-provider-value"
        item = {"id": "srv-fixture", "repo": "https://github.com/DruHustle/onesa-company-portal.git",
                "branch": "staging", "type": "web_service", "rootDir": "onesa-company-portal-backend",
                "autoDeployTrigger": "off", "envVars": [{"value": marker}],
                "serviceDetails": {"plan": "free", "region": "frankfurt", "dockerCommand": marker}}
        foreign = {**item, "id": "srv-foreign", "repo": "https://github.com/other/private-project"}
        with patch("inspect_hosting.get_json", return_value=([{"service": item}, {"service": foreign}], 200)) as read:
            report = inspect_hosting.render_inventory("synthetic-test-token")
        self.assertTrue(report["complete"])
        self.assertEqual(len(report["services"]), 1)
        self.assertEqual(report["services"][0]["branch"], "staging")
        self.assertEqual(report["services"][0]["plan"], "free")
        self.assertNotIn(marker, json.dumps(report))
        self.assertNotIn("private-project", json.dumps(report))
        read.assert_called_once()

    def test_inventory_pagination_is_bounded_and_partial_results_are_not_complete(self):
        page = [{"service": {}, "cursor": "same-cursor"} for _ in range(100)]
        with patch("inspect_hosting.get_json", return_value=(page, 200)) as read:
            report = inspect_hosting.render_inventory("synthetic-test-token")
        self.assertFalse(report["complete"])
        self.assertEqual(read.call_count, 2)
        self.assertIn("cursor=same-cursor", read.call_args.args[1])
        with patch("inspect_hosting.get_json", return_value=({}, 403)):
            self.assertFalse(inspect_hosting.render_inventory("synthetic-test-token")["complete"])
        self.assertIsNone(inspect_hosting.safe_identifier("private-marker", "dep-"))

    def test_startup_overrides_and_role_errors_are_classified_without_disclosure(self):
        marker = "synthetic-private-token"
        self.assertEqual(inspect_hosting.startup_override(""), "dockerfile_cmd")
        result = inspect_hosting.startup_override("exec uvicorn --token=" + marker)
        self.assertNotIn(marker, result)
        categories = inspect_hosting.log_categories({"logs": [
            {"message": "sh: exec uvicorn app.main:create_app --factory: not found"},
            {"message": "DATABASE_ROLE " + marker},
        ]})
        self.assertIn("shell_startup_command_not_found", categories)
        self.assertIn("database_role_unsafe", categories)
        self.assertNotIn(marker, str(categories))

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

    def test_ai_configuration_uses_dockerfile_startup(self):
        self.assertEqual(
            repair_hosting.configuration(False, False)["serviceDetails"][
                "envSpecificDetails"
            ]["dockerCommand"],
            "",
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
