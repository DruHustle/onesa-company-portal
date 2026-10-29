"""Synthetic CLI-default fault injection; no credential or provider operation."""

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_frontend as frontend


class StopAfterCommand(Exception):
    pass


class PreviewTargetTests(unittest.TestCase):
    def fixture(
        self, folder, *, wrong_provider_target=False, default_target="production"
    ):
        operation = str(uuid4())
        binding = {
            "repository": "DruHustle/onesa-company-portal",
            "component": "frontend",
            "candidate_commit": "a" * 40,
        }
        plan = {
            "project_id": "prj_synthetic",
            "cli_image": "sha256:" + "b" * 64,
            "retained_frontend": {"deployment_id": "dpl_retained"},
            "api_origins": frontend.API_ORIGINS,
            "server_public_configuration": {"staging": {}},
            "serverless_function_region": "fra1",
            "builds": {
                env: {"archive_sha256": "c" * 64} for env in ["staging", "production"]
            },
        }
        (folder / "operations").mkdir()
        published = []
        commands = []
        reads = []

        def run(command, **_kwargs):
            commands.append(command)
            # Reproduce the known first-project/default-target hazard without
            # invoking a CLI, network, Docker, credentials or a real provider.
            target = (
                "preview"
                if "--target=preview" in command
                else "production"
                if "--prod" in command
                else default_target
            )
            if target == "production":
                published.append("synthetic-production-alias")
            if not wrong_provider_target:
                raise StopAfterCommand()
            (
                folder / "operations" / operation / "transport" / "create-request.json"
            ).write_text("{}")
            return SimpleNamespace(returncode=0)

        def provider(path, **_kwargs):
            reads.append(path)
            return {
                "id": "dpl_synthetic",
                "projectId": plan["project_id"],
                "meta": {"githubCommitSha": binding["candidate_commit"]},
                "target": "production",
                "regions": ["fra1"],
                "readyState": "READY",
            }

        patches = ExitStack()
        patches.enter_context(patch.object(frontend, "unpack"))
        patches.enter_context(
            patch.object(
                frontend,
                "protection",
                return_value={
                    "id": plan["project_id"],
                    "targets": {"production": {"id": "dpl_retained"}},
                },
            )
        )
        patches.enter_context(
            patch.object(r, "private", side_effect=lambda value, **_kwargs: Path(value))
        )
        guard = Path(frontend.__file__).with_name("oracle_vercel_transport_guard.cjs")
        patches.enter_context(
            patch.object(
                r,
                "trusted_toolchain",
                return_value={"transport_guard_sha256": r.sha(guard)},
            )
        )
        patches.enter_context(
            patch.object(
                r,
                "runtime_values",
                return_value={"PROXY_SHARED_KEY": "synthetic-key-no-authority-" * 2},
            )
        )
        patches.enter_context(patch.object(frontend.subprocess, "run", side_effect=run))
        patches.enter_context(patch.object(frontend, "provider", side_effect=provider))
        patches.enter_context(
            patch.object(
                frontend,
                "deployments_for",
                side_effect=[[], [{"uid": "dpl_synthetic"}]],
            )
        )
        self.addCleanup(patches.close)
        return binding, plan, operation, published, commands, reads

    def test_requested_environment_overrides_a_conflicting_cli_default(self):
        for env in ["staging", "production"]:
            with self.subTest(environment=env), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                binding, plan, operation, published, commands, reads = self.fixture(
                    folder,
                    default_target="preview" if env == "production" else "production",
                )
                with self.assertRaises(StopAfterCommand):
                    frontend.create(binding, env, operation, folder, plan)
                self.assertEqual(len(commands), 1)
                self.assertEqual(
                    published,
                    [] if env == "staging" else ["synthetic-production-alias"],
                )
                self.assertEqual(reads, [])
                op = folder / "operations" / operation
                self.assertTrue((op / "intent.json").is_file())
                self.assertFalse((op / "private-staging-proxy.env").exists())

    def test_wrong_provider_target_keeps_intent_and_never_assigns_alias(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            binding, plan, operation, published, commands, reads = self.fixture(
                folder, wrong_provider_target=True
            )
            with self.assertRaisesRegex(
                r.Refused, "ACTUAL_FRONTEND_DEPLOYMENT_BINDING"
            ):
                frontend.create(binding, "staging", operation, folder, plan)
            self.assertEqual(len(commands), 1)
            self.assertEqual(published, [])
            self.assertEqual(reads, ["/v13/deployments/dpl_synthetic"])
            op = folder / "operations" / operation
            self.assertEqual(
                json.loads((op / "intent.json").read_text())["provider_create_budget"],
                1,
            )
            self.assertTrue((op / "transport" / "create-request.json").is_file())
            self.assertFalse((op / "alias-intent.json").exists())
            self.assertFalse((op / "private-staging-proxy.env").exists())
