"""Execute the actual browser boundary function without browser dependencies or network."""

import json
import subprocess
import unittest
from pathlib import Path


class AnonymousBoundaryTests(unittest.TestCase):
    def call(self, environment, overrides=None):
        source = Path(__file__).with_name("oracle_portal_browser.mjs").read_text()
        # Isolate the actual pure HTTP boundary function. Other exports require
        # Playwright, installed later in CI, and are covered by hosted browsers.
        start = source.index("export async function checkAnonymousBoundaries(")
        end = source.index("\n}\n", start) + 2
        function = source[start:end].replace("export ", "", 1)
        script = (
            "import assert from 'node:assert/strict';\n"
            + function
            + """
const request=JSON.parse(process.argv[1]);const overrides=JSON.parse(process.argv[2]);
const calls=[];
const client={get:async url=>{calls.push(url);const origin=new URL(url).origin;return {status:()=>overrides[origin]??(origin==='https://onesa.eu'?403:401)}}};
await checkAnonymousBoundaries(request,client);console.log(JSON.stringify(calls));
"""
        )
        origin = (
            "https://onesa.eu"
            if environment == "production"
            else "https://onesa-company-portal-git-staging-fixture.vercel.app"
        )
        return subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                script,
                json.dumps({"environment": environment, "origin": origin}),
                json.dumps(overrides or {}),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_production_checks_all_three_paths_on_both_independent_hosts(self):
        result = self.call("production")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = json.loads(result.stdout)
        self.assertEqual(len(calls), 6)
        self.assertEqual(len(set(calls)), 6)
        for host in ["https://onesa.eu", "https://portal.onesa.eu"]:
            self.assertEqual(sum(url.startswith(host + "/") for url in calls), 3)

    def test_staging_keeps_all_three_existing_preview_denials(self):
        result = self.call("staging")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = json.loads(result.stdout)
        self.assertEqual(len(calls), 3)
        self.assertTrue(
            all(
                url.startswith(
                    "https://onesa-company-portal-git-staging-fixture.vercel.app/"
                )
                for url in calls
            )
        )

    def test_wrong_company_boundary_is_rejected(self):
        self.assertNotEqual(
            self.call("production", {"https://onesa.eu": 401}).returncode, 0
        )

    def test_wrong_portal_boundary_is_rejected(self):
        self.assertNotEqual(
            self.call("production", {"https://portal.onesa.eu": 403}).returncode, 0
        )

    def test_anonymous_success_never_qualifies_either_host(self):
        for origin in ["https://onesa.eu", "https://portal.onesa.eu"]:
            with self.subTest(origin=origin):
                self.assertNotEqual(
                    self.call("production", {origin: 200}).returncode, 0
                )


if __name__ == "__main__":
    unittest.main()
