"""Real disposable signed peer records; no hosted or production claims."""

import copy
import datetime as dt
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import oracle_owner as owner
import oracle_portal_api_recovery as recovery
from test_oracle_owner import OwnerStoreTests


class IndependentReceiptTests(unittest.TestCase):
    open = OwnerStoreTests.open
    settings = OwnerStoreTests.settings
    commission_fixture = OwnerStoreTests.commission_fixture
    context = OwnerStoreTests.context
    qualified = OwnerStoreTests.qualified
    authorization = OwnerStoreTests.authorization

    @classmethod
    def setUpClass(cls):
        OwnerStoreTests.setUpClass.__func__(cls)

    def setUp(self):
        OwnerStoreTests.setUp(self)
        self.store.db.close()
        profile = next(iter(self.policy["components"].values()))
        self.binding["repository"] = "DruHustle/onesa-robot"
        self.enterContext(
            patch.dict(
                owner.POLICIES, {"onesa-robot": owner.POLICIES["onesa-ai-robot"]}
            )
        )
        self.policy["components"] = {"DruHustle/onesa-robot:api": profile}
        self.rows = {}
        for environment, digit in [("staging", "1"), ("production", "2")]:
            name = recovery.PEER_TARGETS[(self.binding["repository"], "api")][
                environment
            ]
            self.rows[name] = {
                "Id": digit * 64,
                "Image": self.binding["artifact_digest"],
                "State": {
                    "Running": True,
                    "Status": "running",
                    "OOMKilled": False,
                    "Health": {"Status": "healthy"},
                    "StartedAt": "2026-10-29T12:00:00Z",
                },
                "RestartCount": 0,
                "Config": {
                    "Env": ["SYNTHETIC_FIXTURE=true"],
                    "Labels": {
                        "org.opencontainers.image.revision": self.binding[
                            "candidate_commit"
                        ],
                        "org.onesa.source-archive-sha256": self.binding[
                            "source_sha256"
                        ],
                    },
                },
            }
        self.runtime = {
            environment: recovery.api.r.summary(self.rows[name])
            for environment, name in recovery.PEER_TARGETS[
                (self.binding["repository"], "api")
            ].items()
        }
        code = self.runner.read_text().replace(
            "print(json.dumps(v))",
            "v['actual_runtime']=s['runtime']['staging' if phase in ['staging','operations'] else 'production'];"
            "v['deployment_id']=v['actual_runtime']['container_id'];v['physical_hardware_authorized']=False;"
            "print(json.dumps(v))",
        )
        self.runner.write_text(code)
        for runner in profile["runners"].values():
            runner["sha256"] = owner.file_digest(self.runner)
        (self.root / "policy.json").write_bytes(owner.canonical(self.policy))
        trust = json.loads((self.root / "trust.json").read_bytes())
        trust["policy_sha256"] = owner.file_digest(self.root / "policy.json")
        (self.root / "trust.json").write_bytes(owner.canonical(trust))
        self.commission_fixture()
        self.settings({"runtime": self.runtime})
        self.store = self.open()
        self.addCleanup(self.store.db.close)

        def peer_store(*_args):
            peer = self.open()
            peer.expected_repository = self.binding["repository"]
            return peer

        self.loader = recovery.peer_store
        self.enterContext(patch.object(recovery, "peer_store", side_effect=peer_store))
        self.enterContext(
            patch.object(
                recovery.api.r,
                "inventory",
                side_effect=lambda: copy.deepcopy(self.rows),
            )
        )
        self.main = SimpleNamespace(
            github=SimpleNamespace(token="synthetic-fixture-only")
        )

    def refs(self, record, environment="staging"):
        return [{"store": str(self.root), "record": record, "environment": environment}]

    def test_genuine_signed_staging_matches_exact_runtime_without_consumption(self):
        q = self.qualified()
        before = self.store.db.execute("SELECT id,kind,revoked FROM records").fetchall()
        actual, provenance = recovery.independent_receipts(self.main, self.refs(q))
        self.assertEqual(list(actual.values()), [self.runtime["staging"]])
        self.assertEqual(provenance[0]["record"], q)
        self.assertEqual(provenance[0]["kind"], "qualification")
        self.assertEqual(
            before,
            self.store.db.execute("SELECT id,kind,revoked FROM records").fetchall(),
        )
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM deployments").fetchone()[0], 0
        )

    def test_source_image_config_container_and_restart_drift_fail_closed(self):
        refs = self.refs(self.qualified())
        name = recovery.PEER_TARGETS[(self.binding["repository"], "api")]["staging"]
        saved = copy.deepcopy(self.rows[name])
        for key, value in [
            ("Id", "3" * 64),
            ("Image", "sha256:" + "3" * 64),
            ("RestartCount", 1),
        ]:
            with self.subTest(key=key):
                self.rows[name][key] = value
                with self.assertRaises(owner.Rejected):
                    recovery.independent_receipts(self.main, refs)
                self.rows[name] = copy.deepcopy(saved)
        for label in [
            "org.opencontainers.image.revision",
            "org.onesa.source-archive-sha256",
        ]:
            self.rows[name]["Config"]["Labels"][label] = "f" * 64
            with self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, refs)
            self.rows[name] = copy.deepcopy(saved)
        self.rows[name]["Config"]["Env"].append("SYNTHETIC_DRIFT=true")
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, refs)

    def test_context_or_actions_metadata_cannot_replace_qualification(self):
        context = self.context()
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(context))
        references = self.refs(context)
        references[0]["workflow_run_id"] = 0
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, references)

    def test_revoked_ancestor_rejected(self):
        q = self.qualified()
        context = self.store.get(q)["record"]["parent"]
        self.store.revoke(context)
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(q))

    def test_duplicate_references_and_wrong_environment_rejected(self):
        q = self.qualified()
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(q) * 2)
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(q, "production"))

    def test_only_accepted_signed_production_can_reconcile_production(self):
        authorization = self.authorization()
        self.store.deploy(authorization)
        pv = self.store.db.execute(
            "SELECT id,parent FROM records WHERE kind='production-verification'"
        ).fetchone()
        actual, provenance = recovery.independent_receipts(
            self.main, self.refs(pv[0], "production")
        )
        self.assertEqual(list(actual.values()), [self.runtime["production"]])
        self.assertEqual(provenance[0]["kind"], "production-verification")
        self.store.db.execute("UPDATE deployments SET state='deployed-unverified'")
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(pv[0], "production"))

    def test_historical_inspection_does_not_renew_an_expired_peer_qualification(self):
        q = self.qualified()
        original = self.store.get(q)["record"]

        def historical_peer(*_args):
            peer = self.open()
            peer.expected_repository = self.binding["repository"]
            peer.clock = lambda: (
                dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
            )
            return peer

        with patch.object(recovery, "peer_store", side_effect=historical_peer):
            actual, _ = recovery.independent_receipts(self.main, self.refs(q))
        self.assertTrue(actual)
        self.assertEqual(self.store.get(q)["record"], original)

    def test_unsigned_modified_peer_record_rejected(self):
        q = self.qualified()
        row = self.store.db.execute(
            "SELECT envelope FROM records WHERE id=?", (q,)
        ).fetchone()
        value = json.loads(row[0])
        value["record"]["binding"]["candidate_commit"] = "f" * 40
        self.store.db.execute(
            "UPDATE records SET envelope=? WHERE id=?", (json.dumps(value), q)
        )
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(q))

    def test_peer_loader_refuses_unregistered_paths_inactive_trust_and_wrong_pin(self):
        with self.assertRaises(owner.Rejected):
            self.loader(self.main, "/tmp/forged/robot-owner-" + "a" * 40)
        trust = json.loads((self.root / "trust.json").read_bytes())
        peer = self.root / ("robot-owner-" + "a" * 40)
        peer.mkdir(mode=0o700)
        (peer / "trust.json").write_bytes(owner.canonical(trust))
        (peer / "trust.json").chmod(0o600)
        registry = self.root / "peer-registry.json"
        registry.write_bytes(owner.canonical({"installations": {}}))
        registry.chmod(0o600)
        private = owner.private
        with (
            patch.object(recovery, "PEER_STORES", self.root),
            patch.object(owner, "ANCHOR", registry),
            patch.object(
                owner,
                "private",
                side_effect=lambda path, directory=False: private(
                    path, directory=directory, uid=os.getuid()
                ),
            ),
        ):
            with self.assertRaisesRegex(owner.Rejected, "PEER_COMMISSION_REQUIRED"):
                self.loader(self.main, peer)
            anchor = {
                key: trust[key]
                for key in [
                    "installation_id",
                    "key_id",
                    "verifier_sha256",
                    "policy_sha256",
                ]
            }
            anchor["active"] = True
            registry.write_bytes(
                owner.canonical({"installations": {str(peer): anchor}})
            )
            install = self.root / "installed"
            core = install / ("robot-" + "a" * 40) / "oracle_owner.py"
            core.parent.mkdir(mode=0o700, parents=True)
            core.write_text("raise AssertionError('untrusted code must never execute')")
            core.chmod(0o600)
            with (
                patch.object(recovery.installer, "INSTALL_PARENT", install),
                self.assertRaisesRegex(
                    owner.Rejected, "INDEPENDENT_PEER_VERIFIER_PIN_REQUIRED"
                ),
            ):
                self.loader(self.main, peer)

    def test_missing_signed_runtime_and_skipped_mandatory_checks_rejected(self):
        q = self.qualified()
        original = self.store.get(q)["record"]
        for change in ["runtime", "staging", "operations"]:
            value = copy.deepcopy(original)
            if change == "runtime":
                del value["details"]["staging"]["observations"]["actual_runtime"]
            else:
                checks = value["details"][change]["observations"]["checks"]
                checks[next(iter(checks))] = "SKIP"
            # The fixture issuer genuinely signs each deliberately incomplete record;
            # a valid signature cannot supply missing mandatory evidence.
            record = self.store.put(
                "qualification",
                self.binding,
                value["details"],
                parent=original["parent"],
            )["record"]["id"]
            with self.subTest(change=change), self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, self.refs(record))

    def test_no_reconciliation_is_permitted_through_a_normal_runner(self):
        for phase in ["staging", "operations", "deploy", "production"]:
            with self.subTest(phase=phase), self.assertRaises(recovery.api.r.Refused):
                recovery.api.runner(
                    phase, self.binding, {}, independent={"anything": {}}
                )


class RetainedScopeTests(unittest.TestCase):
    def test_only_signed_peer_baselines_change_and_original_plan_is_immutable(self):
        api = recovery.api
        plan = {
            "baseline": {
                api.TARGET: {"source": "original-api"},
                "peer-staging": {"source": "old-peer"},
                "unrelated-production": {"source": "unchanged"},
            },
            "runtime": {"profile": "strict"},
            "production_probe": {"runtime_sha256": "fixed-runtime"},
        }
        original = copy.deepcopy(plan)
        rows = {
            api.TARGET: {"source": "running-api"},
            "peer-staging": {"source": "qualified-new-peer"},
            "unrelated-production": {"source": "unchanged"},
        }
        with (
            patch.object(api.r, "inventory", return_value=rows),
            patch.object(api.r, "healthy", return_value=True),
            patch.object(api.r, "summary", side_effect=lambda row: row),
            patch.object(api, "profile", return_value=plan["runtime"]),
            patch.object(api.r, "private", return_value="fixed-private-runtime"),
            patch.object(api.r, "sha", return_value="fixed-runtime"),
        ):
            with self.assertRaises(api.r.Refused):
                api.retained(plan, replacement=True)
            independent = {"peer-staging": rows["peer-staging"]}
            self.assertEqual(
                api.retained(plan, replacement=True, independent=independent), rows
            )
            self.assertEqual(plan, original)
            rows["unrelated-production"] = {"source": "unqualified-change"}
            with self.assertRaises(api.r.Refused):
                api.retained(plan, replacement=True, independent=independent)
            for overrides in [
                {api.TARGET: rows[api.TARGET]},
                {"unknown-component": {}},
            ]:
                with self.assertRaises(api.r.Refused):
                    api.retained(plan, replacement=True, independent=overrides)


if __name__ == "__main__":
    unittest.main()
