"""Seven-client integration, using native release evidence and public source identities."""
import copy
import json
import unittest
from unittest.mock import patch

import oracle_portal_identity_acceptance as acceptance


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
