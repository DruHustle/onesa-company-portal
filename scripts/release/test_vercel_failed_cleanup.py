import copy
import unittest

import vercel_failed_cleanup as cleanup


NOW = 30 * cleanup.HOUR
CONFIG = {"teamId": "team_test", "projectIds": ["prj_test"]}


class Provider:
    def __init__(self):
        self.deployments = {"dpl_old": {"id": "dpl_old", "projectId": "prj_test",
                            "readyState": "ERROR", "ready": cleanup.HOUR,
                            "createdAt": 0}}
        self.aliases = []
        self.deleted = []
        self.reads = 0
        self.race = None
        self.owner = "team_test"

    def __call__(self, path, method="GET", **query):
        if path.startswith("/v9/projects/"):
            return {"id": "prj_test", "accountId": self.owner}
        if path == "/v6/deployments":
            return {"deployments": [{"uid": key} for key in self.deployments]}
        if path == "/v4/aliases":
            return {"aliases": self.aliases}
        identifier = path.rsplit("/", 1)[1]
        if method == "DELETE":
            self.deleted.append(identifier)
            del self.deployments[identifier]
            return {"uid": identifier, "state": "DELETED"}
        self.reads += 1
        if self.reads == 2 and self.race:
            self.race(self)
        return copy.deepcopy(self.deployments[identifier])


class CleanupTests(unittest.TestCase):
    def test_preview_is_read_only(self):
        provider = Provider()
        result = cleanup.cleanup(provider, CONFIG, NOW)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["overdueCount"], 1)
        self.assertEqual(provider.deleted, [])

    def test_apply_reads_back_removal_and_is_idempotent(self):
        provider = Provider()
        emitted = []
        result = cleanup.cleanup(provider, CONFIG, NOW, True, emitted.append)
        self.assertEqual(result["deleted"], ["dpl_old"])
        self.assertEqual(emitted[0]["preview"][0]["id"], "dpl_old")
        self.assertEqual(result["overdueCount"], 0)
        again = cleanup.cleanup(provider, CONFIG, NOW, True)
        self.assertEqual(again["deleted"], [])

    def test_status_race_preserves_deployment(self):
        provider = Provider()
        provider.race = lambda api: api.deployments["dpl_old"].update(readyState="READY")
        result = cleanup.cleanup(provider, CONFIG, NOW, True)
        self.assertEqual(provider.deleted, [])
        self.assertEqual(result["protected"][-1]["reason"], "not_error")

    def test_concurrent_removal_is_confirmed_without_claiming_delete_success(self):
        provider = Provider()
        def disappearing(path, method="GET", **query):
            if method == "DELETE":
                del provider.deployments[path.rsplit("/", 1)[1]]
                raise cleanup.Refused("provider CLI request failed")
            return provider(path, method, **query)
        result = cleanup.cleanup(disappearing, CONFIG, NOW, True)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["alreadyAbsent"], ["dpl_old"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["overdueCount"], 0)

    def test_provider_reports_already_absent_without_claiming_deletion(self):
        provider = Provider()

        def missing(path, method="GET", **query):
            if method == "DELETE":
                del provider.deployments["dpl_old"]
                return {"alreadyAbsent": True}
            return provider(path, method, **query)

        result = cleanup.cleanup(missing, CONFIG, NOW, True)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["alreadyAbsent"], ["dpl_old"])

    def test_changed_state_is_never_evidence_of_deletion(self):
        for uncertain_response in (False, True):
            with self.subTest(uncertain_response=uncertain_response):
                provider = Provider()

                def state_changed(path, method="GET", **query):
                    if method == "DELETE":
                        provider.deployments["dpl_old"]["readyState"] = "READY"
                        if uncertain_response:
                            raise cleanup.Refused("provider response was lost")
                        return {"state": "DELETED"}
                    if path == "/v6/deployments" and query.get("state") == "ERROR":
                        return {"deployments": [{"uid": key} for key, item in
                                provider.deployments.items() if item["readyState"] == "ERROR"]}
                    return provider(path, method, **query)

                result = cleanup.cleanup(state_changed, CONFIG, NOW, True)
                self.assertEqual(result["deleted"], [])
                self.assertEqual(result["alreadyAbsent"], [])
                self.assertFalse(result["successful"])
                self.assertEqual(result["errors"], [
                    {"id": "dpl_old", "reason": "delete_or_readback_failed"}])

    def test_failed_delete_still_present_is_not_a_success(self):
        provider = Provider()
        def failing(path, method="GET", **query):
            if method == "DELETE":
                raise cleanup.Refused("provider CLI request failed")
            return provider(path, method, **query)
        result = cleanup.cleanup(failing, CONFIG, NOW, True)
        self.assertEqual(result["alreadyAbsent"], [])
        self.assertEqual(result["deleted"], [])
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["overdueCount"], 1)

    def test_alias_race_preserves_deployment(self):
        provider = Provider()
        provider.race = lambda api: api.aliases.append({"alias": "app.example", "deploymentId": "dpl_old"})
        result = cleanup.cleanup(provider, CONFIG, NOW, True)
        self.assertEqual(provider.deleted, [])
        self.assertEqual(result["protected"][-1]["reason"], "assigned_alias")

    def test_historical_alias_does_not_claim_current_assignment(self):
        provider = Provider()
        provider.deployments["dpl_old"]["alias"] = ["historical.example"]
        provider.aliases = [{"alias": "historical.example", "deploymentId": "dpl_ready"}]
        self.assertEqual(cleanup.cleanup(provider, CONFIG, NOW, True)["deleted"], ["dpl_old"])

    def test_protected_states_time_and_rollback(self):
        for change, reason in [({"readyState": "CANCELED"}, "not_error"),
                               ({"readyState": "BUILDING"}, "not_error"),
                               ({"ready": None}, "unverified_failure_time"),
                               ({"ready": NOW - cleanup.HOUR}, "retry_grace"),
                               ({"isRollbackCandidate": True}, "rollback_candidate")]:
            with self.subTest(change=change):
                provider = Provider()
                provider.deployments["dpl_old"].update(change)
                result = cleanup.cleanup(provider, CONFIG, NOW, True)
                self.assertEqual(provider.deleted, [])
                self.assertEqual(result["protected"][0]["reason"], reason)

    def test_scope_mismatch_refuses_all_mutation(self):
        provider = Provider()
        provider.owner = "team_foreign"
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup(provider, CONFIG, NOW, True)
        self.assertEqual(provider.deleted, [])

    def test_pagination_deduplicates_boundary(self):
        def api(path, **query):
            return ({"deployments": [{"uid": "dpl_a"}, {"uid": "dpl_b"}], "pagination": {"next": 10}}
                    if "until" not in query else {"deployments": [{"uid": "dpl_b"}, {"uid": "dpl_c"}]})
        self.assertEqual([x["uid"] for x in cleanup.pages(api, "/v6/deployments", "deployments")],
                         ["dpl_a", "dpl_b", "dpl_c"])

    def test_nonprogressing_pagination_fails_closed(self):
        def api(path, **query):
            return {"deployments": [{"uid": "dpl_a"}], "pagination": {"next": 10}}
        with self.assertRaises(cleanup.Refused):
            list(cleanup.pages(api, "/v6/deployments", "deployments"))


if __name__ == "__main__":
    unittest.main()
