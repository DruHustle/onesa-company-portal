"""Disposable scanner contracts, real signatures and interrupted-request guards.

These tests use synthetic identities and local ledgers, never a hosted issuer.
"""

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_scanner as scanner
import test_oracle_owner as fixtures


def inputs():
    binding = {
        "repository": scanner.REPOSITORY,
        "component": "scanner",
        "candidate_commit": "a" * 40,
        "source_tree": "b" * 40,
        "source_sha256": "c" * 64,
        "build_sha256": "d" * 64,
        "artifact_digest": "sha256:" + "e" * 64,
        "configuration_sha256": {},
        "target_environment": "production",
    }
    plan = {
        "schema_version": 1,
        "verifier_store": "/var/lib/onesa/release-verification/synthetic",
        "baseline": {
            name: {"image": "sha256:" + "f" * 64, "container_id": "f" * 64}
            for name in [scanner.TARGET, *["synthetic-" + str(i) for i in range(10)]]
        },
        "runtime": {
            "user": "clamav",
            "entrypoint": ["/usr/local/bin/onesa-clamav"],
            "command": None,
            "read_only": True,
            "privileged": False,
            "cap_add": None,
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "group_add": ["3000"],
            "port_bindings": {},
            "memory": 4 * 1024**3,
            "nano_cpus": 800000000,
            "pids_limit": 128,
            "init": True,
            "mounts": [
                {"Destination": name, "Type": "volume", "RW": True, "Name": volume}
                for name, volume in [
                    ("/var/lib/clamav", "synthetic-definitions"),
                    ("/run/onesa-scanner", "synthetic-socket"),
                ]
            ],
            "networks": ["synthetic-signatures"],
        },
        "recipe": {
            "project": "onesa-portal-oracle-staging",
            "directory": str(scanner.ROOT / "artifacts" / binding["source_tree"]),
            "files": [
                {
                    "path": str(
                        scanner.ROOT
                        / "artifacts"
                        / binding["source_tree"]
                        / "compose.oracle-staging.yaml"
                    ),
                    "sha256": "0" * 64,
                }
            ],
        },
        "rollback": {"automatic": False, "artifact_digest": "sha256:" + "f" * 64},
        "legacy_backup": {},
    }
    application = copy.deepcopy(binding)
    application.update(
        component="worker",
        build_sha256="2" * 64,
        artifact_digest="sha256:" + "1" * 64,
        configuration_sha256={"staging": "3" * 64, "production": "4" * 64},
    )
    plan["workflow"] = {
        "application_binding": application,
        "fixture_id": "01234567-89ab-4cde-8123-456789abcdef",
        "expires_at": "2026-10-28T23:00:00.000Z",
        "runtime_sha256": "3" * 64,
        "certificate_sha256": "5" * 64,
        "private_key_sha256": "6" * 64,
        "owner_custody_sha256": "7" * 64,
        "application_scan_sha256": "8" * 64,
    }
    seal(binding, plan)
    return binding, plan


def seal(binding, plan):
    binding["configuration_sha256"] = {
        env: hashlib.sha256(r.canonical(scanner.configuration(plan, env))).hexdigest()
        for env in ["staging", "production"]
    }


def rendered(binding, plan, context):
    # Sanitized public Compose-render contract, never a provider receipt.
    value = json.loads(
        Path(__file__).with_name("scanner-compose.fixture.json").read_bytes()
    )
    service = value["services"]["scanner"]
    service["image"] = binding["artifact_digest"]
    service["build"]["context"] = plan["recipe"]["directory"] + "/infra/oracle/clamav"
    service["labels"] = {
        "org.onesa.source-commit": binding["candidate_commit"],
        "org.onesa.release-operation": context["operation_id"],
    }
    return value


class PlanTests(unittest.TestCase):
    def test_separate_source_and_configuration_bound_to_only_scanner(self):
        binding, plan = inputs()
        self.assertEqual(
            scanner.validate_plan(binding, plan),
            scanner.ROOT / "artifacts" / binding["source_tree"],
        )
        self.assertNotEqual(*binding["configuration_sha256"].values())
        for key, value in [
            ("repository", "foreign/repo"),
            ("component", "worker"),
            ("target_environment", "staging"),
            ("candidate_commit", "main"),
        ]:
            changed = {**binding, key: value}
            with self.subTest(key=key), self.assertRaises(r.Refused):
                scanner.validate_plan(changed, plan)

    def test_writable_credentials_public_ports_privilege_or_unbound_recipe_fail(self):
        for change in [
            lambda p: p["runtime"].update(privileged=True),
            lambda p: p["runtime"].update(read_only=False),
            lambda p: p["runtime"].update(
                port_bindings={"3310/tcp": [{"HostPort": "3310"}]}
            ),
            lambda p: p["runtime"].update(cap_add=["SYS_ADMIN"]),
            lambda p: p["runtime"]["mounts"].append(
                {"Type": "bind", "RW": True, "Destination": "/private"}
            ),
            lambda p: p["runtime"]["mounts"][0].update(Type="bind"),
            lambda p: p["recipe"].update(project="different-project"),
            lambda p: p["recipe"]["files"].append(p["recipe"]["files"][0]),
            lambda p: p["rollback"].update(automatic=True),
            lambda p: p["baseline"].pop("synthetic-0"),
        ]:
            binding, plan = inputs()
            change(plan)
            seal(binding, plan)  # Even a newly bound unsafe profile is refused.
            with self.assertRaises(r.Refused):
                scanner.validate_plan(binding, plan)
        binding, plan = inputs()
        plan["recipe"]["files"][0]["sha256"] = "1" * 64
        with self.assertRaisesRegex(r.Refused, "CONFIGURATION_CHANGED"):
            scanner.validate_plan(binding, plan)

    def test_all_mandatory_checks_remain_required(self):
        import oracle_owner

        self.assertEqual(scanner.CHECKS, oracle_owner.REQUIRED_CHECKS)

    def test_unexpected_rendered_settings_or_changed_shared_volumes_fail_before_request(
        self,
    ):
        binding, plan = inputs()
        context = {"operation_id": str(uuid4())}
        original = rendered(binding, plan, context)
        labels = original["services"]["scanner"]["labels"]
        scanner.composed_recipe(original, binding, plan, labels)
        for change in [
            lambda v: v["services"]["scanner"].update(
                environment={"DATABASE_URL": "synthetic"}
            ),
            lambda v: v["services"]["scanner"].update(privileged=True),
            lambda v: v["services"]["scanner"].update(devices=["/dev/synthetic"]),
            lambda v: v["services"]["scanner"].update(ports=["3310:3310"]),
            lambda v: v["services"]["scanner"]["volumes"][0].update(
                type="bind", source="/etc"
            ),
            lambda v: v["volumes"]["scanner_socket"].update(name="different-socket"),
            lambda v: v["networks"]["signature_updates"].update(
                name="different-network"
            ),
        ]:
            value = copy.deepcopy(original)
            change(value)
            with self.assertRaises(r.Refused):
                scanner.composed_recipe(value, binding, plan, labels)

    def test_signed_invocation_precedes_any_container_or_provider_operation(self):
        binding, plan = inputs()
        for phase in scanner.CHECKS:
            with (
                patch.object(r, "read", return_value=plan),
                patch.object(
                    r, "verify_invocation", side_effect=r.Refused("FORGED_OWNER")
                ),
                patch.object(r, "docker") as docker,
                patch.object(r, "command") as command,
                self.subTest(phase=phase),
                self.assertRaises(r.Refused),
            ):
                scanner.runner(
                    phase, binding, {"workflow_run_id": 0, "owner_approved": True}
                )
            docker.assert_not_called()
            command.assert_not_called()

    def test_entire_host_configuration_is_preserved_without_exporting_environment(self):
        row = {
            "Config": {
                "Env": ["SYNTHETIC_PRIVATE=never-export-this"],
                "User": "clamav",
                "Entrypoint": ["entry"],
                "Cmd": None,
                "Healthcheck": {},
                "Hostname": "old",
            },
            "HostConfig": {
                "ReadonlyRootfs": True,
                "Privileged": False,
                "CapAdd": None,
                "CapDrop": ["ALL"],
                "SecurityOpt": [],
                "GroupAdd": ["3000"],
                "Memory": 1,
                "NanoCpus": 1,
                "PidsLimit": 64,
                "RestartPolicy": {},
                "Init": True,
                "Tmpfs": {},
                "PortBindings": {},
                "NetworkMode": "network",
                "Devices": [],
            },
            "NetworkSettings": {"Networks": {"network": {}}},
            "Mounts": [],
        }
        before = scanner.profile(row)
        self.assertNotIn("never-export-this", json.dumps(before))
        row["Config"]["Hostname"] = "new-container-hostname"
        self.assertEqual(scanner.profile(row), before)
        row["HostConfig"]["Devices"] = [{"PathOnHost": "/dev/synthetic"}]
        self.assertNotEqual(scanner.profile(row), before)
        row["HostConfig"]["Binds"] = [
            "synthetic-signatures:/var/lib/clamav:rw",
            "synthetic-socket:/run/onesa-scanner:rw",
        ]
        ordered = scanner.profile(row)
        row["HostConfig"]["Binds"].reverse()
        self.assertEqual(scanner.profile(row), ordered)
        row["HostConfig"]["Binds"][0] += ",nocopy"
        self.assertNotEqual(scanner.profile(row), ordered)
        row["HostConfig"]["Binds"] = [
            "synthetic-a:/var/lib/clamav:rw",
            "synthetic-b:/var/lib/clamav:rw",
        ]
        with self.assertRaisesRegex(r.Refused, "SCANNER_AMBIGUOUS_BIND_CONFIGURATION"):
            scanner.profile(row)


class SignedScannerContextTests(unittest.TestCase):
    component = "scanner"

    @classmethod
    def setUpClass(cls):
        fixtures.OwnerStoreTests.setUpClass()

    def setUp(self):
        self.owner = fixtures.OwnerStoreTests(
            "test_valid_owner_run_chain_keeps_actual_CI_and_observed_identity"
        )
        self.owner.setUp()
        self.addCleanup(self.owner.doCleanups)
        self.owner.store.db.close()
        self.owner.binding["component"] = self.component
        policy = self.owner.policy
        policy["components"][scanner.REPOSITORY + ":" + self.component] = policy[
            "components"
        ].pop(scanner.REPOSITORY + ":api")
        (self.owner.root / "policy.json").write_bytes(r.canonical(policy))
        trust = json.loads((self.owner.root / "trust.json").read_bytes())
        trust["policy_sha256"] = r.sha(self.owner.root / "policy.json")
        (self.owner.root / "trust.json").write_bytes(r.canonical(trust))
        self.owner.commission_fixture()
        self.owner.store = self.owner.open()
        self.addCleanup(self.owner.store.db.close)
        self.plan = {"verifier_store": str(self.owner.root)}
        self.trust = trust
        original_read = r.read

        def read(path):
            if str(path) == "/etc/onesa/oracle-release-trust.json":
                return {
                    "installations": {str(self.owner.root): {**trust, "active": True}}
                }
            return original_read(path)

        # Only custody/registry location is substituted for an unprivileged test.
        # All record bytes, Ed25519 signatures, scope and ledger reads are real.
        self.enterContext(patch.object(r, "private", side_effect=Path))
        self.enterContext(patch.object(r, "read", side_effect=read))

    def reserve(self):
        context = self.owner.context()
        self.owner.store.db.execute(
            "UPDATE contexts SET state='reserved' WHERE id=?", (context,)
        )
        return context

    def verify(self, context, binding=None):
        return r.verify_invocation(
            binding or self.owner.binding, {"context_id": context}, "staging", self.plan
        )

    def test_valid_owner_zero_retains_positive_underlying_ci(self):
        result = self.verify(self.reserve())
        self.assertEqual(result[0]["workflow_run_id"], 0)
        self.assertEqual(result[0]["details"]["ci"][0]["run_id"], 123)

    def test_issued_consumed_revoked_modified_or_expired_contexts_refuse(self):
        context = self.owner.context()
        with self.assertRaises(r.Refused):
            self.verify(context)
        for state in ["consumed", "issued"]:
            self.owner.store.db.execute(
                "UPDATE contexts SET state=? WHERE id=?", (state, context)
            )
            with self.subTest(state=state), self.assertRaises(r.Refused):
                self.verify(context)
        self.owner.store.db.execute(
            "UPDATE contexts SET state='reserved' WHERE id=?", (context,)
        )
        self.owner.store.revoke(context)
        with self.assertRaises(r.Refused):
            self.verify(context)
        context = self.reserve()
        envelope = self.owner.store.get(context)["record"]
        modified = self.owner.store.get(context)
        modified["record"]["binding"]["candidate_commit"] = "f" * 40
        self.owner.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?",
            (r.canonical(modified).decode(), context),
        )
        with self.assertRaises(r.Refused):
            self.verify(context)
        self.owner.store.clock = lambda: r.now() - timedelta(hours=2)
        context = self.reserve()
        with self.assertRaisesRegex(r.Refused, "EXPIRED"):
            self.verify(context)
        self.assertEqual(envelope["binding"]["component"], self.component)

    def test_wrong_source_component_environment_or_artifact_never_transfers_authority(
        self,
    ):
        context = self.reserve()
        for key, value in [
            ("component", "worker" if self.component == "scanner" else "scanner"),
            ("candidate_commit", "f" * 40),
            ("artifact_digest", "sha256:" + "f" * 64),
            ("target_environment", "staging"),
        ]:
            binding = {**self.owner.binding, key: value}
            with self.subTest(key=key), self.assertRaises(r.Refused):
                self.verify(context, binding)
        for foreign in [
            "123",
            json.dumps({"workflow_run_id": 0, "owner_approved": True}),
        ]:
            with self.assertRaises((r.Refused, ValueError)):
                self.verify(foreign)


class RequestJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binding, self.plan = inputs()
        self.context = {"operation_id": str(uuid4()), "authorization_id": str(uuid4())}
        self.enterContext(patch.object(scanner, "ROOT", self.root))
        self.enterContext(
            patch.object(r, "private", side_effect=lambda p, **_kw: Path(p))
        )
        self.enterContext(patch.object(scanner, "retained", return_value={}))
        self.enterContext(patch.object(scanner, "image", return_value={}))
        self.enterContext(
            patch.object(scanner, "recipe_command", return_value=["synthetic-compose"])
        )
        self.enterContext(
            patch.object(
                r,
                "command",
                return_value=r.canonical(
                    rendered(self.binding, self.plan, self.context)
                ),
            )
        )

    def test_interrupted_request_is_durable_and_cannot_be_submitted_again(self):
        with patch.object(
            scanner.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("synthetic", 300),
        ) as create:
            with self.assertRaisesRegex(r.Refused, "INTERRUPTED_INSPECT_ONLY"):
                scanner.deploy(self.binding, self.plan, self.context, self.root)
            intent = json.loads(
                (
                    scanner.deployment_folder(self.context["operation_id"])
                    / "request.json"
                ).read_bytes()
            )
            self.assertEqual(intent["binding"], self.binding)
            self.assertEqual(intent["request_budget"], 1)
            self.assertFalse(intent["automatic_retry"])
            with self.assertRaises(FileExistsError):
                scanner.deploy(self.binding, self.plan, self.context, self.root)
            self.assertEqual(create.call_count, 1)
            self.assertEqual(create.call_args.args[0][-1], "scanner")
            for flag in ["--no-deps", "--no-build", "--wait"]:
                self.assertIn(flag, create.call_args.args[0])

    def test_simultaneous_attempts_allow_only_one_actual_request(self):
        barrier = threading.Barrier(2)

        def attempt():
            barrier.wait(timeout=5)
            try:
                return scanner.deploy(self.binding, self.plan, self.context, self.root)
            except (FileExistsError, BlockingIOError):
                return {"state": "INSPECT_ONLY"}

        result = SimpleNamespace(returncode=0, stdout=b"created", stderr=b"")
        with (
            patch.object(scanner.subprocess, "run", return_value=result) as create,
            patch.object(
                scanner,
                "production",
                return_value={"deployment_id": "synthetic-existing"},
            ),
            ThreadPoolExecutor(max_workers=2) as threads,
        ):
            values = list(threads.map(lambda _v: attempt(), range(2)))
        self.assertEqual(create.call_count, 1)
        self.assertEqual(
            sum(value.get("state") == "INSPECT_ONLY" for value in values), 1
        )

    def test_new_installation_cannot_hide_an_older_uncertain_request(self):
        old = str(uuid4())
        path = scanner.deployment_folder(old)
        path.parent.mkdir(mode=0o700)
        path.mkdir(mode=0o700)
        r.write(
            path / "request.json",
            {
                "binding": self.binding,
                "context": {"operation_id": old},
                "verifier_store": "/synthetic/previous-store",
            },
        )
        with (
            patch.object(
                r, "verify_invocation", side_effect=r.Refused("PREVIOUS_NOT_ACCEPTED")
            ) as verify,
            patch.object(scanner.subprocess, "run") as create,
            self.assertRaisesRegex(r.Refused, "PREVIOUS_NOT_ACCEPTED"),
        ):
            scanner.deploy(self.binding, self.plan, self.context, self.root)
        create.assert_not_called()
        self.assertTrue(verify.call_args.kwargs["dependency"])
        self.assertFalse(
            scanner.deployment_folder(self.context["operation_id"]).exists()
        )

    def test_failed_command_preserves_actual_result_and_never_claims_receipt(self):
        result = SimpleNamespace(
            returncode=1, stdout=b"synthetic output", stderr=b"synthetic failure"
        )
        with (
            patch.object(scanner.subprocess, "run", return_value=result) as create,
            self.assertRaises(r.Refused),
        ):
            scanner.deploy(self.binding, self.plan, self.context, self.root)
        target = scanner.deployment_folder(self.context["operation_id"])
        self.assertEqual(
            json.loads((target / "provider-command-result.json").read_bytes())[
                "returncode"
            ],
            1,
        )
        self.assertFalse((target / "provider-receipt.json").exists())
        self.assertEqual(create.call_count, 1)

    def test_successful_request_still_requires_running_verification(self):
        result = SimpleNamespace(returncode=0, stdout=b"created", stderr=b"")
        with (
            patch.object(scanner.subprocess, "run", return_value=result),
            patch.object(
                scanner, "production", side_effect=r.Refused("WRONG_RUNNING_SOURCE")
            ),
            self.assertRaises(r.Refused),
        ):
            scanner.deploy(self.binding, self.plan, self.context, self.root)
        self.assertFalse(
            (
                scanner.deployment_folder(self.context["operation_id"])
                / "provider-receipt.json"
            ).exists()
        )

    def test_production_observation_cannot_submit_or_restart_anything(self):
        row = {
            "Id": "1" * 64,
            "Image": self.binding["artifact_digest"],
            "Config": {
                "Labels": {
                    "org.onesa.release-operation": self.context["operation_id"],
                    "org.onesa.source-commit": self.binding["candidate_commit"],
                }
            },
        }
        target = scanner.deployment_folder(self.context["operation_id"])
        target.parent.mkdir(mode=0o700)
        target.mkdir(mode=0o700)
        override = target / "scanner-override.json"
        r.write(
            override,
            {"services": {"scanner": {"image": self.binding["artifact_digest"]}}},
        )
        request = {
            "binding": self.binding,
            "context": self.context,
            "request_budget": 1,
            "automatic_retry": False,
            "override_sha256": r.sha(override),
        }
        r.write(target / "request.json", request)
        with (
            patch.object(scanner, "retained", return_value={scanner.TARGET: row}),
            patch.object(scanner, "socket_directory", return_value=self.root),
            patch.object(scanner, "protocol", return_value={"eicar": "PASS"}),
            patch.object(scanner, "access_probe", return_value={}),
            patch.object(scanner.subprocess, "run") as create,
        ):
            result = scanner.production(self.binding, self.plan, self.context)
            self.assertEqual(result["deployment_id"], row["Id"])
            create.assert_not_called()
            for wrong in ["0" * 64, self.binding["candidate_commit"]]:
                row["Config"]["Labels"]["org.onesa.release-operation"] = wrong
                with self.assertRaises(r.Refused):
                    scanner.production(self.binding, self.plan, self.context)


class ImageSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.binding, _plan = inputs()
        (self.folder / "source.tar").write_bytes(b"synthetic source parser input")
        self.binding["source_sha256"] = r.sha(self.folder / "source.tar")
        self.files = {
            scanner.PREFIX + "Dockerfile": "0" * 64,
            **{scanner.PREFIX + name: "1" * 64 for name in scanner.SHIPPED},
        }
        self.build = {
            key: self.binding[key]
            for key in [
                "repository",
                "component",
                "candidate_commit",
                "source_tree",
                "source_sha256",
                "artifact_digest",
            ]
        }
        self.build.update(architecture="arm64", dockerfile_sha256="0" * 64)
        self.scan = {
            "Metadata": {"ImageID": self.binding["artifact_digest"]},
            "Results": [{"Vulnerabilities": []}],
            "ArtifactName": "synthetic-image",
            "CreatedAt": r.now().isoformat(),
        }
        self.row = {
            "Id": self.binding["artifact_digest"],
            "Os": "linux",
            "Architecture": "arm64",
            "Config": {
                "User": "clamav",
                "Env": [
                    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                ],
                "Entrypoint": ["/usr/local/bin/onesa-clamav"],
                "Cmd": None,
                "Labels": {
                    "org.opencontainers.image.revision": self.binding[
                        "candidate_commit"
                    ],
                    "org.onesa.source-sha256": self.binding["source_sha256"],
                },
            },
        }
        self.actual_files = {path: "1" * 64 for path in scanner.SHIPPED.values()}
        (self.folder / "compose.oracle-staging.yaml").write_bytes(
            b"# synthetic source recipe\n"
        )
        self.files["compose.oracle-staging.yaml"] = r.sha(
            self.folder / "compose.oracle-staging.yaml"
        )
        self.enterContext(
            patch.object(r, "private", side_effect=lambda path, **_kw: Path(path))
        )
        self.enterContext(
            patch.object(r, "source_inventory", return_value=({}, self.files))
        )
        self.enterContext(patch.object(r, "docker", side_effect=self.docker))
        self.seal()

    def docker(self, *args):
        if args[:2] == ("image", "inspect"):
            return r.canonical([self.row])
        self.assertEqual(args[0], "run")
        self.assertIn("none", args)
        return "".join(
            checksum + "  " + path + "\n"
            for path, checksum in self.actual_files.items()
        ).encode()

    def seal(self):
        (self.folder / "build.json").write_bytes(r.canonical(self.build))
        self.binding["build_sha256"] = r.sha(self.folder / "build.json")
        (self.folder / "scan.json").write_bytes(r.canonical(self.scan))

    def test_exact_source_build_running_image_files_and_current_scan_are_all_required(
        self,
    ):
        result = scanner.image(self.binding, self.folder)
        self.assertEqual(result["image"], self.row["Id"])
        self.assertEqual(result["files"], self.actual_files)
        self.actual_files["/etc/clamav/clamd.conf"] = "2" * 64
        with self.assertRaisesRegex(r.Refused, "FILES_DIFFER_FROM_SOURCE"):
            scanner.image(self.binding, self.folder)

    def test_rehashed_wrong_build_or_relabeled_actual_image_cannot_inherit_qualification(
        self,
    ):
        for key, value in [
            ("candidate_commit", "f" * 40),
            ("component", "worker"),
            ("architecture", "amd64"),
            ("dockerfile_sha256", "f" * 64),
        ]:
            previous = self.build[key]
            self.build[key] = value
            self.seal()
            with self.subTest(key=key), self.assertRaises(r.Refused):
                scanner.image(self.binding, self.folder)
            self.build[key] = previous
        self.seal()
        self.row["Config"]["Labels"]["org.opencontainers.image.revision"] = "f" * 40
        with self.assertRaises(r.Refused):
            scanner.image(self.binding, self.folder)

    def test_failed_missing_or_stale_security_evidence_remains_unqualified(self):
        for change in [
            lambda v: v.update(Results=[]),
            lambda v: v.update(CreatedAt=(r.now() - timedelta(days=2)).isoformat()),
            lambda v: v.update(Results=[{"Vulnerabilities": [{"Severity": "HIGH"}]}]),
            lambda v: v.update(Results=[{"Secrets": [{"RuleID": "synthetic"}]}]),
        ]:
            before = copy.deepcopy(self.scan)
            change(self.scan)
            self.seal()
            with self.assertRaises(r.Refused):
                scanner.image(self.binding, self.folder)
            self.scan = before
        self.seal()
        (self.folder / "source.tar").write_bytes(b"changed after qualification")
        with self.assertRaisesRegex(r.Refused, "SOURCE_ARCHIVE_CHANGED"):
            scanner.image(self.binding, self.folder)


class StagingResourceTests(unittest.TestCase):
    def sample(self):
        return {
            "HostConfig": {
                "Memory": 2560 * 1024**2,
                "NanoCpus": 250000000,
                "PidsLimit": 64,
                "ReadonlyRootfs": True,
                "Privileged": False,
                "PortBindings": {},
                "CapAdd": None,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "DeviceRequests": None,
                "Devices": [],
            },
            "Mounts": [
                {"Destination": "/var/lib/clamav"},
                {"Destination": "/run/onesa-scanner"},
            ],
        }

    def test_actual_staging_limits_are_recorded_without_exporting_configuration(self):
        sample = self.sample()
        sample["Config"] = {"Env": ["SYNTHETIC_PRIVATE_CONFIGURATION=not-exported"]}
        result = scanner.staging_resources(sample)
        self.assertEqual(
            result,
            {"memory_bytes": 2684354560, "nano_cpus": 250000000, "pids_limit": 64},
        )
        self.assertNotIn("not-exported", json.dumps(result))

    def test_old_undersized_or_unbounded_and_mismatched_limits_fail(self):
        for key, value in [
            ("Memory", 1024**3),
            ("Memory", 0),
            ("Memory", 4 * 1024**3),
            ("Memory", str(2684354560)),
            ("NanoCpus", 0),
            ("NanoCpus", 1000000000),
            ("PidsLimit", -1),
            ("PidsLimit", True),
        ]:
            with self.subTest(key=key, value=value):
                sample = self.sample()
                sample["HostConfig"][key] = value
                with self.assertRaisesRegex(
                    r.Refused, "SCANNER_STAGING_RESOURCE_LIMITS_DIFFER"
                ):
                    scanner.staging_resources(sample)

    def test_resource_match_cannot_hide_weakened_isolation(self):
        for key, value in [
            ("ReadonlyRootfs", False),
            ("Privileged", True),
            ("PortBindings", {"3310/tcp": [{"HostPort": "3310"}]}),
            ("CapAdd", ["SYS_ADMIN"]),
            ("CapDrop", []),
            ("SecurityOpt", []),
            ("DeviceRequests", [{"Count": -1}]),
            ("Devices", [{"PathOnHost": "/dev/synthetic"}]),
        ]:
            with self.subTest(key=key):
                sample = self.sample()
                sample["HostConfig"][key] = value
                with self.assertRaisesRegex(r.Refused, "SCANNER_STAGING_ISOLATION"):
                    scanner.staging_resources(sample)


class CapacityTests(unittest.TestCase):
    def test_failed_stale_simulated_or_insufficient_samples_never_qualify(self):
        valid = {
            "simulation": False,
            "alerts": [],
            "checked_at": r.now().isoformat(),
            "metrics": {
                "database_available": True,
                "database_backup_failed": False,
                "memory_available_bytes": 4 * 1024**3,
                "disk_used_percent": 70,
            },
        }
        with patch.object(r, "read", return_value=valid):
            scanner.capacity(staging=True)
        for change in [
            lambda v: v.update(simulation=True),
            lambda v: v.update(alerts=["failure"]),
            lambda v: v.update(checked_at=(r.now() - timedelta(minutes=6)).isoformat()),
            lambda v: v["metrics"].update(memory_available_bytes=3 * 1024**3),
            lambda v: v["metrics"].update(database_backup_failed=True),
            lambda v: v["metrics"].update(disk_used_percent=80),
        ]:
            value = copy.deepcopy(valid)
            change(value)
            with (
                patch.object(r, "read", return_value=value),
                self.assertRaises(r.Refused),
            ):
                scanner.capacity(staging=True)


class CliTests(unittest.TestCase):
    def test_private_caller_values_are_never_emitted(self):
        result = subprocess.run(
            [sys.executable, "-I", str(Path(scanner.__file__)), "production"],
            input=b'{"password":"synthetic-private-sentinel","owner_approved":true}',
            env={"PATH": "/usr/bin:/bin"},
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            json.loads(result.stdout),
            {"state": "SCANNER_OBSERVATION_FAILED_INSPECT_WITHOUT_RETRY"},
        )
