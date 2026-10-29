"""Synthetic observation scope tests; no issuer, database or provider access."""

import copy
import unittest

import oracle_portal as r
import oracle_portal_scanner_workflow as workflow
from test_oracle_portal_scanner import inputs


def worker_inputs():
    binding, plan = inputs()
    application = plan["workflow"]["application_binding"]
    binding.update(
        component="worker",
        artifact_digest=application["artifact_digest"],
        build_sha256=application["build_sha256"],
    )
    return binding, plan


def api_inputs():
    binding, plan = worker_inputs()
    binding["component"] = "api"
    plan["workflow"]["application_binding"]["component"] = "api"
    return binding, plan


class ComponentScopeTests(unittest.TestCase):
    def test_scanner_and_worker_observe_their_actual_component_artifacts(self):
        for factory, component in [
            (inputs, "scanner"),
            (worker_inputs, "worker"),
            (api_inputs, "api"),
        ]:
            binding, plan = factory()
            with self.subTest(component=component):
                self.assertIs(workflow.validate_plan(binding, plan), plan["workflow"])
                application = plan["workflow"]["application_binding"]
                self.assertEqual(
                    application["component"], "api" if component == "api" else "worker"
                )
                self.assertEqual(
                    application["artifact_digest"] == binding["artifact_digest"],
                    component in {"worker", "api"},
                )

    def test_worker_cannot_inherit_another_source_or_artifact(self):
        for key, value in [
            ("component", "frontend"),
            ("repository", "foreign/repository"),
            ("candidate_commit", "f" * 40),
            ("source_tree", "f" * 40),
            ("source_sha256", "f" * 64),
            ("artifact_digest", "sha256:" + "f" * 64),
            ("build_sha256", "f" * 64),
            ("target_environment", "staging"),
        ]:
            binding, plan = worker_inputs()
            binding[key] = value
            with self.subTest(key=key), self.assertRaises(r.Refused):
                workflow.validate_plan(binding, plan)

    def test_scanner_cannot_borrow_worker_image_or_build_identity(self):
        for key in ["artifact_digest", "build_sha256"]:
            binding, plan = inputs()
            binding[key] = plan["workflow"]["application_binding"][key]
            with self.subTest(key=key), self.assertRaises(r.Refused):
                workflow.validate_plan(binding, plan)

    def test_both_paths_refuse_missing_pins_or_runtime_binding_changes(self):
        for factory in [inputs, worker_inputs, api_inputs]:
            for change in [
                lambda p: p["workflow"].update(runtime_sha256="f" * 64),
                lambda p: p["workflow"].update(application_scan_sha256=""),
                lambda p: p["workflow"].update(owner_custody_sha256=""),
                lambda p: p["workflow"].update(owner_approved=True),
                lambda p: p["workflow"]["application_binding"].update(
                    configuration_sha256={"staging": "3" * 64}
                ),
            ]:
                binding, plan = factory()
                changed = copy.deepcopy(plan)
                change(changed)
                with self.subTest(factory=factory), self.assertRaises(r.Refused):
                    workflow.validate_plan(binding, changed)

    def test_api_cannot_inherit_worker_component_or_another_artifact(self):
        for key, value in [
            ("component", "worker"),
            ("candidate_commit", "f" * 40),
            ("artifact_digest", "sha256:" + "f" * 64),
            ("build_sha256", "f" * 64),
        ]:
            binding, plan = api_inputs()
            plan["workflow"]["application_binding"][key] = value
            with self.subTest(key=key), self.assertRaises(r.Refused):
                workflow.validate_plan(binding, plan)


if __name__ == "__main__":
    unittest.main()
