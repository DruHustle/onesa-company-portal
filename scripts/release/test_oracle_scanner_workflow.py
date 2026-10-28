"""Synthetic scanner dependency scope tests; no issuer, Docker or database I/O."""

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import oracle_portal as r
import oracle_portal_scanner as scanner
import oracle_portal_scanner_workflow as workflow
import test_oracle_portal_scanner as fixture


class WorkflowScopeTests(unittest.TestCase):
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
