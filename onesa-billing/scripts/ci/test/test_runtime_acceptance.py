"""Boundary checks for the CI-only image fixture; none call a Docker daemon."""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "runtime_acceptance.py"
spec = importlib.util.spec_from_file_location("billing_runtime_acceptance", SOURCE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def scanner_report():
    return {
        "SchemaVersion": 2,
        "ArtifactType": "container_image",
        "ArtifactName": "synthetic-runtime",
        "Metadata": {"ImageID": "sha256:" + "a" * 64},
        "Trivy": {"Version": "0.75.0"},
        "Results": [
            {
                "Target": "alpine",
                "Class": "os-pkgs",
                "Type": "alpine",
                "Vulnerabilities": [],
            },
            {
                "Target": "Node.js",
                "Class": "lang-pkgs",
                "Type": "node-pkg",
                "Vulnerabilities": [],
            },
        ],
    }


class SourceAndProofTests(unittest.TestCase):
    def test_active_workflows_match_the_manifest_source_templates(self):
        for source_name, active_name in (
            ("verify.yml", "onesa-billing-verify.yml"),
            ("verify-arm64.yml", "onesa-billing-arm64.yml"),
        ):
            with self.subTest(workflow=active_name):
                source = SOURCE.parent / "workflows" / source_name
                active = runtime.ROOT / ".github/workflows" / active_name
                header = (
                    "# Source: onesa-billing/scripts/ci/workflows/"
                    + source_name
                    + "; keep byte-for-byte content in sync.\n"
                )
                self.assertEqual(active.read_text(), header + source.read_text())

    def test_one_bound_customer_intent_never_relaxes_empty_provider_queues(self):
        runtime.validate_queue_projection("1|1|0|0|0|0|t")
        for value in (
            "1|0|0|0|0|0|f",
            "1|1|0|0|0|0|f",
            "1|2|0|0|0|0|t",
            "1|1|1|0|0|0|t",
            "1|1|0|1|0|0|t",
            "1|1|0|0|1|0|t",
            "1|1|0|0|0|1|t",
            "2|1|0|0|0|0|t",
        ):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(runtime.Refused, "QUEUE"),
            ):
                runtime.validate_queue_projection(value)

    def test_build_base_provenance_requires_both_exact_pinned_from_lines(self):
        original = (SOURCE.parents[2] / "backend/Dockerfile").read_bytes()
        runtime.validate_build_source(original)
        for modified in (
            original.replace(runtime.NODE.encode(), b"node:24", 1),
            original + b"\nFROM unreviewed:latest\n",
            original.replace(
                ("FROM " + runtime.NODE + " AS build").encode(),
                b"FROM ${BASE} AS build",
            ),
        ):
            with self.assertRaisesRegex(runtime.Refused, "BASE_CHANGED"):
                runtime.validate_build_source(modified)

    def source(self):
        env = {
            "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux",
            "RUNNER_ARCH": "X64",
            "GITHUB_REPOSITORY": runtime.REPOSITORY,
            "GITHUB_REPOSITORY_ID": runtime.REPOSITORY_ID,
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40,
        }
        answers = {
            ("rev-parse", "HEAD"): "a" * 40,
            ("config", "--get", "remote.origin.url"): "https://github.com/"
            + runtime.REPOSITORY,
            ("rev-parse", "HEAD^{tree}"): "b" * 40,
            ("rev-parse", "HEAD:onesa-billing"): "c" * 40,
            ("cat-file", "-t", "c" * 40): "tree",
            ("status", "--porcelain", "--untracked-files=normal"): "",
        }
        return env, answers

    def test_exact_hosted_repository_root_and_subtree_are_required(self):
        env, answers = self.source()
        value = runtime.hosted_identity(env, lambda *args: answers[args], "x86_64")
        self.assertEqual(value["product_source_tree"], "c" * 40)
        for key, altered in (
            ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("GITHUB_REPOSITORY", "foreign/repo"),
            ("GITHUB_REPOSITORY", "DruHustle/onesa-ug"),
            ("GITHUB_REPOSITORY_ID", "1"),
            ("GITHUB_REPOSITORY_ID", "1444746154"),
            ("GITHUB_RUN_ATTEMPT", "2"),
            ("GITHUB_SHA", "d" * 40),
            ("GITHUB_EVENT_NAME", "pull_request_target"),
        ):
            with self.subTest(key=key), self.assertRaises(runtime.Refused):
                runtime.hosted_identity(
                    {**env, key: altered}, lambda *args: answers[args], "x86_64"
                )
        with self.assertRaisesRegex(runtime.Refused, "AMD64"):
            runtime.hosted_identity(env, lambda *args: answers[args], "aarch64")
        answers[("status", "--porcelain", "--untracked-files=normal")] = (
            " M onesa-billing/backend/Dockerfile"
        )
        with self.assertRaisesRegex(runtime.Refused, "DIRTY"):
            runtime.hosted_identity(env, lambda *args: answers[args], "x86_64")

    def test_arm64_requires_public_canonical_native_host_and_first_attempt(self):
        env, answers = self.source()
        env.update(RUNNER_ARCH="ARM64", BILLING_REPOSITORY_VISIBILITY="public")
        result = runtime.hosted_identity(
            env, lambda *args: answers[args], "aarch64", "arm64"
        )
        self.assertEqual(result["native_architecture"], "arm64")
        self.assertEqual(result["candidate_commit"], env["GITHUB_SHA"])
        for key, value, machine in (
            ("BILLING_REPOSITORY_VISIBILITY", "private", "aarch64"),
            ("BILLING_REPOSITORY_VISIBILITY", "", "aarch64"),
            ("RUNNER_ENVIRONMENT", "self-hosted", "aarch64"),
            ("RUNNER_ARCH", "X64", "aarch64"),
            ("RUNNER_ARCH", "ARM64", "x86_64"),
            ("RUNNER_OS", "Windows", "aarch64"),
            ("GITHUB_REPOSITORY", "foreign/repo", "aarch64"),
            ("GITHUB_RUN_ATTEMPT", "2", "aarch64"),
        ):
            with (
                self.subTest(key=key, value=value, machine=machine),
                self.assertRaises(runtime.Refused),
            ):
                runtime.hosted_identity(
                    {**env, key: value}, lambda *args: answers[args], machine, "arm64"
                )
        for architecture in ("aarch64", "linux/arm64", "arm", "AMD64", None):
            with (
                self.subTest(architecture=architecture),
                self.assertRaisesRegex(runtime.Refused, "NATIVE_ARCHITECTURE_REFUSED"),
            ):
                runtime.hosted_identity(
                    env, lambda *args: answers[args], "aarch64", architecture
                )

    def test_arm64_image_and_manifest_refuse_an_amd64_or_unbound_proof(self):
        env, answers = self.source()
        env.update(RUNNER_ARCH="ARM64", BILLING_REPOSITORY_VISIBILITY="public")
        source = runtime.hosted_identity(
            env, lambda *args: answers[args], "aarch64", "arm64"
        )
        inspected = {
            "id": "sha256:" + "a" * 64,
            "os": "linux",
            "architecture": "arm64",
            "user": "node",
            "cmd": ["node", "dist/main.js"],
            "entrypoint": ["docker-entrypoint.sh"],
            "labels": {runtime.LABEL: "owned"},
        }
        image = runtime.image_identity(inspected, "owned", "arm64")
        scan = {"status": "PASS", "config_image_id": image["config_image_id"]}
        observed = {
            "mode": "test",
            "sales_enabled": False,
            "external_provider_calls": 0,
            "provider_posts": 0,
        }
        checks = dict.fromkeys(runtime.REQUIRED_CHECKS, True)
        manifest = runtime.verification_manifest(
            source, image, scan, observed, checks, "arm64"
        )
        self.assertEqual(manifest["native_architecture"], "arm64")
        self.assertEqual(manifest["image"]["architecture"], "arm64")
        self.assertTrue(manifest["verification_only"])
        self.assertFalse(manifest["release_authorized"])
        for changed in (
            {**inspected, "architecture": "amd64"},
            {**inspected, "os": "windows"},
        ):
            with (
                self.subTest(changed=changed),
                self.assertRaisesRegex(runtime.Refused, "IMAGE_ARCHITECTURE_REFUSED"),
            ):
                runtime.native_image_identity(changed, "arm64")
        for changed_source, changed_image, changed_checks, architecture in (
            ({**source, "native_architecture": "amd64"}, image, checks, "arm64"),
            (source, {**image, "architecture": "amd64"}, checks, "arm64"),
            (source, image, {**checks, "native_docker_architecture": False}, "arm64"),
            (source, image, checks, "amd64"),
        ):
            with (
                self.subTest(architecture=architecture, source=changed_source),
                self.assertRaises(runtime.Refused),
            ):
                runtime.verification_manifest(
                    changed_source,
                    changed_image,
                    scan,
                    observed,
                    changed_checks,
                    architecture,
                )

    def test_configuration_image_identity_is_not_a_manifest_digest_or_arm_claim(self):
        image = {
            "id": "sha256:" + "a" * 64,
            "os": "linux",
            "architecture": "amd64",
            "user": "node",
            "cmd": ["node", "dist/main.js"],
            "entrypoint": ["docker-entrypoint.sh"],
            "labels": {runtime.LABEL: "owned"},
        }
        value = runtime.image_identity(image, "owned")
        self.assertEqual(value["config_image_id"], image["id"])
        for key, changed in (
            ("architecture", "arm64"),
            ("user", "0"),
            ("cmd", ["node", "other.js"]),
            ("id", "latest"),
            ("labels", {runtime.LABEL: "foreign"}),
        ):
            with self.subTest(key=key), self.assertRaises(runtime.Refused):
                runtime.image_identity({**image, key: changed}, "owned")

    def test_scanner_rejects_high_critical_all_secrets_and_image_substitution(self):
        image = "sha256:" + "a" * 64
        self.assertEqual(
            runtime.scan_summary(scanner_report(), image)["status"], "PASS"
        )
        for result_index in (0, 1):
            for severity in ("HIGH", "CRITICAL"):
                report = scanner_report()
                report["Results"][result_index]["Vulnerabilities"] = [
                    {"Severity": severity, "FixedVersion": ""}
                ]
                with (
                    self.subTest(result_index=result_index, severity=severity),
                    self.assertRaisesRegex(runtime.Refused, "BLOCKING"),
                ):
                    runtime.scan_summary(report, image)
            report = scanner_report()
            report["Results"][result_index]["Secrets"] = [{"Severity": "LOW"}]
            with (
                self.subTest(result_index=result_index, secret=True),
                self.assertRaisesRegex(runtime.Refused, "BLOCKING"),
            ):
                runtime.scan_summary(report, image)
        for change in (
            lambda v: v["Metadata"].update(ImageID="sha256:" + "b" * 64),
            lambda v: v["Trivy"].update(Version="other"),
            lambda v: v.update(Results=[]),
            lambda v: v["Results"].pop(),
            lambda v: v["Results"][0].update(ExperimentalModifiedFindings=[{}]),
            lambda v: v["Results"][0].update(Vulnerabilities=[{"Severity": "invalid"}]),
        ):
            report = scanner_report()
            change(report)
            with self.assertRaises(runtime.Refused):
                runtime.scan_summary(report, image)

    def test_scanner_requires_alpine_and_installed_node_package_coverage(self):
        image = "sha256:" + "a" * 64
        self.assertEqual(
            runtime.scan_summary(scanner_report(), image)["status"], "PASS"
        )
        for name, change in (
            ("missing_node", lambda rows: rows.pop(1)),
            ("missing_alpine", lambda rows: rows.pop(0)),
            ("npm_lockfile_only", lambda rows: rows[1].update(Type="npm")),
            ("other_language", lambda rows: rows[1].update(Type="python-pkg")),
            ("wrong_node_class", lambda rows: rows[1].update(Class="os-pkgs")),
            ("other_os", lambda rows: rows[0].update(Type="debian")),
            ("wrong_os_class", lambda rows: rows[0].update(Class="lang-pkgs")),
        ):
            report = scanner_report()
            change(report["Results"])
            with (
                self.subTest(case=name),
                self.assertRaisesRegex(
                    runtime.Refused, "SCANNER_PACKAGE_COVERAGE_MISSING"
                ),
            ):
                runtime.scan_summary(report, image)

    def test_provenance_requires_all_actual_proofs_and_never_authorizes_deployment(
        self,
    ):
        env, answers = self.source()
        source = runtime.hosted_identity(env, lambda *args: answers[args], "x86_64")
        checks = dict.fromkeys(runtime.REQUIRED_CHECKS, True)
        image = {
            "architecture": "amd64",
            "os": "linux",
            "config_image_id": "sha256:" + "a" * 64,
        }
        scan = {"status": "PASS", "config_image_id": image["config_image_id"]}
        observed = {
            "mode": "test",
            "sales_enabled": False,
            "external_provider_calls": 0,
            "provider_posts": 0,
        }
        record = runtime.verification_manifest(source, image, scan, observed, checks)
        self.assertTrue(record["verification_only"])
        self.assertFalse(record["release_authorized"])
        for key in runtime.REQUIRED_CHECKS:
            with self.subTest(key=key), self.assertRaises(runtime.Refused):
                runtime.verification_manifest(
                    source, image, scan, observed, {**checks, key: False}
                )
        with self.assertRaises(runtime.Refused):
            runtime.verification_manifest(
                source, image, scan, {**observed, "provider_posts": 1}, checks
            )
        with self.assertRaises(runtime.Refused):
            runtime.verification_manifest(
                source,
                image,
                {**scan, "config_image_id": "sha256:" + "b" * 64},
                observed,
                checks,
            )
        with self.assertRaises(runtime.Refused):
            runtime.verification_manifest(
                {**source, "source_path": "onesa-company-portal"},
                image,
                scan,
                observed,
                checks,
            )

    def test_duplicate_nonfinite_and_exclusive_receipts_are_refused(self):
        for value in (b'{"status":true,"status":false}', b'{"count":NaN}'):
            with self.assertRaises(runtime.Refused):
                runtime.json_bytes(value)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "receipt.json"
            runtime.write_once(
                target, {"status": "FAILED", "release_authorized": False}
            )
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                runtime.write_once(target, {"status": "VERIFIED"})


class CommandBoundsTests(unittest.TestCase):
    def command(self):
        value = runtime.Commands.__new__(runtime.Commands)
        value.deadline = time.monotonic() + 10
        value.env = {"PATH": os.defpath, "LANG": "C.UTF-8"}
        return value

    def test_child_exit_is_preserved_and_output_is_capped(self):
        command = self.command()
        code, out, err = command.run(
            [sys.executable, "-c", "import sys;print('fixed');sys.exit(7)"], check=False
        )
        self.assertEqual((code, out, err), (7, b"fixed\n", b""))
        with self.assertRaisesRegex(runtime.Refused, "OUTPUT_BOUND"):
            command.run(
                [sys.executable, "-c", "import sys;sys.stdout.write('x'*3000000)"]
            )

    def test_fixed_operation_and_real_exit_exclude_child_streams_and_arguments(self):
        command = self.command()
        child = (
            "import sys;print('synthetic-private-output');"
            "sys.stderr.write('synthetic-private-error');sys.exit(17)"
        )
        with self.assertRaises(runtime.ScanCommandFailed) as caught:
            command.run([sys.executable, "-c", child], operation="trivy_image_pull")
        self.assertEqual(str(caught.exception), "COMMAND_FAILED")
        self.assertEqual(
            caught.exception.summary,
            {"operation": "trivy_image_pull", "exit_code": 17},
        )
        self.assertNotIn(
            "synthetic-private", runtime.canonical(caught.exception.__dict__).decode()
        )
        self.assertNotIn(
            sys.executable, runtime.canonical(caught.exception.__dict__).decode()
        )
        code, _out, _err = command.run(
            [sys.executable, "-c", child], check=False, operation="trivy_image_pull"
        )
        self.assertEqual(code, 17)
        for invalid in ("arbitrary-argument", [], 1):
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(runtime.Refused, "SCAN_OPERATION_REFUSED"),
            ):
                command.run(["must-not-launch"], operation=invalid)

    def test_scanner_start_stderr_retains_only_closed_indicators_and_unknown(self):
        sensitive = b"sk_" + b"live_" + b"x" * 32
        foreign = b"Bearer " + sensitive + b" /private/customer@example.invalid\xff"
        unknown = {"errno": ["UNKNOWN"], "subsystems": ["UNKNOWN"]}
        self.assertEqual(runtime.scanner_start_indicators(foreign), unknown)
        known = (
            foreign
            + b" OCI runtime create failed: MOUNT /private/file: Permission Denied; read-only file system"
        )
        expected = {
            "errno": ["EACCES", "EROFS"],
            "subsystems": ["OCI_RUNTIME", "MOUNT"],
        }
        self.assertEqual(runtime.scanner_start_indicators(known), expected)
        program = "import sys;sys.stderr.buffer.write(" + repr(known) + ");sys.exit(1)"
        with self.assertRaises(runtime.ScanCommandFailed) as caught:
            self.command().run(
                [sys.executable, "-c", program], operation="scanner_container_start"
            )
        summary = caught.exception.summary
        self.assertEqual(
            summary,
            {
                "operation": "scanner_container_start",
                "exit_code": 1,
                "stderr_indicators": expected,
            },
        )
        self.assertNotIn(sensitive, runtime.canonical(summary))
        self.assertNotIn(b"/private", runtime.canonical(summary))
        self.assertNotIn(b"customer@", runtime.canonical(summary))
        self.assertEqual(set(caught.exception.__dict__), {"summary"})
        self.assertEqual(
            runtime.ScanCommandFailed("scanner_container_wait", 1, known).summary,
            {"operation": "scanner_container_wait", "exit_code": 1},
        )
        for invalid in ("not bytes", b"x" * (2 * 1024 * 1024 + 1)):
            with self.assertRaisesRegex(runtime.Refused, "OUTPUT_BOUND"):
                runtime.scanner_start_indicators(invalid)

    @unittest.skipUnless(hasattr(os, "fork"), "POSIX inherited-pipe fixture")
    def test_exited_leader_with_descendant_pipe_is_killed_before_reap(self):
        command = self.command()
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "unexpected-child-survival"
            program = (
                "import os,time,pathlib;pid=os.fork();\nif pid==0:\n time.sleep(.7);pathlib.Path("
                + repr(str(marker))
                + ").touch()\nelse: os._exit(0)"
            )
            started = time.monotonic()
            with self.assertRaisesRegex(runtime.Refused, "DEADLINE"):
                command.run([sys.executable, "-c", program], timeout=0.15)
            self.assertLess(time.monotonic() - started, 0.65)
            time.sleep(0.75)
            self.assertFalse(marker.exists())

    def test_elapsed_total_budget_prevents_launch(self):
        command = self.command()
        command.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(runtime.Refused, "TOTAL_DEADLINE"):
            command.run(["this-executable-must-never-launch"])


class ScannerProcessDiagnosticsTests(unittest.TestCase):
    def fixture(self, *, states=None, logs=None, deadline=None):
        container = "c" * 64
        observed = {
            "id": container,
            "name": "/onesa-billing-fixture-owned-scanner",
            "image": "sha256:" + "b" * 64,
            "owner": "owned",
            "role": "scanner",
            "status": "exited",
            "running": False,
            "oom_killed": False,
            "exit_code": 17,
        }
        selected_states = iter(states or (observed, observed))

        class DiagnosticCommands:
            def __init__(self):
                self.calls = []
                self.deadline = deadline or time.monotonic() + 30

            def dc(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                if args == (
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    runtime.SCANNER_STATE_FORMAT,
                    container,
                ):
                    return 0, runtime.canonical(next(selected_states)), b""
                if args == ("logs", "--tail", "200", container):
                    if callable(logs):
                        return logs(kwargs["timeout"])
                    return 0, logs or b"", b""
                raise AssertionError("Only the exact narrow reads are allowed")

        commands = DiagnosticCommands()
        fixture = runtime.Fixture(commands, "owned")
        fixture.resources = [
            {
                "kind": "container",
                "role": "scanner",
                "name": "onesa-billing-fixture-owned-scanner",
                "id": container,
                "image": runtime.TRIVY,
                "image_id": observed["image"],
            }
        ]
        return fixture, commands, container, observed

    def test_actual_failed_child_exit_and_logs_project_only_closed_diagnostics(self):
        sensitive = b"sk_" + b"test_" + b"synthetic" * 6
        private = b" /private/tenant/customer@example.invalid Bearer " + sensitive
        logs = (
            b"fatal: failed to initialize cache: permission denied" + private + b"\xff"
        )
        command = CommandBoundsTests().command()
        exit_code, out, err = command.run(
            [
                sys.executable,
                "-c",
                "import sys;sys.stderr.buffer.write(" + repr(logs) + ");sys.exit(17)",
            ],
            check=False,
        )
        self.assertEqual(exit_code, 17)
        fixture, commands, container, _observed = self.fixture(logs=out + err)
        deadline = commands.deadline
        result = fixture.scanner_failure_diagnostics(container, exit_code)
        self.assertEqual(result["status"], "OBSERVED")
        self.assertEqual(
            result["state"],
            {
                "status": "exited",
                "running": False,
                "oom_killed": False,
                "exit_code": 17,
            },
        )
        self.assertEqual(
            result["log_indicators"], {"errno": ["EACCES"], "categories": ["CACHE"]}
        )
        for forbidden in (
            sensitive,
            b"/private",
            b"customer@",
            container.encode(),
            b"owned",
        ):
            self.assertNotIn(forbidden, runtime.canonical(result))
        self.assertEqual(
            [call[0][0] for call in commands.calls], ["inspect", "logs", "inspect"]
        )
        self.assertTrue(all(0 < call[1]["timeout"] <= 4 for call in commands.calls))
        self.assertEqual(commands.deadline, deadline)
        self.assertEqual(
            runtime.scanner_process_indicators(private),
            {"errno": ["UNKNOWN"], "categories": ["UNKNOWN"]},
        )

    def test_log_categories_are_closed_bounded_and_not_raw_failure_causes(self):
        logs = (
            b"database download from registry: x509 certificate; context deadline exceeded; "
            b"extract image archive: invalid tar header; connection reset"
        )
        self.assertEqual(
            runtime.scanner_process_indicators(logs),
            {
                "errno": ["ECONNRESET"],
                "categories": [
                    "DATABASE",
                    "DOWNLOAD",
                    "REGISTRY",
                    "TLS",
                    "TIMEOUT",
                    "EXTRACTION",
                    "IMAGE",
                    "FORMAT",
                ],
            },
        )
        for bad in ("not-bytes", b"x" * (2 * 1024 * 1024 + 1)):
            with self.assertRaisesRegex(runtime.Refused, "OUTPUT_BOUND"):
                runtime.scanner_process_indicators(bad)

    def test_foreign_or_unstopped_state_never_permits_log_read(self):
        _fixture, _commands, _container, good = self.fixture()
        for key, value in (
            ("id", "d" * 64),
            ("name", "/other"),
            ("image", "sha256:" + "e" * 64),
            ("owner", "foreign"),
            ("role", "api"),
            ("status", "running"),
            ("running", True),
            ("oom_killed", "false"),
            ("exit_code", True),
            ("exit_code", 18),
            ("unexpected", "synthetic-private"),
        ):
            with self.subTest(key=key):
                fixture, commands, container, _observed = self.fixture(
                    states=[{**good, key: value}]
                )
                result = fixture.scanner_failure_diagnostics(container, 17)
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertIsNone(result["state"])
                self.assertEqual(len(commands.calls), 1)
                self.assertNotIn(b"synthetic-private", runtime.canonical(result))
        fixture, commands, container, _observed = self.fixture()
        fixture.resources[0]["image"] = "unreviewed:latest"
        self.assertEqual(
            fixture.scanner_failure_diagnostics(container, 17)["status"], "UNAVAILABLE"
        )
        self.assertEqual(commands.calls, [])

    def test_changed_post_log_custody_or_state_discards_all_log_indicators(self):
        _fixture, _commands, _container, good = self.fixture()
        for key, value in (
            ("owner", "foreign"),
            ("oom_killed", True),
            ("exit_code", 18),
        ):
            with self.subTest(key=key):
                fixture, commands, container, _observed = self.fixture(
                    states=[good, {**good, key: value}],
                    logs=b"cache: permission denied",
                )
                result = fixture.scanner_failure_diagnostics(container, 17)
                self.assertEqual(result["status"], "STATE_ONLY")
                self.assertEqual(result["state"]["exit_code"], 17)
                self.assertFalse(result["state"]["oom_killed"])
                self.assertEqual(
                    result["log_indicators"],
                    {"errno": ["UNKNOWN"], "categories": ["UNKNOWN"]},
                )
                self.assertEqual(len(commands.calls), 3)

    def test_real_log_deadline_and_output_failure_remain_optional_without_retry(self):
        for body, budget in (
            ("import time;time.sleep(2)", 0.1),
            ("import sys;sys.stdout.write('x'*3000000)", 2),
        ):
            with self.subTest(body=body):
                command = CommandBoundsTests().command()
                command.deadline = time.monotonic() + budget

                def logs(timeout, command=command, body=body):
                    return command.run([sys.executable, "-c", body], timeout=timeout)

                fixture, commands, container, _observed = self.fixture(
                    logs=logs, deadline=command.deadline
                )
                deadline = commands.deadline
                began = time.monotonic()
                result = fixture.scanner_failure_diagnostics(container, 17)
                self.assertEqual(result["status"], "STATE_ONLY")
                self.assertEqual(
                    result["log_indicators"],
                    {"errno": ["UNKNOWN"], "categories": ["UNKNOWN"]},
                )
                self.assertEqual(
                    [call[0][0] for call in commands.calls], ["inspect", "logs"]
                )
                self.assertEqual(commands.deadline, deadline)
                self.assertLess(time.monotonic() - began, budget + 0.5)
        fixture, commands, container, _observed = self.fixture(
            deadline=time.monotonic() - 1
        )
        self.assertEqual(
            fixture.scanner_failure_diagnostics(container, 17)["status"], "UNAVAILABLE"
        )
        self.assertEqual(commands.calls, [])


class CleanupTests(unittest.TestCase):
    def test_foreign_or_unknown_resource_is_not_removed(self):
        class FakeCommands:
            deadline = 0

            def __init__(self):
                self.calls = []

            def dc(self, *args, **_kwargs):
                self.calls.append(args)
                if args[0] == "inspect":
                    return (
                        0,
                        json.dumps(
                            {"name": "/owned", "labels": {runtime.LABEL: "foreign"}}
                        ).encode(),
                        b"",
                    )
                raise AssertionError("No removal is allowed")

        commands = FakeCommands()
        fixture = runtime.Fixture(commands, "expected")
        fixture.resources = [
            {"kind": "container", "name": "owned", "id": "a" * 64, "role": "api"}
        ]
        self.assertFalse(fixture.cleanup())
        self.assertEqual(len(commands.calls), 1)

    def test_cleanup_uses_only_bound_exact_ids_and_failed_cleanup_prevents_success(
        self,
    ):
        class FakeCommands:
            deadline = 0

            def __init__(self):
                self.calls = []

            def dc(self, *args, **_kwargs):
                self.calls.append(args)
                if args[0] == "inspect":
                    return (
                        0,
                        json.dumps(
                            {
                                "id": "a" * 64,
                                "image": "sha256:" + "b" * 64,
                                "name": "/owned",
                                "labels": {
                                    runtime.LABEL: "expected",
                                    runtime.ROLE_LABEL: "api",
                                },
                            }
                        ).encode(),
                        b"",
                    )
                if args == ("rm", "--force", "--volumes", "a" * 64):
                    raise runtime.Refused("COMMAND_FAILED")
                raise AssertionError("Unexpected command")

        commands = FakeCommands()
        fixture = runtime.Fixture(commands, "expected")
        fixture.resources = [
            {
                "kind": "container",
                "name": "owned",
                "id": "a" * 64,
                "image_id": "sha256:" + "b" * 64,
                "role": "api",
            }
        ]
        self.assertFalse(fixture.cleanup())
        self.assertEqual(commands.calls[-1], ("rm", "--force", "--volumes", "a" * 64))


class ScannerFindingsDiagnosticTests(unittest.TestCase):
    def test_advisories_retain_only_bounded_ids_severity_and_package_category(self):
        report = scanner_report()
        for row, advisory, severity in (
            (0, "CVE-2026-12345", "HIGH"),
            (1, "GHSA-2345-6789-cfgh", "CRITICAL"),
        ):
            report["Results"][row]["Vulnerabilities"] = [
                {
                    "VulnerabilityID": advisory,
                    "Severity": severity,
                    "PkgName": "synthetic-private-package",
                    "InstalledVersion": "synthetic-private-version",
                    "FixedVersion": "",
                    "Description": "synthetic-private-description",
                }
            ]
            report["Results"][row]["Target"] = "synthetic-private-path"
        with self.assertRaises(runtime.ScanFindingsFailed) as caught:
            runtime.scan_summary(report, "sha256:" + "a" * 64)
        result = caught.exception.summary
        self.assertEqual(str(caught.exception), "SCANNER_BLOCKING_FINDINGS")
        self.assertEqual(result["status"], "OBSERVED")
        self.assertEqual(
            result["blocking_advisories"],
            [
                {"id": "CVE-2026-12345", "severity": "HIGH", "package_type": "ALPINE"},
                {
                    "id": "GHSA-2345-6789-cfgh",
                    "severity": "CRITICAL",
                    "package_type": "NODE",
                },
            ],
        )
        self.assertEqual(result["vulnerability_counts"]["HIGH"], 1)
        self.assertEqual(result["vulnerability_counts"]["CRITICAL"], 1)
        self.assertEqual(result["secret_findings"], 0)
        self.assertNotIn(b"synthetic-private", runtime.canonical(result))

    def test_advisory_count_and_identifier_format_are_bounded(self):
        report = scanner_report()
        report["Results"][1]["Vulnerabilities"] = [
            {"VulnerabilityID": f"CVE-2026-{10000 + number}", "Severity": "HIGH"}
            for number in range(55)
        ] + [
            {"VulnerabilityID": invalid, "Severity": "HIGH"}
            for invalid in (
                "synthetic-private-identifier",
                "CVE-2026-" + "1" * 1000,
                "CVE-2026-1234\nsynthetic-private-suffix",
                ["CVE-2026-1234"],
                None,
            )
        ]
        with self.assertRaises(runtime.ScanFindingsFailed) as caught:
            runtime.scan_summary(report, "sha256:" + "a" * 64)
        result = caught.exception.summary
        self.assertEqual(result["vulnerability_counts"]["HIGH"], 60)
        self.assertEqual(len(result["blocking_advisories"]), 50)
        self.assertEqual(result["omitted_advisory_count"], 5)
        self.assertEqual(result["unidentified_vulnerability_count"], 5)
        self.assertLess(len(runtime.canonical(result)), 8192)
        self.assertNotIn(b"synthetic-private", runtime.canonical(result))

    def test_secret_findings_publish_only_count_and_closed_rule_categories(self):
        report = scanner_report()
        report["Results"].append(
            {
                "Target": "synthetic-private-path",
                "Class": [],
                "Type": {},
                "Secrets": [
                    {
                        "RuleID": rule,
                        "Match": "synthetic-private-secret",
                        "Code": "synthetic-private-snippet",
                        "Title": "synthetic-private-title",
                    }
                    for rule in (
                        "private-key",
                        "stripe-secret-token",
                        "synthetic-private-rule",
                        [],
                    )
                ]
                + ["synthetic-private-nonobject"],
            }
        )
        with self.assertRaises(runtime.ScanFindingsFailed) as caught:
            runtime.scan_summary(report, "sha256:" + "a" * 64)
        result = caught.exception.summary
        self.assertEqual(result["secret_findings"], 5)
        self.assertEqual(
            result["secret_rule_categories"], ["OTHER", "PRIVATE_KEY", "STRIPE"]
        )
        self.assertEqual(result["blocking_advisories"], [])
        self.assertNotIn(b"synthetic-private", runtime.canonical(result))

    def test_optional_diagnostic_error_never_changes_the_blocking_failure(self):
        report = scanner_report()
        report["Results"][1]["Secrets"] = [{}]
        with (
            patch.object(
                runtime,
                "blocking_findings_summary",
                side_effect=RuntimeError("synthetic-private-error"),
            ),
            self.assertRaises(runtime.ScanFindingsFailed) as caught,
        ):
            runtime.scan_summary(report, "sha256:" + "a" * 64)
        self.assertEqual(str(caught.exception), "SCANNER_BLOCKING_FINDINGS")
        self.assertEqual(caught.exception.summary, {"status": "UNAVAILABLE"})


class ScannerWorkspaceTests(unittest.TestCase):
    def test_minimum_space_creates_private_cache_and_temporary_directories(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                runtime.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=runtime.SCANNER_MIN_FREE_BYTES),
            ) as disk_usage,
        ):
            work = Path(directory)
            workspace = runtime.scanner_workspace(work)
            disk_usage.assert_called_once_with(work)
            self.assertEqual(workspace.parent, work)
            self.assertEqual(
                {path.name for path in workspace.iterdir()}, {"cache", "tmp"}
            )
            for path in (workspace, workspace / "cache", workspace / "tmp"):
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                self.assertEqual(path.stat().st_uid, os.getuid())
                self.assertFalse(path.is_symlink())

    def test_insufficient_disk_space_refuses_before_creating_workspace(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                runtime.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=runtime.SCANNER_MIN_FREE_BYTES - 1),
            ),
        ):
            with self.assertRaisesRegex(runtime.Refused, "SCANNER_DISK_SPACE"):
                runtime.scanner_workspace(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_workspace_or_symlink_is_never_reused(self):
        for symlink in (False, True):
            with (
                self.subTest(symlink=symlink),
                tempfile.TemporaryDirectory() as directory,
                patch.object(
                    runtime.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(free=runtime.SCANNER_MIN_FREE_BYTES),
                ),
            ):
                root = Path(directory)
                work = root / "owned"
                work.mkdir()
                target = root / "foreign" if symlink else work / "scanner"
                target.mkdir()
                marker = target / "marker"
                marker.write_text("untouched")
                if symlink:
                    (work / "scanner").symlink_to(target, target_is_directory=True)
                with self.assertRaises(FileExistsError):
                    runtime.scanner_workspace(work)
                self.assertEqual(marker.read_text(), "untouched")
                self.assertEqual({path.name for path in target.iterdir()}, {"marker"})


class ScanOperationReceiptTests(unittest.TestCase):
    def test_each_scan_command_failure_is_retained_without_success_or_raw_output(self):
        source = {
            "candidate_commit": "a" * 40,
            "source_tree": "b" * 40,
            "product_source_tree": "c" * 40,
        }
        failures = (
            *sorted(runtime.SCAN_COMMAND_OPERATIONS),
            "scanner_exit",
            "scanner_disk_space",
            "scanner_findings",
            "daemon_mismatch",
            "scanner_architecture",
            "postgres_architecture",
        )
        for architecture, failure in (
            (arch, failure) for arch in ("amd64", "arm64") for failure in failures
        ):
            with (
                self.subTest(architecture=architecture, failure=failure),
                tempfile.TemporaryDirectory() as directory,
            ):
                parent = Path(directory)
                foreign = parent / "foreign"
                foreign.write_text("untouched")
                scanner_paths = []

                class FakeCommands:
                    failed_operation = failure
                    native_architecture = architecture
                    test_case = self
                    created_workspaces = scanner_paths

                    def __init__(self, work, deadline):
                        self.deadline = deadline
                        self.work = work

                    def git(self, *_args):
                        raise AssertionError("Source identity is a separate fixture")

                    def dc(self, *args, operation=None, **_kwargs):
                        if operation == self.failed_operation:
                            raise runtime.ScanCommandFailed(operation, 17)
                        if args[0] == "info":
                            actual = self.native_architecture
                            if self.failed_operation == "daemon_mismatch":
                                actual = "arm64" if actual == "amd64" else "amd64"
                            return (
                                0,
                                runtime.canonical(
                                    {"os": "linux", "architecture": actual}
                                ),
                                b"",
                            )
                        if args[0] == "build":
                            self.test_case.assertEqual(
                                args[args.index("--platform") + 1],
                                "linux/" + self.native_architecture,
                            )
                            Path(args[args.index("--iidfile") + 1]).write_text(
                                "sha256:" + "a" * 64
                            )
                            return 0, b"", b""
                        if args[:2] == ("image", "inspect"):
                            if args[3] == "{{.Id}}":
                                return 0, ("sha256:" + "b" * 64).encode(), b""
                            actual = self.native_architecture
                            if (
                                self.failed_operation == "scanner_architecture"
                                and args[-1] == runtime.TRIVY
                            ) or (
                                self.failed_operation == "postgres_architecture"
                                and args[-1] == runtime.POSTGRES
                            ):
                                actual = "arm64" if actual == "amd64" else "amd64"
                            return (
                                0,
                                runtime.canonical(
                                    {
                                        "id": "sha256:" + "a" * 64,
                                        "os": "linux",
                                        "architecture": actual,
                                        "user": "node",
                                        "cmd": ["node", "dist/main.js"],
                                        "entrypoint": ["docker-entrypoint.sh"],
                                        "labels": {runtime.LABEL: "owned"},
                                    }
                                ),
                                b"",
                            )
                        if args[0] in {"pull", "save", "start"}:
                            if args[0] == "pull":
                                self.test_case.assertEqual(
                                    args[args.index("--platform") + 1],
                                    "linux/" + self.native_architecture,
                                )
                            return 0, b"", b""
                        if args[0] == "create":
                            workspace = self.work / "scanner"
                            for option in (
                                "--read-only",
                                "no-new-privileges",
                                "TRIVY_CACHE_DIR=/scanner/cache",
                                "TMPDIR=/scanner/tmp",
                                "/tmp:rw,nosuid,nodev,size=512m",
                                f"type=bind,src={workspace},dst=/scanner",
                                f"type=bind,src={self.work / 'reports'},dst=/reports",
                                runtime.TRIVY,
                            ):
                                self.test_case.assertIn(option, args)
                            for option, value in (
                                ("--cap-drop", "ALL"),
                                ("--user", f"{os.getuid()}:{os.getgid()}"),
                                ("--pids-limit", "100"),
                                ("--memory", "1g"),
                                ("--timeout", "3m"),
                                ("--scanners", "vuln,secret"),
                            ):
                                self.test_case.assertEqual(
                                    args[args.index(option) + 1], value
                                )
                            for child in ("cache", "tmp"):
                                path = workspace / child
                                self.test_case.assertEqual(
                                    path.stat().st_mode & 0o777, 0o700
                                )
                                (path / "discarded-scanner-data").write_text("private")
                            self.created_workspaces.append(workspace)
                            return 0, ("c" * 64).encode(), b""
                        if args[0] == "inspect":
                            return (
                                0,
                                runtime.canonical(
                                    {
                                        "id": "c" * 64,
                                        "name": "/onesa-billing-fixture-owned-scanner",
                                        "image": "sha256:" + "b" * 64,
                                        "labels": {
                                            runtime.LABEL: "owned",
                                            runtime.ROLE_LABEL: "scanner",
                                        },
                                    }
                                ),
                                b"",
                            )
                        if (
                            args[0] == "wait"
                            and self.failed_operation == "scanner_exit"
                        ):
                            return 0, b"7\n", b""
                        if (
                            args[0] == "wait"
                            and self.failed_operation == "scanner_findings"
                        ):
                            report = scanner_report()
                            report["Results"][1]["Vulnerabilities"] = [
                                {
                                    "VulnerabilityID": "CVE-2026-12345",
                                    "Severity": "HIGH",
                                }
                            ]
                            report["Results"][1]["Secrets"] = [
                                {
                                    "RuleID": "private-key",
                                    "Match": "synthetic-private-secret",
                                }
                            ]
                            (self.work / "reports/runtime.json").write_bytes(
                                runtime.canonical(report)
                            )
                            return 0, b"0\n", b""
                        raise AssertionError("Unexpected fixture command")

                with (
                    patch.object(runtime, "Commands", FakeCommands),
                    patch.object(
                        runtime,
                        "hosted_identity",
                        return_value={**source, "native_architecture": architecture},
                    ),
                    patch.object(runtime.secrets, "token_hex", return_value="owned"),
                    patch.object(
                        runtime.Fixture, "cleanup", return_value=True
                    ) as cleanup,
                    patch.object(runtime, "phase"),
                    patch.object(runtime, "runtime_checks") as runtime_checks,
                    patch.object(
                        runtime.shutil,
                        "disk_usage",
                        return_value=SimpleNamespace(
                            free=runtime.SCANNER_MIN_FREE_BYTES
                            - (failure == "scanner_disk_space")
                        ),
                    ),
                    patch.object(
                        runtime.Fixture,
                        "scanner_failure_diagnostics",
                        side_effect=RuntimeError("synthetic-private-diagnostic-error"),
                    ) as diagnostic,
                    patch.dict(os.environ, {"RUNNER_TEMP": str(parent)}),
                    patch.object(
                        sys,
                        "argv",
                        [
                            "runtime",
                            "--native-architecture",
                            architecture,
                            "--output",
                            str(parent / "result"),
                        ],
                    ),
                ):
                    self.assertEqual(runtime.main(), 1)
                cleanup.assert_called_once()
                runtime_checks.assert_not_called()
                result = json.loads((parent / "result/receipt.json").read_bytes())
                self.assertEqual(result["status"], "FAILED")
                self.assertFalse(result["release_authorized"])
                self.assertTrue(result["cleanup"])
                self.assertFalse((parent / "result/manifest.json").exists())
                self.assertEqual(foreign.read_text(), "untouched")
                self.assertEqual(
                    {path.name for path in parent.iterdir()}, {"result", "foreign"}
                )
                self.assertEqual(
                    {path.name for path in (parent / "result").iterdir()},
                    {"receipt.json"},
                )
                for path in scanner_paths:
                    self.assertFalse(path.exists())
                if failure in {
                    "daemon_mismatch",
                    "scanner_architecture",
                    "postgres_architecture",
                }:
                    self.assertEqual(
                        result["failure"],
                        "DOCKER_ARCHITECTURE_REFUSED"
                        if failure == "daemon_mismatch"
                        else "IMAGE_ARCHITECTURE_REFUSED",
                    )
                    self.assertEqual(scanner_paths, [])
                    self.assertNotIn("command_failure", result)
                    self.assertNotIn("scanner_failure", result)
                    diagnostic.assert_not_called()
                elif failure == "scanner_disk_space":
                    self.assertEqual(result["failure"], "SCANNER_DISK_SPACE")
                    self.assertNotIn("command_failure", result)
                    self.assertNotIn("scanner_failure", result)
                    self.assertEqual(scanner_paths, [])
                    diagnostic.assert_not_called()
                elif failure == "scanner_findings":
                    self.assertEqual(result["failure"], "SCANNER_BLOCKING_FINDINGS")
                    self.assertNotIn("command_failure", result)
                    self.assertNotIn("scanner_failure", result)
                    self.assertEqual(
                        result["scanner_findings"]["vulnerability_counts"]["HIGH"], 1
                    )
                    self.assertEqual(result["scanner_findings"]["secret_findings"], 1)
                    self.assertEqual(
                        result["scanner_findings"]["secret_rule_categories"],
                        ["PRIVATE_KEY"],
                    )
                    diagnostic.assert_not_called()
                elif failure == "scanner_exit":
                    self.assertEqual(result["failure"], "SCANNER_FAILED")
                    self.assertNotIn("command_failure", result)
                    self.assertEqual(
                        result["scanner_failure"],
                        {"exit_code": 7, "diagnostics": {"status": "UNAVAILABLE"}},
                    )
                    diagnostic.assert_called_once_with("c" * 64, 7)
                else:
                    diagnostic.assert_not_called()
                    self.assertNotIn("scanner_failure", result)
                    self.assertEqual(result["failure"], "COMMAND_FAILED")
                    expected = {"operation": failure, "exit_code": 17}
                    if failure == "scanner_container_start":
                        expected["stderr_indicators"] = {
                            "errno": ["UNKNOWN"],
                            "subsystems": ["UNKNOWN"],
                        }
                    self.assertEqual(
                        result["command_failure"],
                        expected,
                    )
                self.assertNotIn("scan_passed", result["checks"])
                self.assertNotIn(b"synthetic-private", runtime.canonical(result))


if __name__ == "__main__":
    unittest.main()
