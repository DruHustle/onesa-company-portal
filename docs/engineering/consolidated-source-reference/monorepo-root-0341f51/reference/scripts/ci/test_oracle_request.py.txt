"""Reject execution inputs and ambiguous provenance in capability request metadata."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import generate_workflows as workflows
import oracle_request as request

NOW = datetime(2026, 11, 6, 4, 0, 0, tzinfo=timezone.utc)


def environment(ref="refs/heads/dev"):
    """Synthetic context only: no workflow is dispatched by these tests."""
    return {
        "GITHUB_ACTIONS": "true",
        "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REPOSITORY": request.REPOSITORY,
        "GITHUB_REPOSITORY_ID": str(request.REPOSITORY_ID),
        "GITHUB_REF": ref,
        "GITHUB_SHA": "a" * 40,
        "GITHUB_WORKFLOW_REF": request.REPOSITORY + "/" + request.WORKFLOW_PATH + "@" + ref,
        "GITHUB_WORKFLOW_SHA": "a" * 40,
        "GITHUB_RUN_ID": "123456789",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_ACTOR": request.OWNER,
        "GITHUB_TRIGGERING_ACTOR": request.OWNER,
    }


class CapabilityRequestTests(unittest.TestCase):
    def setUp(self):
        self.value = request.create_request(environment(), now=NOW)

    def test_fixed_probe_and_requests_have_no_release_authority(self):
        for ref in request.ALLOWED_REFS:
            value = request.create_request(environment(ref), now=NOW)
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(request.validate_request(value, now=NOW), value)
            self.assertIs(value["read_only"], True)
            self.assertIs(value["release_authorized"], False)
            self.assertEqual(value["probe_sha256"], request.PROBE_SHA256)
            self.assertEqual(value["expires_at"], "2026-11-06T04:15:00Z")

    def test_unknown_inputs_cannot_select_targets_commands_or_claim_success(self):
        for key in ("command", "script", "probe_bytes", "probe_path", "target", "instance_id", "url", "path",
                    "environment", "owner_token", "approval", "status", "result"):
            with self.subTest(key=key), self.assertRaises(request.Rejected):
                request.validate_request({**self.value, key: "untrusted-input"}, now=NOW)
        for value in (None, [], "{}", {k: v for k, v in self.value.items() if k != "operation"}):
            with self.subTest(value=value), self.assertRaises(request.Rejected):
                request.validate_request(value, now=NOW)

    def test_external_provenance_and_permission_substitutions_are_rejected(self):
        changes = [
            ("schema_version", True), ("schema_version", 2),
            ("operation", "deploy"), ("operation", [request.OPERATION]),
            ("repository", "someone/onesa-ug"), ("repository_id", str(request.REPOSITORY_ID)),
            ("repository_id", request.REPOSITORY_ID + 1),
            ("ref", "refs/pull/1/merge"), ("ref", "refs/heads/main\n"),
            ("candidate_commit", "A" * 40), ("candidate_commit", "main"),
            ("workflow_ref", "other/workflow@refs/heads/dev"),
            ("workflow_sha", "b" * 40),
            ("run_id", True), ("run_id", 0), ("run_id", "123456789"),
            ("run_id", 1.0), ("run_id", 2**63),
            ("run_attempt", True), ("run_attempt", 2),
            ("actor", "other"), ("triggering_actor", "other"),
            ("probe_sha256", "b" * 64), ("read_only", 1),
            ("read_only", False), ("release_authorized", 0),
            ("release_authorized", True),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(request.Rejected):
                request.validate_request({**self.value, key: value}, now=NOW)

    def test_actions_context_is_validated_separately(self):
        changes = [
            ("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("RUNNER_OS", "macOS"), ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_EVENT_NAME", "pull_request_target"),
            ("GITHUB_REPOSITORY", "someone/onesa-ug"),
            ("GITHUB_REPOSITORY_ID", "0" + str(request.REPOSITORY_ID)),
            ("GITHUB_REF", "refs/heads/feature"), ("GITHUB_SHA", "main"),
            ("GITHUB_WORKFLOW_REF", "other/workflow@refs/heads/dev"),
            ("GITHUB_WORKFLOW_SHA", "b" * 40),
            ("GITHUB_RUN_ID", "1e3"), ("GITHUB_RUN_ID", "01"),
            ("GITHUB_RUN_ID", "-1"), ("GITHUB_RUN_ID", "1\n"),
            ("GITHUB_RUN_ATTEMPT", "2"), ("GITHUB_ACTOR", "other"),
            ("GITHUB_TRIGGERING_ACTOR", "other"),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(request.Rejected):
                request.actions_identity({**environment(), key: value})
        for key in environment():
            with self.subTest(missing=key), self.assertRaises(request.Rejected):
                request.actions_identity({k: v for k, v in environment().items() if k != key})

    def test_expired_extended_and_future_requests_are_rejected(self):
        with self.assertRaises(request.Rejected):
            request.validate_request(self.value, now=NOW + request.TTL)
        for key, value in (("expires_at", "2026-11-06T04:16:00Z"),
                           ("issued_at", "2026-11-06T04:00:00+00:00"),
                           ("issued_at", "2026-02-30T04:00:00Z"),
                           ("issued_at", "2026-11-6T04:00:00Z")):
            with self.subTest(key=key, value=value), self.assertRaises(request.Rejected):
                request.validate_request({**self.value, key: value}, now=NOW)
        future = request.create_request(environment(), now=NOW + timedelta(seconds=31))
        with self.assertRaises(request.Rejected):
            request.validate_request(future, now=NOW)

    def test_untrusted_json_is_bounded_and_unambiguous(self):
        raw = json.dumps(self.value).encode()
        bad_inputs = [
            raw[:-1] + b', "run_id": 1}',
            raw.replace(b'123456789', b'NaN'),
            raw.replace(b'123456789', b'Infinity'),
            b"\xff", b"{" + b" " * request.MAX_BYTES, b"[]",
            b"[" * 1500 + b"]" * 1500,
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            path.write_bytes(raw)
            self.assertEqual(request.read_request(path, now=NOW), self.value)
            for raw in bad_inputs:
                path.write_bytes(raw)
                with self.subTest(raw=raw[:30]), self.assertRaises(request.Rejected):
                    request.read_request(path, now=NOW)

    def test_cli_publishes_only_metadata_and_validates_outside_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            command = [sys.executable, str(Path(request.__file__).resolve())]
            env = {**os.environ, **environment(), "UNRELATED_PRIVATE_VALUE": "synthetic-do-not-publish"}
            created = subprocess.run(command + ["--output", str(path)], env=env,
                                     capture_output=True, text=True, check=False)
            self.assertEqual(created.returncode, 0, created.stderr)
            before = path.read_bytes()
            self.assertNotIn(b"synthetic-do-not-publish", before)
            self.assertEqual(set(json.loads(before)), request.FIELDS)
            outside = {k: v for k, v in os.environ.items()
                       if not k.startswith(("GITHUB_", "RUNNER_"))}
            checked = subprocess.run(command + ["--validate", str(path)], env=outside,
                                     capture_output=True, text=True, check=False)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertIn("provenance and execution remain unverified", checked.stdout)
            repeated = subprocess.run(command + ["--output", str(path)], env=env,
                                      capture_output=True, text=True, check=False)
            self.assertNotEqual(repeated.returncode, 0)
            self.assertEqual(path.read_bytes(), before)

    def test_workflow_has_no_request_inputs_or_host_execution_route(self):
        workflow = workflows.capability_request()
        self.assertEqual(workflow["on"], {"workflow_dispatch": {}})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        job = workflow["jobs"]["request"]
        self.assertIn("github.run_attempt == 1", job["if"])
        self.assertIn("github.triggering_actor == 'DruHustle'", job["if"])
        self.assertLessEqual(job["timeout-minutes"], 5)
        commands = [step["run"] for step in job["steps"] if "run" in step]
        self.assertEqual(len(commands), 2)
        self.assertIn('gh api "repos/$GITHUB_REPOSITORY"', commands[0])
        self.assertEqual(commands[1],
                         'python3 scripts/ci/oracle_request.py --output "$RUNNER_TEMP/oracle-capability-request.json"')
        self.assertNotIn("oracle_capability_probe.sh", "\n".join(commands))
        artifact = job["steps"][-1]["with"]
        self.assertEqual(artifact["path"], "${{ runner.temp }}/oracle-capability-request.json")
        self.assertEqual(artifact["if-no-files-found"], "error")
        self.assertNotIn("overwrite", artifact)


if __name__ == "__main__":
    unittest.main()
