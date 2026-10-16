"""Offline service-availability guards; no provider calls or release attempts."""
import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "render_deploy_availability", Path(__file__).resolve().parents[1] / "deploy_render.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class AvailabilityTests(unittest.TestCase):
    def test_confirmed_active_service(self):
        deploy.require_service_available({"suspended": "not_suspended", "suspenders": []})

    def test_suspended_ambiguous_or_malformed_state_never_creates_deployment(self):
        cases = [
            {"suspended": "suspended", "suspenders": ["billing"]},
            {"suspended": "not_suspended", "suspenders": ["billing"]},
            {"suspended": "unknown", "suspenders": []},
            {"suspended": "not_suspended", "suspenders": None},
            {"suspended": "not_suspended"}, {}, None, [],
        ]
        for service in cases:
            with self.subTest(service=service), patch.dict(os.environ, {
                "RENDER_API_KEY": "synthetic", "RENDER_SERVICE_ID": "srv-synthetic",
                "GITHUB_SHA": "a" * 40,
            }, clear=True), patch.object(deploy, "request", return_value=service) as request:
                with self.assertRaisesRegex(SystemExit, "availability is unverified"):
                    deploy.main()
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.args, ("services/srv-synthetic", "synthetic"))

    def test_live_deployment_rechecks_service_before_success_receipt(self):
        active = {"suspended": "not_suspended", "suspenders": []}
        suspended = {"suspended": "suspended", "suspenders": ["billing"]}
        with patch.dict(os.environ, {
            "RENDER_API_KEY": "synthetic", "RENDER_SERVICE_ID": "srv-synthetic",
            "GITHUB_SHA": "a" * 40,
        }, clear=True), patch.object(deploy, "request", side_effect=[
            active, {"id": "dep-synthetic"},
            {"status": "live", "commit": {"id": "a" * 40}}, suspended,
        ]), patch("builtins.print"), patch.object(deploy.Path, "write_text") as save:
            with self.assertRaises(SystemExit):
                deploy.main()
            save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
