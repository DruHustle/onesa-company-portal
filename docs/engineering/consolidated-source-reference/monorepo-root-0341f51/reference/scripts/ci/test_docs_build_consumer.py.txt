"""Public build data only: real canonical source checks plus disposable Docs ZIPs."""

import base64
import copy
import importlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

from test_source_consumer import SourceFixture

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "onesa-ai-platform/scripts/release"
# Product test modules use historical unqualified import names. Load this fixture
# without replacing the Portal modules used by the other root regression tests.
with patch.dict(sys.modules):
    for name in (
        "oracle_owner",
        "oracle_docs_build",
        "oracle_docs_checks",
        "evidence",
        "free_gate",
        "test_evidence",
        "test_free_gate",
        "test_docs_scope",
        "test_oracle_docs_build",
    ):
        sys.modules.pop(name, None)
    with patch.object(sys, "path", [str(RELEASE), *sys.path]):
        owner = importlib.import_module("oracle_owner")
        docs = importlib.import_module("oracle_docs_build")
        legacy = importlib.import_module("test_oracle_docs_build")


class CanonicalDocsFixture:
    def __init__(self):
        self.source = SourceFixture(owner, "platform", "main")
        self.legacy = legacy.GitHub()
        tests = legacy.DocsBuildTests()
        tests.github = self.legacy
        tests.add_checks()
        self.legacy.run.update(
            repository={
                "full_name": self.source.source["repository"],
                "id": self.source.source["repository_id"],
            },
            head_repository={
                "full_name": self.source.source["repository"],
                "id": self.source.source["repository_id"],
            },
            path=docs.CANONICAL_WORKFLOW,
            updated_at=self.source.now.isoformat(),
        )
        self.legacy.job["steps"] = [
            step
            for step in self.legacy.job["steps"]
            if step["name"] not in docs.PROVIDER_STEPS
        ]
        self.repack_checks(
            lambda value: value.update(
                schema_version=2,
                repository=self.source.source["repository"],
                source=copy.deepcopy(self.source.source),
                verification_only=True,
                release_authorized=False,
            )
        )
        self.qualifications = 0
        self.changed_main = False

    def repack_checks(self, mutate):
        with zipfile.ZipFile(io.BytesIO(self.legacy.archives[302])) as archive:
            value = json.loads(archive.read("docs-local-build-checks.json"))
        mutate(value)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("docs-local-build-checks.json", json.dumps(value))
        self.legacy.set_archive(302, output.getvalue())

    def owner(self):
        return self.source.github.owner()

    def qualify(self, source, archives):
        self.qualifications += 1
        if self.changed_main and self.qualifications > 1:
            self.source.api_values[self.source.prefix + "branches/main"] = {
                "commit": {"sha": "f" * 40}
            }
        return self.source.github.qualify(source, archives)

    def api(self, path):
        prefix = self.source.prefix
        if path.startswith(prefix + "actions/runs/100"):
            return self.legacy.api(
                path.replace(prefix, "repos/" + docs.REPOSITORY + "/", 1)
            )
        contents = prefix + "contents/onesa-ai-platform/"
        if path.startswith(contents):
            relative = path.removeprefix(contents)
            value = self.legacy.api(
                "repos/" + docs.REPOSITORY + "/contents/" + relative
            )
            value["path"] = "onesa-ai-platform/" + value["path"]
            return value
        raise AssertionError("Unexpected Docs fixture API path: " + path)

    def read(self, **overrides):
        args = {
            "source": self.source.source,
            "run_id": 100,
            "archives": self.legacy.archives,
            "now": self.source.now,
            "require_local_checks": True,
            "source_archives": self.source.archives,
        }
        args.update(overrides)
        return docs.read_build(self, **args)


class CanonicalDocsBuildTests(unittest.TestCase):
    def setUp(self):
        # These are synthetic external-reader inputs, not an owner execution in CI.
        self.enterContext(patch.dict(os.environ, {"GITHUB_ACTIONS": ""}))
        self.fixture = CanonicalDocsFixture()

    def test_canonical_public_build_uses_real_source_verifier_twice_without_authority(
        self,
    ):
        result = self.fixture.read()
        self.assertEqual(self.fixture.qualifications, 2)
        self.assertEqual(result["source"], self.fixture.source.source)
        self.assertEqual(len(result["artifacts"]), 2)
        self.assertEqual(result["local_acceptance"]["artifact_id"], 302)
        self.assertEqual(result["STAGING_VERIFIED"], "BLOCKED")
        self.assertTrue(result["verification_only"])
        for flag in (
            "release_authorized",
            "production_deployment_authorized",
            "application_deployment_authorized",
            "backend_deployment_authorized",
        ):
            self.assertIs(result[flag], False)
        self.assertNotIn("signature", result)
        self.assertNotIn("record", result)
        self.assertTrue(result["native_ci"][0]["verification_only"])
        self.assertFalse(result["native_ci"][0]["release_authorized"])

    def test_exact_repository_root_product_path_and_promoted_main_are_required(self):
        for field, value in (
            ("repository_id", 1),
            ("repository_id", True),
            ("product", "portal"),
            ("source_path", "onesa-robot"),
            ("branch", "dev"),
            ("candidate_commit", "f" * 40),
            ("source_tree", "f" * 40),
            ("product_source_tree", "f" * 40),
            ("release_authorized", True),
        ):
            self.fixture = CanonicalDocsFixture()
            source = {**self.fixture.source.source, field: value}
            with (
                self.subTest(field=field, value=value),
                self.assertRaises(owner.Rejected),
            ):
                self.fixture.read(source=source)

    def test_missing_corrupt_or_authorizing_platform_archive_refuses(self):
        for failure in ("missing", "corrupt", "authority", "latest-ci"):
            self.fixture = CanonicalDocsFixture()
            source = self.fixture.source
            name = next(iter(source.archives))
            if failure == "missing":
                source.archives.pop(name)
            elif failure == "corrupt":
                source.archives[name] = base64.b64encode(
                    b"not the declared ZIP"
                ).decode()
            elif failure == "authority":
                source.manifests[name]["release_authorized"] = True
                source.repack(name)
            else:
                source.runs["workflow_runs"][0]["conclusion"] = "failure"
            with self.subTest(failure=failure), self.assertRaises(owner.Rejected):
                self.fixture.read()

    def test_only_the_complete_public_artifact_trio_is_accepted(self):
        for failure in (
            "two-artifact-mode",
            "missing-checks",
            "internal",
            "relabel",
            "private-path",
            "modified-zip",
        ):
            self.fixture = CanonicalDocsFixture()
            if failure == "two-artifact-mode":
                args = {"require_local_checks": False}
            else:
                args = {}
                if failure == "missing-checks":
                    self.fixture.legacy.items.pop()
                elif failure == "modified-zip":
                    self.fixture.legacy.archives[300] += b"changed"
                else:
                    change = (
                        {"private": True}
                        if failure == "internal"
                        else {"label": "DEVELOPMENT · Public developer documentation"}
                        if failure == "relabel"
                        else {
                            "extra": (
                                "generated/engineering-navigation.json",
                                "private",
                            )
                        }
                    )
                    self.fixture.legacy.set_archive(
                        300, legacy.archive("onesa-public-docs-staging", **change)
                    )
            with self.subTest(failure=failure), self.assertRaises(owner.Rejected):
                self.fixture.read(**args)

    def test_canonical_check_identity_and_authority_cannot_be_relabelled(self):
        for mutate in (
            lambda v: v.update(schema_version=1),
            lambda v: v["source"].update(product_source_tree="f" * 40),
            lambda v: v.update(repository=docs.REPOSITORY),
            lambda v: v.update(release_authorized=True),
            lambda v: v.update(hosted_qualification=True),
        ):
            self.fixture = CanonicalDocsFixture()
            self.fixture.repack_checks(mutate)
            with self.subTest(mutate=mutate), self.assertRaises(owner.Rejected):
                self.fixture.read()

    def test_build_run_identity_provider_steps_and_missing_checks_refuse(self):
        for failure in (
            "numeric-id",
            "fork",
            "workflow",
            "retry",
            "provider-step",
            "skipped-check",
        ):
            self.fixture = CanonicalDocsFixture()
            run = self.fixture.legacy.run
            if failure == "numeric-id":
                run["repository"]["id"] = True
            elif failure == "fork":
                run["head_repository"]["id"] = 1
            elif failure == "workflow":
                run["path"] = ".github/workflows/docs-hosting.yml"
            elif failure == "retry":
                run["run_attempt"] = 2
            elif failure == "provider-step":
                self.fixture.legacy.job["steps"].append(
                    {
                        "name": next(iter(docs.PROVIDER_STEPS)),
                        "status": "completed",
                        "conclusion": "skipped",
                    }
                )
            else:
                self.fixture.legacy.job["steps"][0]["conclusion"] = "skipped"
            with self.subTest(failure=failure), self.assertRaises(owner.Rejected):
                self.fixture.read()

    def test_current_main_and_artifact_custody_are_rechecked(self):
        for failure in ("main", "artifact"):
            self.fixture = CanonicalDocsFixture()
            if failure == "main":
                self.fixture.changed_main = True
            else:
                self.fixture.legacy.changed_artifacts = True
            with self.subTest(failure=failure), self.assertRaises(owner.Rejected):
                self.fixture.read()

    def test_real_actions_refusal_occurs_before_any_owner_or_api_read(self):
        with (
            patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}),
            self.assertRaisesRegex(owner.Rejected, "EXTERNAL_DOCS_READER_REQUIRED"),
        ):
            self.fixture.read()
        self.assertEqual(self.fixture.qualifications, 0)
        self.assertEqual(self.fixture.source.calls, [])


if __name__ == "__main__":
    unittest.main()
