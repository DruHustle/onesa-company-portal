"""Synthetic worker contract and interruption tests; never hosted authority."""

import copy
import hashlib
import json
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_worker as worker
import test_oracle_portal_scanner as scanner_fixtures
from test_oracle_portal_scanner import inputs as scanner_inputs


def inputs():
    binding, plan = scanner_inputs()
    application = plan["workflow"]["application_binding"]
    binding.update(
        component="worker",
        build_sha256=application["build_sha256"],
        artifact_digest=application["artifact_digest"],
    )
    baseline = plan["baseline"]
    baseline[worker.TARGET] = {**baseline.pop("synthetic-0"), "source": "f" * 40}
    baseline[worker.workflows.STAGE] = baseline.pop("synthetic-1")
    plan["runtime"] = {
        "user": "node",
        "entrypoint": ["docker-entrypoint.sh"],
        "command": ["node", "dist/src/jobs/worker.js"],
        "read_only": True,
        "privileged": False,
        "cap_add": None,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "group_add": ["3000"],
        "port_bindings": {},
        "memory": 512 * 1024**2,
        "nano_cpus": 100000000,
        "pids_limit": 128,
        "mounts": [
            {
                "Type": "volume",
                "Name": worker.SOCKET,
                "Destination": "/run/onesa-scanner",
                "RW": False,
            }
        ],
        "networks": ["synthetic-private-network"],
    }
    directory = "/opt/onesa/portal-production/releases/" + "f" * 40
    plan["runtime"].update(
        compose_project="onesa-portal-oracle-production", compose_directory=directory
    )
    plan["recipe"] = {
        "project": "onesa-portal-oracle-production",
        "directory": directory,
        "files": [{"path": directory + "/compose.yaml", "sha256": "0" * 64}],
        "environment_file": {"path": directory + "/release.env", "sha256": "6" * 64},
    }
    plan["production_probe"] = {
        "runtime_path": str(worker.RUNTIME),
        "runtime_sha256": "4" * 64,
        "effective_runtime_sha256": "5" * 64,
        "fixture_id": str(uuid4()),
    }
    seal(binding, plan)
    return binding, plan


def seal(binding, plan):
    binding["configuration_sha256"] = {
        env: hashlib.sha256(r.canonical(worker.configuration(plan, env))).hexdigest()
        for env in ["staging", "production"]
    }


class ContractTests(unittest.TestCase):
    def test_independent_image_source_retains_its_actual_pinned_compose_directory(self):
        binding, plan = inputs()
        plan["baseline"][worker.TARGET]["source"] = "9" * 40
        seal(binding, plan)
        self.assertEqual(
            worker.validate_plan(binding, plan),
            worker.ROOT / "artifacts" / binding["source_tree"],
        )

    def test_recipe_must_match_captured_project_directory_and_canonical_paths(self):
        for change in [
            lambda p: p["runtime"].pop("compose_directory"),
            lambda p: p["runtime"].update(compose_project="unrelated-project"),
            lambda p: p["runtime"].update(compose_directory="/tmp/untrusted"),
            lambda p: p["recipe"].update(directory="/tmp/untrusted"),
            lambda p: p["recipe"].update(
                directory=p["recipe"]["directory"] + "/../other"
            ),
        ]:
            binding, plan = inputs()
            change(plan)
            seal(binding, plan)
            with self.subTest(change=change), self.assertRaises(r.Refused):
                worker.validate_plan(binding, plan)

    def test_actual_compose_metadata_is_part_of_preserved_runtime_profile(self):
        _binding, plan = inputs()
        row = {
            "Config": {
                "Labels": {
                    "com.docker.compose.project": plan["recipe"]["project"],
                    "com.docker.compose.project.working_dir": plan["recipe"][
                        "directory"
                    ],
                }
            }
        }
        base = {**plan["runtime"], "environment_sha256": "0" * 64}
        with patch.object(
            worker.common, "profile", side_effect=lambda row: copy.deepcopy(base)
        ):
            original = worker.profile(row)
            self.assertEqual(original["compose_directory"], plan["recipe"]["directory"])
            for key, value in [
                ("com.docker.compose.project", "unrelated-project"),
                ("com.docker.compose.project.working_dir", "/tmp/other"),
            ]:
                changed = copy.deepcopy(row)
                changed["Config"]["Labels"][key] = value
                with self.subTest(key=key):
                    self.assertNotEqual(worker.profile(changed), original)

    def test_only_exact_worker_source_and_existing_production_recipe_are_eligible(self):
        binding, plan = inputs()
        self.assertEqual(
            worker.validate_plan(binding, plan),
            worker.ROOT / "artifacts" / binding["source_tree"],
        )
        self.assertEqual(worker.CHECKS, __import__("oracle_owner").REQUIRED_CHECKS)
        for key, value in [
            ("repository", "foreign/repository"),
            ("component", "scanner"),
            ("target_environment", "staging"),
            ("candidate_commit", "f" * 40),
            ("artifact_digest", "sha256:" + "f" * 64),
        ]:
            changed = {**binding, key: value}
            with self.subTest(key=key), self.assertRaises(r.Refused):
                worker.validate_plan(changed, plan)

    def test_new_configuration_binding_cannot_authorize_unsafe_profile(self):
        for change in [
            lambda p: p["runtime"].update(privileged=True),
            lambda p: p["runtime"].update(read_only=False),
            lambda p: p["runtime"].update(memory=768 * 1024**2),
            lambda p: p["runtime"].update(nano_cpus=200000000),
            lambda p: p["runtime"].update(command=["node", "dist/src/server.js"]),
            lambda p: p["runtime"].update(port_bindings={"8300/tcp": [{}]}),
            lambda p: p["runtime"]["mounts"][0].update(RW=True),
            lambda p: p["runtime"]["mounts"][0].update(Name="different-volume"),
            lambda p: p["recipe"].update(project="onesa-portal-oracle-staging"),
            lambda p: p["recipe"]["files"][0].update(path="/unbound/compose.yaml"),
            lambda p: p["rollback"].update(automatic=True),
            lambda p: p["production_probe"].update(runtime_path="/unbound/runtime.env"),
        ]:
            binding, plan = inputs()
            change(plan)
            seal(binding, plan)
            with self.subTest(change=change), self.assertRaises(r.Refused):
                worker.validate_plan(binding, plan)

    def test_changed_recipe_or_production_fixture_cannot_reuse_configuration(self):
        for change in [
            lambda p: p["recipe"]["files"][0].update(sha256="1" * 64),
            lambda p: p["production_probe"].update(fixture_id=str(uuid4())),
        ]:
            binding, plan = inputs()
            change(plan)
            with self.assertRaisesRegex(r.Refused, "CONFIGURATION_CHANGED"):
                worker.validate_plan(binding, plan)

    def test_unsigned_actions_or_run_zero_caller_cannot_reach_operations(self):
        binding, plan = inputs()
        for phase in worker.CHECKS:
            with (
                patch.object(r, "read", return_value=plan),
                patch.object(
                    r, "verify_invocation", side_effect=r.Refused("FORGED_OWNER")
                ),
                patch.object(r, "docker") as docker,
                patch.object(r, "command") as command,
            ):
                with self.subTest(phase=phase), self.assertRaises(r.Refused):
                    worker.runner(
                        phase, binding, {"workflow_run_id": 0, "owner_approved": True}
                    )
                docker.assert_not_called()
                command.assert_not_called()


class EffectiveEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.binding, self.plan = inputs()
        self.defaults = {"NODE_ENV": "production", "NODE_VERSION": "24.22.1"}
        self.previous = {**self.defaults, "NODE_VERSION": "24.21.0"}
        self.explicit = {"SYNTHETIC_PRIVATE": "retained-test-value"}
        self.actual = {**self.previous, **self.explicit}
        self.row = {
            "Id": self.plan["baseline"][worker.TARGET]["container_id"],
            "Config": {"Env": self.lines(self.actual)},
        }
        self.enterContext(
            patch.object(r, "inventory", return_value={worker.TARGET: self.row})
        )
        self.enterContext(
            patch.object(
                worker,
                "rendered",
                side_effect=lambda plan: {
                    "services": {"worker": {"environment": self.explicit}}
                },
            )
        )

        def inspect(*arguments):
            self.assertEqual(arguments[:2], ("image", "inspect"))
            values = (
                self.defaults
                if arguments[2] == self.binding["artifact_digest"]
                else self.previous
            )
            return r.canonical([{"Config": {"Env": self.lines(values)}}])

        self.enterContext(patch.object(r, "docker", side_effect=inspect))
        self.bind_effective()

    @staticmethod
    def lines(values):
        return [key + "=" + value for key, value in values.items()]

    def bind_effective(self):
        expected = {**self.defaults, **self.explicit}
        raw = "".join(key + "=" + expected[key] + "\n" for key in sorted(expected))
        self.plan["production_probe"]["effective_runtime_sha256"] = hashlib.sha256(
            raw.encode()
        ).hexdigest()
        return raw

    def test_image_default_patch_and_retained_compose_values_are_bound_together(self):
        raw, effective = worker.effective_environment(self.binding, self.plan)
        self.assertEqual(raw, self.bind_effective())
        self.assertEqual(effective["NODE_VERSION"], "24.22.1")
        self.assertEqual(effective["SYNTHETIC_PRIVATE"], "retained-test-value")

    def test_even_new_binding_cannot_change_retained_private_configuration(self):
        self.explicit["SYNTHETIC_PRIVATE"] = "changed-test-value"
        self.bind_effective()
        with self.assertRaisesRegex(r.Refused, "RETAINED_EFFECTIVE_CONFIGURATION"):
            worker.effective_environment(self.binding, self.plan)

    def test_changed_defaults_or_running_values_cannot_inherit_effective_hash(self):
        self.defaults["NODE_VERSION"] = "24.23.0"
        with self.assertRaisesRegex(r.Refused, "EFFECTIVE_ENVIRONMENT_CHANGED"):
            worker.effective_environment(self.binding, self.plan)
        self.defaults["NODE_VERSION"] = "24.22.1"
        self.row["Id"] = "0" * 64
        with self.assertRaisesRegex(r.Refused, "RUNNING_ENVIRONMENT_CHANGED"):
            worker.effective_environment(self.binding, self.plan)


class SignedWorkerContextTests(scanner_fixtures.SignedScannerContextTests):
    component = "worker"


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binding, self.plan = inputs()
        self.context = {"operation_id": str(uuid4()), "authorization_id": str(uuid4())}
        self.enterContext(patch.object(worker, "ROOT", self.root))
        self.enterContext(
            patch.object(r, "private", side_effect=lambda p, **kw: Path(p))
        )
        self.enterContext(patch.object(worker, "retained", return_value={}))
        self.enterContext(
            patch.object(worker.workflows, "verify_application", return_value={})
        )
        self.enterContext(
            patch.object(worker, "effective_environment", return_value=("", {}))
        )
        self.enterContext(
            patch.object(worker, "recipe_command", return_value=["synthetic-compose"])
        )
        original = {
            "services": {"worker": {"image": self.plan["rollback"]["artifact_digest"]}},
            "networks": {"existing": {}},
            "volumes": {"existing": {}},
        }

        def render(plan, override=None):
            value = copy.deepcopy(original)
            if override:
                value["services"]["worker"].update(
                    json.loads(override.read_bytes())["services"]["worker"]
                )
            return value

        self.enterContext(patch.object(worker, "rendered", side_effect=render))

    def test_interrupted_deployment_is_durable_and_cannot_submit_again(self):
        with patch.object(
            worker.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("synthetic", 300),
        ) as create:
            with self.assertRaisesRegex(r.Refused, "INTERRUPTED_INSPECT_ONLY"):
                worker.deploy(self.binding, self.plan, self.context, self.root, [])
            folder = worker.deployment_folder(self.context["operation_id"])
            request = json.loads((folder / "request.json").read_bytes())
            self.assertEqual(request["binding"], self.binding)
            self.assertEqual(request["request_budget"], 1)
            self.assertFalse(request["automatic_retry"])
            self.assertEqual(
                json.loads((folder / "provider-command-result.json").read_bytes())[
                    "state"
                ],
                "TIMED_OUT_OUTCOME_UNCERTAIN",
            )
            with self.assertRaisesRegex(r.Refused, "EXISTS_INSPECT_ONLY"):
                worker.deploy(self.binding, self.plan, self.context, self.root, [])
            self.assertEqual(create.call_count, 1)

    def test_concurrent_attempt_cannot_acquire_component_lock(self):
        entered = threading.Event()
        release = threading.Event()

        def hold():
            with worker.component_lock():
                entered.set()
                self.assertTrue(release.wait(5))

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(hold)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaises(BlockingIOError), worker.component_lock():
                    self.fail("concurrent lock acquired")
            finally:
                release.set()
            future.result()

    def test_unaccepted_previous_operation_cannot_be_hidden_by_new_source(self):
        path = worker.deployment_folder(str(uuid4()))
        path.mkdir(parents=True)
        (path / "request.json").write_text(
            json.dumps(
                {
                    "binding": self.binding,
                    "context": {"operation_id": path.name},
                    "verifier_store": "/synthetic/store",
                }
            )
        )
        with patch.object(
            r, "verify_invocation", side_effect=r.Refused("PREVIOUS_NOT_ACCEPTED")
        ) as verify:
            with self.assertRaisesRegex(r.Refused, "PREVIOUS_NOT_ACCEPTED"):
                worker.previous_operations()
            self.assertTrue(verify.call_args.kwargs["dependency"])


if __name__ == "__main__":
    unittest.main()
