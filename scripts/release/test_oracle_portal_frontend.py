"""Synthetic provider custody and uncertain-request regressions; no external calls."""

import copy
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_frontend as f


class ProviderConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.project = {
            "id": "prj_fixture",
            "rootDirectory": f.APP_ROOT,
            "framework": "nextjs",
            "nodeVersion": "24.x",
            "serverlessFunctionRegion": "iad1",
            "ssoProtection": {"deploymentType": "all"},
            "protectionBypass": {},
            "passwordProtection": None,
            "trustedIps": None,
        }
        fields = {
            k: self.project[k]
            for k in [
                "ssoProtection",
                "protectionBypass",
                "passwordProtection",
                "trustedIps",
            ]
        }
        self.cfg = {
            "project_id": "prj_fixture",
            "team_id": "team_fixture",
            "staging_origin": "https://fixture.invalid",
            "production_deployment_id": "dpl_old",
        }
        self.plan = {
            "project_id": "prj_fixture",
            "team_id": "team_fixture",
            "api_origins": f.API_ORIGINS,
            "origins": {"staging": self.cfg["staging_origin"]},
            "retained_frontend": {"deployment_id": "dpl_old"},
            "serverless_function_region": "fra1",
            "project_default_region": "iad1",
            "vercel_protection_sha256": hashlib.sha256(
                json.dumps(fields, sort_keys=True).encode()
            ).hexdigest(),
            "vercel_api_url_variable_ids": {},
            "server_public_configuration": {},
            "server_public_variable_ids": {},
            "staging_proxy_variable_id": "fixture_stage_proxy",
            "staging_proxy_key_sha256": hashlib.sha256(b"s" * 48).hexdigest(),
        }
        self.variables = {}
        for env, target in [("staging", "preview"), ("production", "production")]:

            def put(key, value, env=env, target=target):
                identifier = "fixture_" + env + "_" + key
                row = {
                    "id": identifier,
                    "key": key,
                    "value": value,
                    "type": "plain",
                    "target": [target],
                    "gitBranch": "staging" if env == "staging" else None,
                    "updatedAt": 1,
                }
                self.variables[identifier] = row
                return identifier

            self.plan["vercel_api_url_variable_ids"][env] = put(
                "BACKEND_URL", f.API_ORIGINS[env]
            )
            values = {
                "ENGINEERING_SIGNIN_ENABLED": "true",
                "ACCESS_REGISTRATION_ENABLED": "false",
                "ENGINEERING_ACCESS_CALLBACK_URL": "",
            }
            self.plan["server_public_configuration"][env] = values
            self.plan["server_public_variable_ids"][env] = {
                key: put(key, value) for key, value in values.items()
            }
        self.variables["fixture_stage_proxy"] = {
            "id": "fixture_stage_proxy",
            "key": "PROXY_SHARED_KEY",
            "type": "encrypted",
            "target": ["preview"],
            "gitBranch": "staging",
            "updatedAt": 1,
            "decrypted": True,
            "value": "s" * 48,
        }
        # This production credential's identity may be inspected, never its value.
        self.variables["fixture_production_proxy"] = {
            "id": "fixture_production_proxy",
            "key": "PROXY_SHARED_KEY",
            "type": "sensitive",
            "target": ["production"],
            "gitBranch": None,
            "updatedAt": 1,
        }
        self.calls = []
        self.seal()

    def seal(self):
        self.metadata = [
            {
                k: row.get(k)
                for k in ["id", "key", "type", "target", "gitBranch", "updatedAt"]
            }
            for row in self.variables.values()
        ]
        self.plan["environment_metadata_sha256"] = hashlib.sha256(
            r.canonical(sorted(self.metadata, key=lambda row: row["id"]))
        ).hexdigest()

    def provider(self, path, **kwargs):
        self.calls.append(path)
        self.assertFalse(kwargs)
        if path.startswith("/v9/projects/"):
            return self.project
        if path.startswith("/v10/projects/"):
            return {"envs": self.metadata}
        identifier = path.rsplit("/", 1)[1]
        self.assertNotEqual(identifier, "fixture_production_proxy")
        return self.variables[identifier]

    def call(self):
        with (
            patch.object(r, "read", return_value=self.cfg),
            patch.object(
                r, "runtime_values", return_value={"PROXY_SHARED_KEY": "s" * 48}
            ),
            patch.object(f, "provider", side_effect=self.provider),
        ):
            return f.protection(self.plan)

    def test_only_named_values_are_read_and_sensitive_production_key_is_preserved(self):
        self.assertEqual(self.call(), self.project)
        reads = [p.rsplit("/", 1)[1] for p in self.calls if "/env/" in p]
        self.assertEqual(set(reads), set(self.variables) - {"fixture_production_proxy"})
        self.assertEqual(len(reads), 9)

    def test_project_default_and_actual_deployment_region_are_separately_preserved(
        self,
    ):
        self.assertEqual(self.call(), self.project)
        self.project["serverlessFunctionRegion"] = "fra1"
        with self.assertRaisesRegex(r.Refused, "EXISTING_PROVIDER_PROTECTION_CHANGED"):
            self.call()
        self.project["serverlessFunctionRegion"] = "iad1"
        self.plan["serverless_function_region"] = "iad1"
        with (
            patch.object(f, "provider") as provider,
            self.assertRaisesRegex(
                r.Refused, "EXISTING_PROJECT_AND_DEPLOYMENT_REGIONS"
            ),
        ):
            f.protection(self.plan)
        provider.assert_not_called()

    def test_existing_access_callback_contract_is_preserved_before_credential_use(self):
        for env in ["staging", "production"]:
            callback = (
                "https://fixture-team.cloudflareaccess.com/cdn-cgi/access/callback"
            )
            self.plan["server_public_configuration"][env][
                "ENGINEERING_ACCESS_CALLBACK_URL"
            ] = callback
            identifier = self.plan["server_public_variable_ids"][env][
                "ENGINEERING_ACCESS_CALLBACK_URL"
            ]
            self.variables[identifier]["value"] = callback
        self.assertEqual(self.call(), self.project)
        for callback in [
            "https://foreign.invalid/cdn-cgi/access/callback",
            "https://fixture-team.cloudflareaccess.com/other",
            "https://fixture-team.cloudflareaccess.com/cdn-cgi/access/callback?code=untrusted",
            "https://user@fixture-team.cloudflareaccess.com/cdn-cgi/access/callback",
            "https://fixture-team.cloudflareaccess.com:444/cdn-cgi/access/callback",
        ]:
            self.plan["server_public_configuration"]["staging"][
                "ENGINEERING_ACCESS_CALLBACK_URL"
            ] = callback
            with (
                self.subTest(callback=callback),
                patch.object(f, "provider") as provider,
                self.assertRaisesRegex(r.Refused, "EXISTING_CALLBACK_SCOPE"),
            ):
                f.protection(self.plan)
            provider.assert_not_called()

    def test_foreign_origin_is_rejected_before_credential_use(self):
        with (
            patch.object(f, "provider") as provider,
            self.assertRaisesRegex(r.Refused, "CANONICAL_PORTAL_API"),
        ):
            f.protection({"api_origins": {"staging": "https://foreign.invalid"}})
        provider.assert_not_called()

    def test_unrelated_variable_id_is_rejected_before_value_read(self):
        self.plan["vercel_api_url_variable_ids"]["production"] = (
            "fixture_production_proxy"
        )
        with self.assertRaisesRegex(r.Refused, "NAMED_ENVIRONMENT_VARIABLE_SCOPE"):
            self.call()
        self.assertFalse(
            any(p.endswith("/fixture_production_proxy") for p in self.calls)
        )

    def test_changed_scope_metadata_value_or_proxy_custody_fails_closed(self):
        stage = self.plan["vercel_api_url_variable_ids"]["staging"]
        for key, value in [
            ("value", "https://foreign.invalid"),
            ("target", ["production"]),
            ("gitBranch", "other"),
            ("key", "OTHER"),
        ]:
            old = copy.deepcopy(self.variables[stage])
            self.variables[stage][key] = value
            self.seal()
            with self.subTest(key=key), self.assertRaises(r.Refused):
                self.call()
            self.variables[stage] = old
            self.seal()
        self.variables["fixture_stage_proxy"]["value"] = "other" * 10
        with self.assertRaisesRegex(r.Refused, "STAGING_PROXY_CUSTODY"):
            self.call()

    def test_unmapped_staging_setting_and_concurrent_metadata_change_are_rejected(self):
        self.metadata.append(
            {
                "id": "fixture_extra",
                "key": "NEW_SETTING",
                "type": "plain",
                "target": ["preview"],
                "gitBranch": "staging",
                "updatedAt": 1,
            }
        )
        with self.assertRaisesRegex(r.Refused, "METADATA_CHANGED"):
            self.call()
        self.plan["environment_metadata_sha256"] = hashlib.sha256(
            r.canonical(sorted(self.metadata, key=lambda row: row["id"]))
        ).hexdigest()
        with self.assertRaisesRegex(r.Refused, "UNMAPPED_BRANCH"):
            self.call()


class ProviderIntentTests(unittest.TestCase):
    def test_staging_timeout_retains_intent_removes_temporary_secret_and_never_recreates(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "operations").mkdir()
            binding = {
                "repository": "DruHustle/onesa-company-portal",
                "component": "frontend",
                "candidate_commit": "a" * 40,
            }
            operation = str(uuid4())
            calls = []
            plan = {
                "project_id": "prj_fixture",
                "serverless_function_region": "fra1",
                "builds": {"staging": {"archive_sha256": "b" * 64}},
                "api_origins": f.API_ORIGINS,
                "cli_image": "sha256:" + "c" * 64,
                "server_public_configuration": {
                    "staging": {"ACCESS_REGISTRATION_ENABLED": "false"}
                },
            }

            def run(args, **kw):
                calls.append(args)
                private_env = Path(args[args.index("--env-file") + 1])
                self.assertEqual(
                    private_env.read_text(), "PROXY_SHARED_KEY=" + "s" * 48 + "\n"
                )
                self.assertNotIn("s" * 48, " ".join(args))
                self.assertIn("PROXY_SHARED_KEY", args)
                self.assertIn("BACKEND_URL=" + f.API_ORIGINS["staging"], args)
                self.assertIn("ACCESS_REGISTRATION_ENABLED=false", args)
                raise subprocess.TimeoutExpired("synthetic-cli", 1)

            with (
                patch.object(r, "private", side_effect=lambda p, **kw: Path(p)),
                patch.object(f, "unpack"),
                patch.object(f, "protection", return_value={"id": "prj_fixture"}),
                patch.object(f, "deployments_for", return_value=[]),
                patch.object(
                    r, "runtime_values", return_value={"PROXY_SHARED_KEY": "s" * 48}
                ),
                patch.object(
                    r,
                    "trusted_toolchain",
                    return_value={
                        "transport_guard_sha256": r.sha(
                            Path(f.__file__).with_name(
                                "oracle_vercel_transport_guard.cjs"
                            )
                        )
                    },
                ),
                patch.object(f.subprocess, "run", side_effect=run),
                patch.object(f.time, "monotonic", side_effect=[0, 121]),
            ):
                with self.assertRaisesRegex(r.Refused, "UNCERTAIN"):
                    f.create(binding, "staging", operation, folder, plan)
                with self.assertRaises(FileExistsError):
                    f.create(binding, "staging", operation, folder, plan)
            self.assertEqual(len(calls), 1)
            op = folder / "operations" / operation
            self.assertTrue((op / "intent.json").is_file())
            self.assertFalse((op / "private-staging-proxy.env").exists())
            self.assertNotIn("s" * 48, (op / "intent.json").read_text())

    def test_interrupted_acknowledgement_is_reconciled_without_a_create_request(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            operation = str(uuid4())
            context_id = str(uuid4())
            op = folder / "operations" / operation
            op.mkdir(parents=True)
            binding = {
                "repository": "DruHustle/onesa-company-portal",
                "component": "frontend",
                "candidate_commit": "a" * 40,
            }
            r.write(
                op / "intent.json",
                {
                    "binding": binding,
                    "operation_id": operation,
                    "environment": "production",
                },
            )
            plan = {"builds": {"production": {"archive_sha256": "b" * 64}}}
            with (
                patch.object(f, "validate", return_value=(folder, plan)),
                patch.object(
                    r,
                    "verify_invocation",
                    return_value=[{"kind": "context", "id": context_id}],
                ),
                patch.object(r, "inventory", return_value={}),
                patch.object(f, "deployments_for", return_value=[{"uid": "dpl_owned"}]),
                patch.object(
                    f,
                    "check_deployment",
                    return_value={"id": "dpl_owned", "readyState": "READY"},
                ),
                patch.object(
                    r, "read", side_effect=lambda p: json.loads(Path(p).read_bytes())
                ),
                patch.object(f, "verify_static"),
                patch.object(r, "probe", return_value={"status": "PASS"}),
                patch.object(f, "create") as create,
            ):
                result = f.runner(
                    "production",
                    binding,
                    {"operation_id": operation, "read_only": True},
                )
            create.assert_not_called()
            self.assertEqual(result["deployment_id"], "dpl_owned")
            self.assertTrue(
                json.loads((op / "provider-receipt.json").read_bytes())[
                    "reconciled_read_only"
                ]
            )


class StaticAssetVerificationTests(unittest.TestCase):
    def setUp(self):
        self.body = b"synthetic compiled chunk"
        self.digest = hashlib.sha256(self.body).hexdigest()
        self.receipt = {"served_static_files": {}}
        patch.object(r, "read", return_value=self.receipt).start()
        self.plan = {"builds": {"staging": {"receipt": "build.json"}}}
        self.observer = patch.object(
            f,
            "observe_provider",
            return_value={
                "origin": "https://fixture.invalid",
                "bypass": "synthetic-bypass",
            },
        ).start()
        self.factory = patch.object(f.urllib.request, "build_opener").start()
        self.reader = self.factory.return_value.open
        self.reader.side_effect = lambda *args, **kwargs: io.BytesIO(self.body)
        self.addCleanup(patch.stopall)

    def verify(self, paths):
        self.receipt["served_static_files"] = {name: self.digest for name in paths}
        return f.verify_static(
            {}, "staging", Path("/fixture"), self.plan, "fixture-operation"
        )

    def test_generated_catch_all_chunks_are_requested_and_hashed(self):
        self.verify(
            [
                "/_next/static/chunks/app/api/[...path]/route-fixture.js",
                "/_next/static/chunks/app/[[...slug]]/page-fixture.js",
            ]
        )
        urls = [
            getattr(call.args[0], "full_url", call.args[0])
            for call in self.reader.call_args_list
        ]
        self.assertEqual(
            urls,
            [
                "https://fixture.invalid"
                + "/_next/static/chunks/app/api/%5B...path%5D/route-fixture.js",
                "https://fixture.invalid"
                + "/_next/static/chunks/app/%5B%5B...slug%5D%5D/page-fixture.js",
            ],
        )
        self.assertEqual(self.reader.call_count, 2)

    def test_traversal_and_url_controls_fail_before_any_asset_request(self):
        for name in [
            "/_next/static/../secret.js",
            "/_next/static/./a.js",
            "/_next/static//a.js",
            "//foreign.invalid/a.js",
            "https://foreign.invalid/a.js",
            "/_next/static/%2e%2e/a.js",
            "/_next/static/%252e%252e/a.js",
            "/_next/static/a.js?token=fixture",
            "/_next/static/a.js#fragment",
            "/_next/static/\\secret.js",
            "/_next/static/a\x00.js",
            "/_next/static/a\n.js",
        ]:
            with self.subTest(path=name), self.assertRaises(r.Refused):
                self.verify(["/_next/static/valid.js", name])
            self.reader.assert_not_called()

    def test_changed_and_oversized_served_bodies_remain_unqualified(self):
        for body in [b"modified chunk", b"x" * (4194304 + 1)]:
            self.body = body
            with self.subTest(bytes=len(body)), self.assertRaises(r.Refused):
                self.verify(["/_next/static/chunks/app/[...path]/route-fixture.js"])
