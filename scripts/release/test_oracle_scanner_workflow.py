"""Synthetic scanner dependency scope tests; no issuer, Docker or database I/O."""

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_scanner as scanner
import oracle_portal_scanner_workflow as workflow
import test_oracle_portal_scanner as fixture


class WorkflowScopeTests(unittest.TestCase):
    def private_fixture(self):
        binding, plan = fixture.inputs()
        now = r.now()
        expiry = (
            (now + workflow.dt.timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
        )
        plan["workflow"]["expires_at"] = expiry
        context_id = str(uuid4())
        owner = {
            "schema_version": 1,
            "state": "STAGING_CUSTODY_NOT_AUTHORIZATION",
            **{
                key: binding[key]
                for key in ["candidate_commit", "source_tree", "artifact_digest"]
            },
            "owner_uri": "synthetic-owner-fixture-only",
            "runtime_password": "synthetic-runtime-fixture-only",
            "created_at": now.isoformat().replace("+00:00", "Z"),
            "expires_at": expiry,
        }
        storage = {
            "S3_ENDPOINT": "https://synthetic-store.invalid",
            "S3_BUCKET": "owned-synthetic-fixture",
            "AWS_ACCESS_KEY_ID": "synthetic-key-id",
            "AWS_SECRET_ACCESS_KEY": "synthetic-key-value",
        }
        stage = {
            "Config": {"Env": [key + "=" + value for key, value in storage.items()]}
        }
        plan["baseline"]["onesa-portal-oracle-api-staging-1"] = {"synthetic": "stage"}
        plan["baseline"]["onesa-portal-oracle-production-worker-1"] = {
            "source": "9" * 40,
            "image": "sha256:" + "a" * 64,
        }
        records = [
            {
                "kind": "context",
                "id": context_id,
                "binding": binding,
                "details": {"ci": [{"run_id": 4711}]},
            }
        ]
        pins = {
            "runtime.env": "3",
            "cert.pem": "5",
            "key.pem": "6",
            "owner.json": "7",
            "portal-production.env": "4",
        }
        self.enterContext(patch.object(r, "private", side_effect=Path))
        self.enterContext(
            patch.object(r, "sha", side_effect=lambda path: pins[Path(path).name] * 64)
        )
        self.enterContext(patch.object(r, "read", return_value=owner))
        self.enterContext(patch.object(r, "now", return_value=now))
        self.enterContext(patch.object(r, "runtime_values", return_value=storage))
        self.enterContext(
            patch.object(r, "summary", return_value={"synthetic": "stage"})
        )
        self.enterContext(patch.object(r, "healthy", return_value=True))
        docker = self.enterContext(
            patch.object(r, "docker", return_value=r.canonical([stage]))
        )
        return binding, plan, context_id, records, docker

    def test_private_fixture_binds_the_existing_oracle_production_worker(self):
        binding, plan, context_id, records, docker = self.private_fixture()
        result = workflow.private_input(
            binding, plan, Path("/synthetic"), context_id, records
        )
        self.assertEqual(
            result["worker_probe"]["rollback"],
            {"source": "9" * 40, "artifact_digest": "sha256:" + "a" * 64},
        )
        self.assertEqual(result["worker_probe"]["ci_run_id"], 4711)
        docker.assert_called_once_with("inspect", "onesa-portal-oracle-api-staging-1")

    def test_missing_or_malformed_retained_worker_cannot_use_a_similarly_named_baseline(
        self,
    ):
        binding, plan, context_id, records, _docker = self.private_fixture()
        original = plan["baseline"].pop("onesa-portal-oracle-production-worker-1")
        plan["baseline"]["onesa-portal-production-worker-1"] = original
        for replacement in [
            None,
            {**original, "source": "main"},
            {**original, "image": "mutable:tag"},
        ]:
            if replacement is not None:
                plan["baseline"]["onesa-portal-oracle-production-worker-1"] = (
                    replacement
                )
            with (
                self.subTest(replacement=replacement),
                self.assertRaisesRegex(r.Refused, "RETAINED_WORKER_IDENTITY_REQUIRED"),
            ):
                workflow.private_input(
                    binding, plan, Path("/synthetic"), context_id, records
                )

    def test_application_keeps_its_separate_build_artifact_and_current_source(self):
        binding, plan = fixture.inputs()
        result = workflow.validate_plan(binding, plan)
        self.assertEqual(
            result["application_binding"]["candidate_commit"],
            binding["candidate_commit"],
        )
        self.assertNotEqual(
            result["application_binding"]["artifact_digest"], binding["artifact_digest"]
        )
        self.assertNotEqual(
            result["application_binding"]["build_sha256"], binding["build_sha256"]
        )

    def test_foreign_component_source_environment_artifact_or_runtime_cannot_transfer_evidence(
        self,
    ):
        for change in [
            lambda p: p["workflow"]["application_binding"].update(component="api"),
            lambda p: p["workflow"]["application_binding"].update(
                candidate_commit="f" * 40
            ),
            lambda p: p["workflow"]["application_binding"].update(
                source_sha256="f" * 64
            ),
            lambda p: p["workflow"]["application_binding"].update(
                target_environment="staging"
            ),
            lambda p: p["workflow"]["application_binding"].update(
                artifact_digest="sha256:" + "e" * 64
            ),
            lambda p: p["workflow"].update(runtime_sha256="f" * 64),
            lambda p: p["workflow"].update(owner_custody_sha256="unverified"),
            lambda p: p["workflow"].update(owner_approved=True),
        ]:
            binding, plan = fixture.inputs()
            change(plan)
            with self.assertRaises(r.Refused):
                workflow.validate_plan(binding, plan)

    def test_changed_dependency_or_owner_custody_invalidates_the_parent_configuration(
        self,
    ):
        binding, plan = fixture.inputs()
        for field in [
            "certificate_sha256",
            "private_key_sha256",
            "owner_custody_sha256",
            "application_scan_sha256",
        ]:
            changed = copy.deepcopy(plan)
            changed["workflow"][field] = "f" * 64
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(r.Refused, "CONFIGURATION_CHANGED"),
            ):
                scanner.validate_plan(binding, changed)

    def test_historical_inspection_does_not_require_renewed_staging_credentials(self):
        binding, plan = fixture.inputs()
        plan["workflow"]["expires_at"] = "2020-01-01T00:00:00.000Z"
        with patch.object(r, "read") as read, patch.object(r, "docker") as docker:
            workflow.validate_plan(binding, plan)
        read.assert_not_called()
        docker.assert_not_called()

    def test_changed_source_refuses_before_any_dependency_execution(self):
        binding, plan = fixture.inputs()
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "source.tar").write_bytes(b"changed source after qualification")
            with (
                patch.object(r, "private", side_effect=lambda path, **_kw: Path(path)),
                patch.object(r, "docker") as docker,
                self.assertRaisesRegex(r.Refused, "SOURCE_ARCHIVE_CHANGED"),
            ):
                workflow.verify_application(binding, plan, folder)
            docker.assert_not_called()

    def test_failed_observation_preserves_private_output_without_retry_or_success(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            result = SimpleNamespace(
                returncode=1,
                stdout=b'{"state":"FAILED_NOT_QUALIFIED"}',
                stderr=b"synthetic private diagnostic",
            )
            with (
                patch.object(
                    workflow.subprocess, "run", return_value=result
                ) as command,
                self.assertRaises(r.Refused),
            ):
                workflow.private_probe(
                    "run",
                    "synthetic-image",
                    data=b"synthetic-private-input",
                    observations=folder,
                )
            self.assertEqual(command.call_count, 1)
            self.assertEqual(
                (folder / "workflow-command.stderr").read_bytes(), result.stderr
            )
            self.assertEqual(
                (folder / "workflow-command.stderr").stat().st_mode & 0o777, 0o600
            )
            self.assertFalse(
                json.loads((folder / "workflow-command-result.json").read_bytes())[
                    "automatic_retry"
                ]
            )

    def test_interrupted_observation_retains_its_actual_partial_output_and_requires_inspection(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            interrupted = subprocess.TimeoutExpired(
                "synthetic", 300, output=b"partial", stderr=b"private"
            )
            with (
                patch.object(
                    workflow.subprocess, "run", side_effect=interrupted
                ) as command,
                self.assertRaisesRegex(r.Refused, "INTERRUPTED_INSPECT_ONLY"),
            ):
                workflow.private_probe(
                    "run",
                    "synthetic-image",
                    data=b"synthetic-private-input",
                    observations=folder,
                )
            self.assertEqual(command.call_count, 1)
            self.assertEqual(
                (folder / "workflow-command.stdout").read_bytes(), b"partial"
            )
            self.assertEqual(
                json.loads((folder / "workflow-command-result.json").read_bytes())[
                    "state"
                ],
                "INTERRUPTED_INSPECT_OWNED_FIXTURE_ONLY",
            )
