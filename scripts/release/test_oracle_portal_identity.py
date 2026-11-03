"""Adverse source/custody/operation tests; fixtures confer no hosted authority."""

import base64
import copy
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_identity as identity
import oracle_portal_identity_acceptance as acceptance
import oracle_portal_identity_restore as restore
import oracle_owner as owner
import test_oracle_owner as owner_fixtures


def binding():
    return {
        "repository": "DruHustle/onesa-company-portal",
        "component": "identity",
        "candidate_commit": "a" * 40,
        "source_tree": "b" * 40,
        "source_sha256": "c" * 64,
        "build_sha256": "d" * 64,
        "artifact_digest": "sha256:" + "e" * 64,
        "configuration_sha256": {},
        "target_environment": "production",
    }


def pin(path):
    return {"path": path, "sha256": "0" * 64}


def inputs():
    value = binding()
    plan = {
        "schema_version": 1,
        "qualification_profile": identity.PROFILE,
        "verifier_store": "/var/lib/onesa/verifier",
        "baseline": {"unrelated-" + str(i): {} for i in range(7)},
        "environments": {},
        "application_scan_sha256": "1" * 64,
        "legacy_backup": {},
        "restore": {},
        "privacy_decision": "G14_DEFERRED_BY_OWNER_PRELAUNCH",
    }
    for env in identity.ENVIRONMENTS:
        origins = {
            "portal": "https://portal.onesa.eu",
            "ai": "https://platform.onesa.eu",
            "drone": "https://drone.onesa.eu",
            "robot": "https://robot.onesa.eu",
        }
        if env == "staging":
            origins = {k: "https://onesa-" + k + "-staging.vercel.app" for k in origins}
        selected = {
            "origins": origins,
            **{
                key: pin("/etc/onesa/identity/" + env + "-" + key + ".json")
                for key in ["identity_file", "database_file", "browser_file"]
            },
        }
        for kind in ["api", "worker"]:
            directory = (
                "/opt/onesa/backends"
                if kind == "api"
                else "/opt/onesa/portal-" + env + "/releases/" + "c" * 40
            )
            selected[kind] = {
                "runtime_file": pin(
                    "/etc/onesa/"
                    + ("backends/portal-" if kind == "api" else "portal-")
                    + env
                    + ".env"
                ),
                "profile_sha256": "2" * 64,
                "recipe": {
                    "project": "onesa-portal-oracle-"
                    + ("api" if kind == "api" else env),
                    "directory": directory,
                    "files": [
                        pin(
                            directory
                            + ("/portal.yaml" if kind == "api" else "/compose.yaml")
                        )
                    ],
                    "environment_file": pin(
                        "/etc/onesa/backends/portal.images.env"
                        if kind == "api"
                        else directory + "/release.env"
                    ),
                },
            }
            plan["baseline"][identity.TARGETS[env][kind]] = {
                "image": "sha256:" + "3" * 64,
                "source": "f" * 40,
            }
        plan["environments"][env] = selected
    seal(value, plan)
    return value, plan


def seal(value, plan):
    value["configuration_sha256"] = {
        env: identity.digest(identity.configuration(plan, env))
        for env in identity.ENVIRONMENTS
    }


class ProfileTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is required for browser/verifier contract")
    def test_hosted_browser_and_owner_verifier_require_the_same_observations(self):
        root = Path(__file__).resolve().parents[2]
        program = (
            "import {ACCOUNT_CHECKS,PRODUCT_CHECKS} from "
            "'./scripts/release/oracle_portal_identity_browser.mjs'; "
            "console.log(JSON.stringify({account:ACCOUNT_CHECKS,product:PRODUCT_CHECKS}));"
        )
        observed = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e", program], cwd=root, timeout=15
        ))
        self.assertEqual(set(observed["account"]), identity.ACCOUNT_CHECKS)
        self.assertEqual(set(observed["account"]) | set(observed["product"]), identity.HOSTED_CHECKS)

    def test_only_separate_profile_and_existing_four_targets(self):
        value, plan = inputs()
        identity.validate_plan(value, plan)
        for mutate in [
            lambda b, p: b.update(component="api"),
            lambda b, p: p.update(qualification_profile="legacy-api"),
            lambda b, p: p["baseline"].pop(identity.TARGETS["staging"]["worker"]),
            lambda b, p: p["environments"]["production"]["api"]["recipe"].update(
                directory="/unreviewed"
            ),
            lambda b, p: p["environments"]["production"]["api"]["runtime_file"].update(
                path="/etc/onesa/backends/portal-staging.env"
            ),
            lambda b, p: p["environments"]["staging"].update(
                origins=copy.deepcopy(p["environments"]["production"]["origins"])
            ),
            lambda b, p: p["environments"]["production"]["origins"].update(
                portal="https://portal.onesa.eu.attacker.test"
            ),
            lambda b, p: p["environments"]["production"]["database_file"].update(
                path="/etc/onesa/identity/../foreign.json"
            ),
        ]:
            value, plan = inputs()
            mutate(value, plan)
            seal(value, plan)
            with self.subTest(mutate=mutate), self.assertRaises((r.Refused, KeyError)):
                identity.validate_plan(value, plan)

    def test_configuration_digest_binds_every_private_profile(self):
        value, plan = inputs()
        plan["environments"]["staging"]["browser_file"]["sha256"] = "9" * 64
        with self.assertRaisesRegex(r.Refused, "CONFIGURATION_CHANGED"):
            identity.validate_plan(value, plan)

    def test_exact_backend_closure_includes_auth_migrations_and_vendored_dependencies(
        self,
    ):
        root = Path(__file__).resolve().parents[2]
        files = {
            str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (root / "onesa-company-portal-backend").rglob("*")
            if p.is_file() and "node_modules" not in p.parts and "dist" not in p.parts
        }
        selected = identity.identity_source_files(files)
        self.assertIn(identity.PREFIX + "src/identity/provider.ts", selected)
        self.assertIn(identity.PREFIX + "package-lock.json", selected)
        for changed in [
            {**files, identity.PREFIX + "migrations/015_unapproved.sql": "0" * 64},
            {**files, identity.PREFIX + "migrations/013_onesa_identity.sql": "0" * 64},
            {
                k: v
                for k, v in files.items()
                if not k.endswith("src/identity/provider.ts")
            },
        ]:
            with self.assertRaises(r.Refused):
                identity.identity_source_files(changed)

    def test_runtime_receipt_uses_the_recovery_controller_fingerprint(self):
        row = {
            "Id": "a" * 64,
            "Image": "sha256:" + "b" * 64,
            "Config": {
                "Labels": {"org.onesa.source-commit": "c" * 40},
                "Env": ["SECRET=never-output"],
            },
            "HostConfig": {"ReadonlyRootfs": True},
            "Mounts": [],
            "NetworkSettings": {
                "Networks": {
                    "private": {"NetworkID": "d" * 64, "IPAddress": "10.0.0.2"}
                }
            },
        }
        expected = identity.digest(
            {
                "Config": row["Config"],
                "HostConfig": row["HostConfig"],
                "Mounts": [],
                "Networks": {"private": "d" * 64},
            }
        )
        result = identity.recovery_target(row)
        self.assertEqual(result["configuration_sha256"], expected)
        self.assertNotIn("never-output", json.dumps(result))
        row["NetworkSettings"]["Networks"]["private"]["NetworkID"] = "e" * 64
        self.assertNotEqual(
            identity.recovery_target(row)["configuration_sha256"], expected
        )

    def test_only_operation_bound_mailbox_templates_expand(self):
        operation = str(uuid4())
        fixtures = {
            "fixtures": {
                role: {
                    "email": "synthetic+onesa-acceptance-{operation_id}-"
                    + role
                    + "@mail.example.test"
                }
                for role in ["member", "administrator"]
            },
            "preview_sessions": {},
        }
        result = identity.fixture_aliases(fixtures, operation)
        self.assertIn(operation[:8], result["fixtures"]["member"]["email"])
        self.assertIn("{operation_id}", fixtures["fixtures"]["member"]["email"])
        for email in [
            "existing-user@mail.example.test",
            "onesa-acceptance-{operation_id}-member@{operation_id}.test",
            "onesa-acceptance-{operation_id}-administrator@mail.example.test",
        ]:
            changed = copy.deepcopy(fixtures)
            changed["fixtures"]["member"]["email"] = email
            with self.assertRaises(r.Refused):
                identity.fixture_aliases(changed, operation)


class CustodyTests(unittest.TestCase):
    def setUp(self):
        self.value, self.plan = inputs()
        self.databases = {}
        self.environment = {}
        for env in identity.ENVIRONMENTS:
            selected = self.plan["environments"][env]
            database = {
                "host": "db.example.test",
                "database": "portal_" + env,
                "owner_role": "portal_owner",
                "application_role": "portal_app",
            }
            self.databases[selected["database_file"]["path"]] = {
                "database": database,
                "owner_uri": "postgresql://portal_owner:synthetic@db.example.test/portal_"
                + env
                + "?sslmode=verify-full",
            }
            for kind in ["api", "worker"]:
                self.environment[selected[kind]["runtime_file"]["path"]] = {
                    "DATABASE_URL": "postgresql://portal_app:synthetic@db.example.test/portal_"
                    + env
                    + "?sslmode=verify-full",
                    "PUBLIC_ORIGIN": selected["origins"]["portal"],
                }
        self.enterContext(
            patch.object(
                identity,
                "private_bytes",
                side_effect=lambda p, *a, **kw: json.dumps(
                    self.databases.get(p["path"], {})
                ).encode(),
            )
        )
        self.enterContext(
            patch.object(
                r, "runtime_values", side_effect=lambda p: self.environment[str(p)]
            )
        )

    def test_optional_private_ca_custody_is_bounded_and_unknown_fields_refused(self):
        pointer = self.plan["environments"]["staging"]["database_file"]
        row = self.databases[pointer["path"]]
        row["database_ca_pem"] = "synthetic-ca"
        self.assertEqual(
            identity.database_custody(pointer)["database_ca_pem"], "synthetic-ca"
        )
        for invalid in ("", "x" * 8193, 1, None):
            row["database_ca_pem"] = invalid
            with self.assertRaisesRegex(r.Refused, "DATABASE_CA_INVALID"):
                identity.database_custody(pointer)
        row.pop("database_ca_pem")
        row["unexpected"] = True
        with self.assertRaisesRegex(r.Refused, "DATABASE_CUSTODY_SCHEMA"):
            identity.database_custody(pointer)

    def test_migration_passes_ca_on_stdin_without_recording_it(self):
        pointer = self.plan["environments"]["staging"]["database_file"]
        self.databases[pointer["path"]]["database_ca_pem"] = "synthetic-ca-value"
        operation = str(uuid4())
        writes = []
        observed = []

        def docker(*args, **kwargs):
            if args[0] == "inspect":
                return json.dumps(
                    [{"NetworkSettings": {"Networks": {"synthetic-net": {}}}}]
                ).encode()
            self.assertEqual(args[0], "run")
            observed.append(json.loads(kwargs["data"]))
            return json.dumps(
                {
                    "source_commit": binding()["candidate_commit"],
                    "operation_id": operation,
                    "environment": "staging",
                    "state": "IDENTITY_SCHEMA_INSPECTED_NOT_AUTHORIZATION",
                    "credential_changes": 0,
                    "down_migrations": 0,
                    "existing_accounts_preserved": True,
                    "schema_version": 12,
                }
            ).encode()

        with patch.object(r, "docker", side_effect=docker), patch.object(
            r, "write", side_effect=lambda path, value: writes.append(value)
        ):
            identity.migration(
                binding(), self.plan, "staging", operation, {}, "inspect", Path("/synthetic")
            )
        self.assertEqual(observed[0]["database_ca_pem"], "synthetic-ca-value")
        self.assertNotIn("synthetic-ca-value", json.dumps(writes))

    def test_runtime_ca_must_match_pinned_custody_for_api_and_worker(self):
        stage = self.plan["environments"]["staging"]
        self.databases[stage["database_file"]["path"]]["database_ca_pem"] = "synthetic-ca"
        expected = base64.b64encode(b"synthetic-ca").decode("ascii")
        for kind in ("api", "worker"):
            self.environment[stage[kind]["runtime_file"]["path"]]["ONESA_DATABASE_CA_PEM_B64"] = expected
        identity.validate_custody(self.plan)
        values = self.environment[stage["worker"]["runtime_file"]["path"]]
        values["ONESA_DATABASE_CA_PEM_B64"] = base64.b64encode(b"other-ca").decode("ascii")
        with self.assertRaisesRegex(r.Refused, "RUNTIME_DATABASE_CA_MISMATCH"):
            identity.validate_custody(self.plan)
        values.pop("ONESA_DATABASE_CA_PEM_B64")
        with self.assertRaisesRegex(r.Refused, "RUNTIME_DATABASE_CA_MISMATCH"):
            identity.validate_custody(self.plan)
        self.databases[stage["database_file"]["path"]].pop("database_ca_pem")
        with self.assertRaisesRegex(r.Refused, "RUNTIME_DATABASE_CA_MISMATCH"):
            identity.validate_custody(self.plan)

    def test_api_worker_pairing_and_distinct_stage_database(self):
        identity.validate_custody(self.plan)
        name = self.plan["environments"]["staging"]["worker"]["runtime_file"]["path"]
        self.environment[name]["DATABASE_URL"] = self.environment[name][
            "DATABASE_URL"
        ].replace("portal_staging", "portal_production")
        with self.assertRaises(r.Refused):
            identity.validate_custody(self.plan)

    def test_credentials_and_public_origin_cannot_be_swapped(self):
        name = self.plan["environments"]["staging"]["api"]["runtime_file"]["path"]
        self.environment[name]["PUBLIC_ORIGIN"] = "https://portal.onesa.eu"
        with self.assertRaisesRegex(r.Refused, "ISSUER_MISMATCH"):
            identity.validate_custody(self.plan)

    def test_same_database_is_refused_even_with_valid_pinned_environment_files(self):
        stage = self.plan["environments"]["staging"]
        self.databases[stage["database_file"]["path"]]["database"][
            "database"
        ] = "portal_production"
        self.databases[stage["database_file"]["path"]]["owner_uri"] = self.databases[
            stage["database_file"]["path"]
        ]["owner_uri"].replace("portal_staging", "portal_production")
        for kind in ["api", "worker"]:
            values = self.environment[stage[kind]["runtime_file"]["path"]]
            values["DATABASE_URL"] = values["DATABASE_URL"].replace(
                "portal_staging", "portal_production"
            )
        with self.assertRaisesRegex(r.Refused, "DATABASE_MUST_BE_ISOLATED"):
            identity.validate_custody(self.plan)


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            dir=Path.home() if os.getuid() == 0 else None
        )
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        if os.getuid() != 0:
            self.enterContext(
                patch.object(r, "private", side_effect=lambda p, **kwargs: Path(p))
            )

    def test_reserved_intent_survives_failure_and_cannot_be_reused(self):
        identifier = str(uuid4())
        target = identity.reserve(
            self.root / "deployments",
            identifier,
            {"request_budget": 1, "automatic_retry": False},
        )
        with self.assertRaisesRegex(r.Refused, "ALREADY_EXISTS"):
            identity.reserve(self.root / "deployments", identifier, {})
        self.assertEqual(r.read(target / "intent.json")["request_budget"], 1)

    def test_production_inspection_cannot_resume_missing_deployment(self):
        with patch.object(identity, "ROOT", self.root), patch.object(
            identity, "compose_change"
        ) as change, patch.object(identity, "migration") as migrate, patch.object(
            identity, "hosted"
        ) as hosted:
            with self.assertRaises((OSError, r.Refused)):
                identity.production(
                    binding(),
                    {},
                    {"operation_id": str(uuid4()), "read_only": True},
                    self.root,
                    [],
                )
            change.assert_not_called()
            migrate.assert_not_called()
            hosted.assert_not_called()

    def test_private_fixture_cannot_replace_signed_source_or_operation(self):
        value, plan = inputs()
        malicious = {
            "fixtures": {},
            "preview_sessions": {},
            "binding": {"candidate_commit": "f" * 40},
        }
        with patch.object(
            identity, "private_bytes", return_value=json.dumps(malicious).encode()
        ), patch.object(r, "docker") as docker:
            with self.assertRaisesRegex(r.Refused, "PRIVATE_BROWSER_INPUT_SCHEMA"):
                identity.hosted(value, plan, "staging", str(uuid4()), self.root)
            docker.assert_not_called()

    def test_provider_interruption_leaves_single_intent_and_never_retries(self):
        value, plan = inputs()
        original = {
            "services": {
                "production": {
                    "environment": {"PORT": "8300"},
                    "image": "sha256:" + "3" * 64,
                    "labels": {},
                }
            }
        }
        identity_values = {
            "ONESA_IDENTITY_ENABLED": "true",
            "ONESA_IDENTITY_CONFIG_B64": "synthetic-private-input",
        }

        def render(runtime, env, kind, override=None):
            if override is None:
                return copy.deepcopy(original)
            result = copy.deepcopy(original)
            result["services"][env].update(r.read(override)["services"][env])
            return result

        with patch.object(identity, "rendered", side_effect=render), patch.object(
            identity, "recipe_command", return_value=["synthetic-compose"]
        ), patch.object(
            identity.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("synthetic", 300),
        ) as called:
            with self.assertRaisesRegex(r.Refused, "INTERRUPTED_INSPECT_ONLY"):
                identity.compose_change(
                    value,
                    plan,
                    "production",
                    "api",
                    str(uuid4()),
                    self.root,
                    identity_values,
                )
            self.assertEqual(called.call_count, 1)
            self.assertEqual(
                r.read(self.root / "api-result.json")["automatic_retry"], False
            )
            self.assertEqual(r.read(self.root / "api-intent.json")["request_budget"], 1)

    def test_fallback_selects_qualified_candidate_and_explicitly_disables_identity(
        self,
    ):
        value, plan = inputs()
        original = {
            "services": {
                "staging": {
                    "environment": {"PORT": "8300"},
                    "image": plan["baseline"][identity.TARGETS["staging"]["api"]][
                        "image"
                    ],
                    "labels": {},
                }
            }
        }

        def render(runtime, env, kind, override=None):
            result = copy.deepcopy(original)
            if override is not None:
                result["services"][env].update(r.read(override)["services"][env])
            return result

        with (
            patch.object(identity, "rendered", side_effect=render),
            patch.object(
                identity, "recipe_command", return_value=["synthetic-compose"]
            ),
            patch.object(
                identity.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired("synthetic", 300),
            ),
        ):
            with self.assertRaisesRegex(r.Refused, "INTERRUPTED_INSPECT_ONLY"):
                identity.compose_change(
                    value,
                    plan,
                    "staging",
                    "api",
                    str(uuid4()),
                    self.root,
                    {
                        "ONESA_IDENTITY_ENABLED": "true",
                        "ONESA_IDENTITY_CONFIG_B64": "secret",
                    },
                    rollback=True,
                )
        selected = r.read(self.root / "api-override.json")["services"]["staging"]
        self.assertEqual(selected["image"], value["artifact_digest"])
        self.assertEqual(
            selected["labels"]["org.onesa.source-commit"], value["candidate_commit"]
        )
        self.assertEqual(selected["environment"]["ONESA_IDENTITY_ENABLED"], "false")
        self.assertNotIn("ONESA_IDENTITY_CONFIG_B64", selected["environment"])

    def test_rendered_privilege_or_mount_change_stops_before_provider_request(self):
        value, plan = inputs()
        original = {
            "services": {
                "production": {
                    "image": "sha256:" + "3" * 64,
                    "environment": {},
                    "labels": {},
                }
            }
        }
        changed = copy.deepcopy(original)
        changed["services"]["production"]["privileged"] = True
        with patch.object(
            identity, "rendered", side_effect=[original, changed]
        ), patch.object(identity.subprocess, "run") as called:
            with self.assertRaisesRegex(r.Refused, "WOULD_CHANGE_OTHER_CONFIGURATION"):
                identity.compose_change(
                    value,
                    plan,
                    "production",
                    "api",
                    str(uuid4()),
                    self.root,
                    {
                        "ONESA_IDENTITY_ENABLED": "true",
                        "ONESA_IDENTITY_CONFIG_B64": "synthetic",
                    },
                )
            called.assert_not_called()
            self.assertFalse((self.root / "api-intent.json").exists())


class AcceptedRuntimeTests(unittest.TestCase):
    def test_future_production_deployment_resolves_only_signed_exact_identity(self):
        accepted = {"observation": {"deployment_id": "dpl_acceptedCandidate"}}
        fixed = {"deployment_id": "dpl_acceptedCandidate"}
        future = {"deployment_id": acceptance.CURRENT}
        self.assertEqual(
            acceptance.deployment_identity(fixed, accepted, "staging"),
            "dpl_acceptedCandidate",
        )
        self.assertEqual(
            acceptance.deployment_identity(future, accepted, "production"),
            "dpl_acceptedCandidate",
        )
        for plan, observed, env in [
            (future, accepted, "staging"),
            ({"deployment_id": "dpl_other"}, accepted, "production"),
            (future, {"observation": {}}, "production"),
            (future, {"observation": {"deployment_id": "container-not-vercel"}}, "production"),
        ]:
            with self.subTest(plan=plan, env=env), self.assertRaisesRegex(
                r.Refused, "SIGNED_FRONTEND_DEPLOYMENT_CHANGED"
            ):
                acceptance.deployment_identity(plan, observed, env)

    def test_signed_runtime_pins_configuration_and_container_as_well_as_image(self):
        actual = {
            "container_id": "a" * 64,
            "image_id": "sha256:" + "b" * 64,
            "source_commit": "c" * 40,
            "configuration_sha256": "d" * 64,
        }
        for product in acceptance.REPOSITORIES:
            observation = (
                {"runtime_targets": {"portal-api-staging": actual}}
                if product == "portal"
                else {"backend_runtime": actual}
            )
            acceptance.accepted_runtime(product, "staging", actual, observation)
            for key in actual:
                changed = {**actual, key: "different"}
                with self.subTest(product=product, key=key), self.assertRaisesRegex(
                    r.Refused, "SIGNED_BACKEND_RUNTIME_CHANGED"
                ):
                    acceptance.accepted_runtime(product, "staging", changed, observation)
            with self.assertRaises(r.Refused):
                acceptance.accepted_runtime(product, "staging", actual, {})


class SignatureTests(unittest.TestCase):
    setUpClass = classmethod(owner_fixtures.OwnerStoreTests.setUpClass.__func__)
    settings = owner_fixtures.OwnerStoreTests.settings
    open = owner_fixtures.OwnerStoreTests.open
    commission_fixture = owner_fixtures.OwnerStoreTests.commission_fixture

    def setUp(self):
        owner_fixtures.OwnerStoreTests.setUp(self)

        def fixture_private(path, *, directory=False, uid=0):
            path = Path(path)
            # Native CI is unprivileged. Keep real file/mode/link checks under
            # its disposable store; never consult or relax production custody.
            self.assertTrue(path == self.root or self.root in path.parents)
            owner.private(path, directory=directory, uid=os.getuid())
            return path

        self.enterContext(patch.object(r, "private", side_effect=fixture_private))

    def records(self):
        context = self.store.put("context", self.binding, {"ci": [{"run_id": 123}]})[
            "record"
        ]
        observation = {
            "binding": self.binding,
            "environment": "staging",
            "checks": {key: "PASS" for key in owner.REQUIRED_CHECKS["staging"]},
        }
        operations = {
            "observations": {
                "checks": {key: "PASS" for key in owner.REQUIRED_CHECKS["operations"]}
            }
        }
        qualification = self.store.put(
            "qualification",
            self.binding,
            {"staging": {"observations": observation}, "operations": operations},
            parent=context["id"],
        )["record"]
        return (
            context,
            qualification,
            {
                "store": str(self.root),
                "record_id": qualification["id"],
                "binding": self.binding,
            },
        )

    def test_real_signature_and_commissioned_store_are_required(self):
        context, qualification, reference = self.records()
        proof = acceptance.signed_dependency(reference, "staging")
        self.assertEqual(proof["operation"], context["id"])
        self.assertEqual(proof["record_sha256"], identity.digest(qualification))
        envelope = json.loads(
            self.store.db.execute(
                "SELECT envelope FROM records WHERE id=?", (qualification["id"],)
            ).fetchone()[0]
        )
        envelope["record"]["details"]["staging"]["observations"]["checks"][
            "authentication_and_authorization"
        ] = "caller-PASS"
        self.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?",
            (json.dumps(envelope), qualification["id"]),
        )
        with self.assertRaises((owner.Rejected, r.Refused)):
            acceptance.signed_dependency(reference, "staging")

    def test_revoked_ancestor_and_foreign_environment_cannot_supply_acceptance(self):
        context, _, reference = self.records()
        with self.assertRaises(r.Refused):
            acceptance.signed_dependency(reference, "production")
        self.store.db.execute(
            "UPDATE records SET revoked=1 WHERE id=?", (context["id"],)
        )
        with self.assertRaisesRegex(r.Refused, "REVOKED_OR_MISSING"):
            acceptance.signed_dependency(reference, "staging")

    def test_changed_binding_and_inactive_trust_anchor_are_rejected(self):
        _, _, reference = self.records()
        changed = copy.deepcopy(reference)
        changed["binding"]["artifact_digest"] = "sha256:" + "0" * 64
        with self.assertRaises(r.Refused):
            acceptance.signed_dependency(changed, "staging")
        registry = json.loads(self.anchor.read_bytes())
        registry["installations"][str(self.root)]["active"] = False
        self.anchor.write_bytes(owner.canonical(registry))
        with self.assertRaises(owner.Rejected):
            acceptance.signed_dependency(reference, "staging")

    def test_future_record_selector_resolves_only_one_exact_accepted_operation(self):
        context, qualified, reference = self.records()
        reference["record_id"] = acceptance.CURRENT
        self.assertEqual(
            acceptance.signed_dependency(reference, "staging")["record_id"],
            qualified["id"],
        )
        other_context = self.store.put(
            "context", self.binding, {"ci": [{"run_id": 124}]}
        )["record"]
        self.store.put(
            "qualification",
            self.binding,
            qualified["details"],
            parent=other_context["id"],
        )
        with self.assertRaisesRegex(r.Refused, "EXACT_ACCEPTED_OPERATION_REQUIRED"):
            acceptance.signed_dependency(reference, "staging")

    def test_revoked_authorization_attempt_cannot_hide_outside_parent_chain(self):
        _, qualified, reference = self.records()
        attempt = self.store.put(
            "authorization-attempt",
            self.binding,
            {"decision": "PENDING"},
            parent=qualified["id"],
        )["record"]
        authorization = self.store.put(
            "authorization",
            self.binding,
            {
                "attempt_id": attempt["id"],
                "decision": "approve",
                "physical_hardware_authorized": False,
            },
            parent=qualified["id"],
        )["record"]
        intent = self.store.put(
            "deployment-intent", self.binding, {}, parent=authorization["id"]
        )["record"]
        observation = {
            "binding": self.binding,
            "environment": "production",
            "operation_id": intent["id"],
            "checks": {key: "PASS" for key in owner.REQUIRED_CHECKS["production"]},
        }
        verified = self.store.put(
            "production-verification",
            self.binding,
            {"observations": observation},
            parent=intent["id"],
        )["record"]
        reference["record_id"] = verified["id"]
        acceptance.signed_dependency(reference, "production")
        self.store.db.execute(
            "UPDATE records SET revoked=1 WHERE id=?", (attempt["id"],)
        )
        with self.assertRaisesRegex(r.Refused, "REVOKED_OR_MISSING"):
            acceptance.signed_dependency(reference, "production")


class FallbackProofTests(unittest.TestCase):
    def test_fallback_rejects_foreign_restore_before_docker_access(self):
        with patch.object(r, "docker") as docker:
            with self.assertRaisesRegex(r.Refused, "FALLBACK_OPERATION_SCOPE"):
                restore.fallback_observe(
                    binding(), str(uuid4()), "someone-elses-restore", "a" * 64,
                    "onesa_identity_restore", {},
                )
            docker.assert_not_called()

    def test_temporary_postgres_server_cannot_satisfy_restore_readiness(self):
        temporary = subprocess.CompletedProcess([], 0, b"temporary server ready", b"")
        initialized = subprocess.CompletedProcess(
            [], 0, b"PostgreSQL init process complete", b""
        )
        ready = subprocess.CompletedProcess([], 0, b"accepting connections", b"")
        with (
            patch.object(
                restore.subprocess, "run", side_effect=[temporary, initialized, ready]
            ) as run,
            patch.object(restore.time, "sleep"),
        ):
            restore.wait_for_restore("a" * 64, "onesa_identity_restore")
        self.assertEqual(
            [call.args[0][1] for call in run.call_args_list], ["logs", "logs", "exec"]
        )
        command = run.call_args_list[-1].args[0]
        self.assertEqual(command[command.index("-h") + 1], "127.0.0.1")

    def test_fallback_requires_every_observation_and_the_exact_candidate(self):
        value = binding()
        valid = {
            "image": value["artifact_digest"],
            "source_commit": value["candidate_commit"],
            "identity_enabled": False,
            "representative_member_present": True,
            "account_serialization": True,
            "native_authentication": True,
            "api_behavior": True,
            "worker_behavior": True,
            "operation_resources_removed": True,
        }
        restore.verify_fallback({"compatible_fallback": valid}, value)
        for key in valid:
            candidate = dict(valid)
            candidate.pop(key)
            with (
                self.subTest(missing=key),
                self.assertRaisesRegex(r.Refused, "FALLBACK_REHEARSAL_REQUIRED"),
            ):
                restore.verify_fallback({"compatible_fallback": candidate}, value)
        for key in ("image", "source_commit"):
            candidate = dict(valid)
            candidate[key] = "unrelated"
            with self.subTest(changed=key), self.assertRaises(r.Refused):
                restore.verify_fallback({"compatible_fallback": candidate}, value)
        with self.assertRaises(r.Refused):
            restore.verify_fallback({}, value)

    def test_container_cleanup_requires_a_successful_exact_id_readback(self):
        container = "a" * 64
        with patch.object(r, "docker", return_value=b"") as docker:
            restore.verify_container_removed(container)
            self.assertIn("id=" + container, docker.call_args.args)
        with patch.object(r, "docker", return_value=(container + "\n").encode()):
            with self.assertRaisesRegex(r.Refused, "CLEANUP_NOT_CONFIRMED"):
                restore.verify_container_removed(container)
        with patch.object(r, "docker", side_effect=r.Refused("DOCKER_UNAVAILABLE")):
            with self.assertRaisesRegex(r.Refused, "DOCKER_UNAVAILABLE"):
                restore.verify_container_removed(container)
        with self.assertRaisesRegex(r.Refused, "CONTAINER_IDENTITY"):
            restore.verify_container_removed("not-an-id")

    def test_failed_fallback_removes_only_the_verified_operation_container(self):
        operation = str(uuid4())
        candidate, parent, probe = binding(), "b" * 64, "a" * 64
        name = "onesa-isolated-portal-fallback-" + operation.replace("-", "")
        item = {
            "Id": probe,
            "Name": "/" + name,
            "Image": candidate["artifact_digest"],
            "Config": {
                "Labels": {
                    "org.onesa.restore-scope": "isolated-fallback",
                    "org.onesa.restore-operation": operation,
                }
            },
            "HostConfig": {
                "NetworkMode": "container:" + parent,
                "ReadonlyRootfs": True,
                "PortBindings": {},
            },
            "Mounts": [],
        }

        def docker(*args, **kwargs):
            if args == ("inspect", parent):
                return b"[{}]"
            if args == ("inspect", probe):
                return json.dumps([item]).encode()
            if args[0] == "create":
                return probe.encode()
            if args[0] == "start":
                raise r.Refused("SYNTHETIC_PROBE_FAILURE")
            return b""

        with (
            patch.object(restore, "sql", return_value=b"0"),
            patch.object(
                restore.restore_replay, "isolated_target", return_value=parent
            ),
            patch.object(
                restore.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 1),
            ),
            patch.object(r, "docker", side_effect=docker) as docker_call,
        ):
            with self.assertRaisesRegex(r.Refused, "SYNTHETIC_PROBE_FAILURE"):
                restore.fallback_observe(
                    candidate,
                    operation,
                    "onesa-isolated-portal-restore-" + operation.replace("-", ""),
                    parent,
                    "onesa_identity_restore",
                    {},
                )
        self.assertIn(
            (("rm", "-f", probe), {}),
            [(call.args, call.kwargs) for call in docker_call.call_args_list],
        )
        self.assertTrue(
            any(
                call.args[:3] == ("container", "ls", "--all")
                for call in docker_call.call_args_list
            )
        )


class BackupPayloadTests(unittest.TestCase):
    def valid(self):
        raw = b"PGDMP-synthetic-custom-archive"
        payload = {
            "dump": base64.b64encode(raw).decode(),
            "session_key": "synthetic-key-" * 6,
            "manifest": [
                {"table": "table_" + str(i), "count": 0, "hash": "a" * 32}
                for i in range(17)
            ],
            "objects": [],
            "checks": {
                "key_recovered_from_off_instance_escrow": True,
                "original_private_key_file_not_used": True,
                "ciphertext_integrity_verified": True,
                "tampered_archive_rejected": True,
                "object_count": 0,
            },
        }
        backup = {"dump_sha256": hashlib.sha256(raw).hexdigest(), "object_count": 0}
        return raw, payload, backup

    def test_recovered_dump_key_and_all_object_bytes_are_checked(self):
        raw, payload, backup = self.valid()
        self.assertEqual(
            restore.payload_valid(payload, backup, payload["session_key"]), raw
        )
        for mutate in [
            lambda p: p.update(dump=base64.b64encode(b"PGDMP-counterfeit").decode()),
            lambda p: p.update(session_key="wrong-key"),
            lambda p: p["checks"].update(tampered_archive_rejected=False),
            lambda p: p["manifest"].append(p["manifest"][0]),
            lambda p: p["objects"].append(
                {
                    "storage_key": "../../arbitrary",
                    "bytes": "",
                    "size": 0,
                    "sha256": "0" * 64,
                }
            ),
        ]:
            value = copy.deepcopy(payload)
            mutate(value)
            with self.assertRaises(r.Refused):
                restore.payload_valid(value, backup, payload["session_key"])


if __name__ == "__main__":
    unittest.main()
