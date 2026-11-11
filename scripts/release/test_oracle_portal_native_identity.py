"""Seven-client integration, using native release evidence and public source identities."""
import copy
import json
import unittest
from unittest.mock import patch

import oracle_portal_identity_acceptance as acceptance
import test_oracle_portal_identity as historical


REV = "a" * 40
IMAGE = "sha256:" + "1" * 64
WEB = "sha256:" + "2" * 64
PIN = {"path": "/etc/onesa/identity/test-provider.json", "sha256": "4" * 64}


def release(product):
    _, _, services = acceptance.NATIVE_PRODUCTS[product]
    record = {"revision": REV, "ci_run_id": 123, "compose_project": product + "-stage",
              "images": dict(zip(services, (IMAGE, WEB)))}
    if product != "farmer":
        record.update(provider_file=PIN, project_id="prj_scoped", deployment_id="dpl_expected")
    return record


def ci(product):
    repo, workflow, _ = acceptance.NATIVE_PRODUCTS[product]
    repo = {"full_name": "DruHustle/" + repo}
    return {"id": 123, "conclusion": "success", "status": "completed", "event": "push", "head_branch": "main",
            "head_sha": REV, "path": ".github/workflows/" + workflow, "repository": repo, "head_repository": repo}


def row():
    return {"Id": "5" * 64, "Image": IMAGE,
            "Config": {"Labels": {"com.docker.compose.project": "mobile-stage", "com.docker.compose.service": "api"}},
            "State": {"Running": True, "OOMKilled": False, "Health": {"Status": "healthy"}}}


class NativeProductEvidence(unittest.TestCase):
    def test_profile_pins_only_the_applicable_service_images_and_provider(self):
        for name in acceptance.NATIVE_PRODUCTS:
            with self.subTest(product=name):
                acceptance.validate_native(name, release(name))
        for field, bad in [("images", {"api": IMAGE}), ("images", {"api": IMAGE, "web": IMAGE}),
                           ("images", {"api": IMAGE, "web": "latest"}), ("revision", "main"),
                           ("ci_run_id", True), ("deployment_id", acceptance.CURRENT)]:
            with self.subTest(field=field), self.assertRaises(acceptance.r.Refused):
                acceptance.validate_native("mobile", {**release("mobile"), field: bad})

    def test_only_a_successful_exact_native_main_run_qualifies(self):
        run = ci("farmer")
        for key, bad in [("id", 5), ("event", "pull_request"), ("head_branch", "test"),
                         ("head_sha", "b" * 40), ("head_repository", {"full_name": "other/fork"}),
                         ("path", ".github/workflows/unrelated.yml"), ("conclusion", "skipped")]:
            with self.subTest(key=key), patch.object(acceptance, "native_ci_run", return_value={**run, key: bad}), \
                    self.assertRaises(acceptance.r.Refused):
                acceptance.native_dependency("farmer", release("farmer"), "staging", "https://stage.test", {})

    def test_rechecks_both_farmer_containers_and_the_public_web_revision(self):
        for observed in [REV, "b" * 40]:
            with patch.object(acceptance, "native_ci_run", return_value=ci("farmer")), \
                    patch.object(acceptance, "native_runtime", return_value={"source_commit": REV}) as runtime, \
                    patch.object(acceptance.r, "http_read", return_value={"revision": observed}) as served:
                args = ("farmer", release("farmer"), "staging", "https://farm.test", {})
                if observed == REV:
                    actual = acceptance.native_dependency(*args)
                    self.assertEqual(set(actual["runtime"]), {"api", "web"})
                    self.assertEqual(runtime.call_count, 2)
                    served.assert_called_once_with("https://farm.test", "/release.json", 200)
                else:
                    with self.assertRaises(acceptance.r.Refused):
                        acceptance.native_dependency(*args)

    def test_image_source_is_read_from_immutable_image_and_duplicate_services_fail(self):
        container = row()
        container["Config"]["Labels"]["org.opencontainers.image.revision"] = REV
        inventory = {"api-1": container}
        for revision in [REV, "b" * 40]:
            image = [{"Id": IMAGE, "Config": {"Labels": {"org.opencontainers.image.revision": revision}}}]
            with patch.object(acceptance.r, "docker", return_value=json.dumps(image)) as docker, \
                    patch.object(acceptance.identity, "recovery_target", return_value={"configuration_sha256": "0" * 64}):
                args = (inventory, "mobile-stage", "api", IMAGE, REV)
                if revision == REV:
                    self.assertEqual(acceptance.native_runtime(*args)["container_id"], container["Id"])
                    docker.assert_called_once_with("image", "inspect", IMAGE)
                else:
                    with self.assertRaises(acceptance.r.Refused):
                        acceptance.native_runtime(*args)
        with self.assertRaises(acceptance.r.Refused):
            acceptance.native_runtime({**inventory, "api-2": copy.deepcopy(container)}, "mobile-stage", "api", IMAGE, REV)

    def test_current_alias_project_source_and_environment_are_required(self):
        record = release("logistics")
        meta = {"smartLogisticsSourceRevision": REV, "smartLogisticsRepository": "DruHustle/smart-logistics"}
        dep = {"id": record["deployment_id"], "projectId": record["project_id"], "readyState": "READY",
               "meta": meta, "target": "production"}
        alias = {"deploymentId": record["deployment_id"], "projectId": record["project_id"]}
        for deployed, routed, ok in [(dep, alias, True), (dep, {**alias, "deploymentId": "dpl_old"}, False),
                                     ({**dep, "target": "preview"}, alias, False),
                                     ({**dep, "meta": {**meta, "smartLogisticsSourceRevision": "b" * 40}}, alias, False)]:
            with patch.object(acceptance.identity, "private_bytes", return_value=b'{"team_id":"team_test","token":"synthetic-credential"}'), \
                    patch.object(acceptance, "provider_get", side_effect=[deployed, routed]):
                args = ("logistics", record, "https://logistics.onesa.eu", "production")
                if ok:
                    self.assertEqual(acceptance.native_frontend(*args)["deployment_id"], "dpl_expected")
                else:
                    with self.assertRaises(acceptance.r.Refused):
                        acceptance.native_frontend(*args)

    def test_expanded_checks_belong_only_to_version_two(self):
        for phase in acceptance.CHECKS:
            self.assertEqual(acceptance.CHECKS_V2[phase] - acceptance.CHECKS[phase],
                             {"native_release_provenance", "seven_product_administrator_sessions"})


class PortalV2DependencyEvidence(unittest.TestCase):
    def setUp(self):
        self.operation = "d872f1f5-94e1-4dcf-877b-1e70fd1b295d"
        self.binding = {"repository": acceptance.REPOSITORIES["portal"], "component": "identity"}
        self.profile = {"qualification_profile": acceptance.identity.PROFILE_V2,
                        "required_checks": {phase: sorted(checks) for phase, checks in acceptance.identity.CHECKS_V2.items()}}

    def issuer(self, env):
        base = {"scope": "account", "binding": self.binding, "environment": env, "operation_id": self.operation,
                "physical_hardware_authorized": False, "physical_operations": 0}
        admin = {**base, "schema_version": 2, "state": "HOSTED_ADMINISTRATOR_SIGNIN_OBSERVED_NOT_AUTHORIZATION",
                 "checks": {"portal_mfa_administrator": True}}
        hosted = {**base, "schema_version": 1, "state": "HOSTED_IDENTITY_OBSERVED_NOT_AUTHORIZATION",
                  "checks": {key: True for key in acceptance.identity.hosted_checks(self.profile, "account")},
                  "administrator_observation": admin}
        observation = {"checks": {key: "PASS" for key in acceptance.identity.CHECKS_V2[env]}}
        if env == "staging":
            observation["receipt"] = {"binding": self.binding, "context_id": self.operation,
                                      "state": "IDENTITY_STAGING_OBSERVED_NOT_AUTHORIZATION", "hosted": hosted}
        else:
            observation.update(operation_id=self.operation, hosted=hosted)
        return observation

    def test_issuer_requires_its_commissioned_v2_profile_and_signed_active_environment_proof(self):
        for env in ("staging", "production"):
            def verify(observation, profile):
                acceptance.portal_v2_evidence(acceptance.identity.PROFILE_V2, profile, observation,
                                              self.binding, env, self.operation)
            valid = self.issuer(env)
            verify(valid, self.profile)
            for bad_profile in [acceptance.identity.PROFILE, None]:
                with self.subTest(env=env, profile=bad_profile), self.assertRaisesRegex(acceptance.r.Refused, "DEPENDENCY_PROFILE"):
                    verify(valid, {**self.profile, "qualification_profile": bad_profile})
            for key in ("seven_client_registry", "portal_mfa_administrator"):
                weakened = copy.deepcopy(self.profile)
                weakened["required_checks"][env].remove(key)
                bad = copy.deepcopy(valid)
                del bad["checks"][key]
                for observation, policy in [(bad, self.profile), (valid, weakened)]:
                    with self.subTest(env=env, check=key), self.assertRaisesRegex(acceptance.r.Refused, "ISSUER_REGISTRY_CHECKS"):
                        verify(observation, policy)
            for field, wrong in [("environment", "foreign"), ("operation_id", "other"), ("scope", "integrated"),
                                 ("binding", {}), ("checks", {"portal_mfa_administrator": 1}),
                                 ("physical_operations", 1), ("schema_version", True)]:
                with self.subTest(env=env, field=field), self.assertRaises(acceptance.r.Refused):
                    bad = copy.deepcopy(valid)
                    hosted = bad.get("receipt", bad)["hosted"]
                    hosted["administrator_observation"][field] = wrong
                    verify(bad, self.profile)
            with self.assertRaises(acceptance.r.Refused):
                bad = copy.deepcopy(valid)
                del bad.get("receipt", bad)["hosted"]["administrator_observation"]
                verify(bad, self.profile)

    def test_frontend_needs_its_signed_authentication_source_observation(self):
        binding = {**self.binding, "component": "frontend"}
        profile = {"qualification_profile": acceptance.FRONTEND_PROFILE_V2}
        scope = {"qualification_profile": acceptance.FRONTEND_PROFILE_V2,
                 "authentication_source_explicitly_reviewed": True, "new_full_business_acceptance_claimed": False,
                 "product_presentation_requires_current_hosted_acceptance": True}
        observation = {"status": "PASS", "operation_id": self.operation, "source_scope": scope}
        for env in ("staging", "production"):
            def verify(record, policy=profile):
                acceptance.portal_v2_evidence(acceptance.FRONTEND_PROFILE_V2, policy, record, binding, env, self.operation)
            verify(observation)
            for key in scope:
                bad = {**observation, "source_scope": {name: value for name, value in scope.items() if name != key}}
                with self.subTest(env=env, key=key), self.assertRaisesRegex(acceptance.r.Refused, "FRONTEND_SOURCE_SCOPE"):
                    verify(bad)
            with self.assertRaises(acceptance.r.Refused):
                verify({**observation, "operation_id": "unrelated-operation"})
            with self.assertRaises(acceptance.r.Refused):
                verify(observation, {"qualification_profile": "frontend-identity-v1"})

    def test_dependency_reader_applies_exact_profiles_only_to_seven_client_portal_dependencies(self):
        for profile, product, expected in [(acceptance.PROFILE_V2, "portal", [acceptance.identity.PROFILE_V2, acceptance.FRONTEND_PROFILE_V2]),
                                           (acceptance.PROFILE, "portal", [None,None]),
                                           (acceptance.PROFILE_V2, "robot", [None,None])]:
            for env in ("staging", "production"):
                source = {"backend": {"binding": {}}, "frontend": {"binding": {}}}
                plan = {"qualification_profile": profile, "environments": {env: {"products": {product: source}}}}
                with patch.object(acceptance.r, "inventory", return_value={}), patch.object(acceptance, "signed_dependency") as signed, \
                     patch.object(acceptance, "deployment_identity", side_effect=RuntimeError("end of signed reads")):
                    with self.assertRaisesRegex(RuntimeError, "end of signed reads"):
                        acceptance.dependencies(plan, env)
                    self.assertEqual([call.kwargs.get("expected_portal_profile") for call in signed.call_args_list], expected)
                    self.assertEqual([call.args[1] for call in signed.call_args_list], [env, env])


class SignedPortalDependency(unittest.TestCase):
    setUpClass = classmethod(historical.SignatureTests.setUpClass.__func__)
    setUp = historical.SignatureTests.setUp
    settings = historical.SignatureTests.settings
    open = historical.SignatureTests.open
    commission_fixture = historical.SignatureTests.commission_fixture
    records = historical.SignatureTests.records

    def test_real_signed_generic_record_cannot_supply_seven_client_frontend_qualification(self):
        self.binding["component"] = "frontend"
        component = self.policy["components"].pop(self.binding["repository"] + ":api")
        component["qualification_profile"] = acceptance.FRONTEND_PROFILE_V2
        self.policy["components"][self.binding["repository"] + ":frontend"] = component
        owner = acceptance.owner
        (self.root / "policy.json").write_bytes(owner.canonical(self.policy))
        trust_file = self.root / "trust.json"
        trust = json.loads(trust_file.read_bytes())
        trust["policy_sha256"] = owner.file_digest(self.root / "policy.json")
        trust_file.write_bytes(owner.canonical(trust))
        self.commission_fixture()

        context, signed, reference = self.records()
        self.assertEqual(acceptance.signed_dependency(reference, "staging")["record_id"], signed["id"])
        with self.assertRaisesRegex(acceptance.r.Refused, "FRONTEND_SOURCE_SCOPE"):
            acceptance.signed_dependency(reference, "staging", expected_portal_profile=acceptance.FRONTEND_PROFILE_V2)

        details = copy.deepcopy(signed["details"])
        details["staging"]["observations"].update(
            status="PASS", operation_id=context["id"],
            source_scope={"qualification_profile": acceptance.FRONTEND_PROFILE_V2, "authentication_source_explicitly_reviewed": True,
                          "product_presentation_requires_current_hosted_acceptance": True, "new_full_business_acceptance_claimed": False},
        )
        genuine = self.store.put("qualification", self.binding, details, parent=context["id"])["record"]
        reference["record_id"] = genuine["id"]
        proof = acceptance.signed_dependency(reference, "staging", expected_portal_profile=acceptance.FRONTEND_PROFILE_V2)
        self.assertEqual(proof["record_id"], genuine["id"])
