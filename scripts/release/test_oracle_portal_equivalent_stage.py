"""Real disposable accepted records; source/mode/image I/O uses synthetic data."""

import copy
import hashlib
import io
import json
import os
import tarfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import oracle_owner as owner
import oracle_portal_api_recovery as recovery
import test_oracle_owner as owner_fixture
import test_oracle_portal_independent_receipts as peer_fixture


class EquivalentStageTests(unittest.TestCase):
    open = peer_fixture.IndependentReceiptTests.open
    settings = peer_fixture.IndependentReceiptTests.settings
    commission_fixture = peer_fixture.IndependentReceiptTests.commission_fixture
    context = peer_fixture.IndependentReceiptTests.context
    qualified = peer_fixture.IndependentReceiptTests.qualified
    authorization = peer_fixture.IndependentReceiptTests.authorization
    refs = peer_fixture.IndependentReceiptTests.refs
    setUp = peer_fixture.IndependentReceiptTests.setUp

    @classmethod
    def setUpClass(cls):
        owner_fixture.OwnerStoreTests.setUpClass.__func__(cls)

    def archive(self, commit, *, changed=False, executable=False):
        folder = self.root / "artifacts" / commit
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        files = {
            "onesa-ai-robot-backend/robot_api/main.py": b"synthetic API\n",
            "onesa-ai-robot-backend/robot_api/inspection.py": b"synthetic inspection\n",
            "edge/source.txt": b"changed\n" if changed else b"unchanged\n",
            "ros2/source.txt": b"unchanged\n",
            "docs/source.txt": commit.encode(),
        }
        with tarfile.open(folder / "source.tar", "w") as archive:
            for name, raw in files.items():
                info = tarfile.TarInfo(name)
                info.mode = 0o755 if executable and name.startswith("edge/") else 0o644
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        (folder / "source.tar").chmod(0o600)
        return owner.file_digest(folder / "source.tar")

    def prepare(self):
        pin = self.archive(self.binding["candidate_commit"])
        self.binding["source_sha256"] = pin
        for row in self.rows.values():
            row["Config"]["Labels"]["org.onesa.source-archive-sha256"] = pin
        self.runtime = {
            env: recovery.api.r.summary(self.rows[name])
            for env, name in recovery.PEER_TARGETS[
                (self.binding["repository"], "api")
            ].items()
        }
        self.settings({"runtime": self.runtime})
        self.store.deploy(self.authorization())
        self.record = self.store.db.execute(
            "SELECT id FROM records WHERE kind='production-verification'"
        ).fetchone()[0]
        self.stage_name = recovery.PEER_TARGETS[(self.binding["repository"], "api")][
            "staging"
        ]
        self.production_name = recovery.PEER_TARGETS[
            (self.binding["repository"], "api")
        ]["production"]
        self.stage_commit = "d" * 40
        stage = self.rows[self.stage_name]
        stage["Image"] = "sha256:" + "d" * 64
        stage["Config"]["Labels"]["org.opencontainers.image.revision"] = (
            self.stage_commit
        )
        stage["Config"]["Labels"]["org.onesa.source-archive-sha256"] = self.archive(
            self.stage_commit
        )
        self.configured, self.images = {}, {}
        for env, name in recovery.PEER_TARGETS[
            (self.binding["repository"], "api")
        ].items():
            self.configured[env] = {
                "ROBOT_DEPLOYMENT_ENVIRONMENT": env,
                "ROBOT_ACTUATION_ENABLED": "false",
                "ROBOT_CONTEXT_IMPORT_ENABLED": "false",
                "ROBOT_STORAGE_MODE": "turso",
            }
            row = self.rows[name]
            start = {
                "Entrypoint": None,
                "Cmd": ["python", "start.sh"],
                "WorkingDir": "/app",
                "User": "10001",
            }
            row["HostConfig"] = {"ReadonlyRootfs": True}
            row["Mounts"] = [{"Destination": "/app/data"}]
            row["Config"].update(start)
            row["Config"]["Env"] = [
                "SYNTHETIC_FIXTURE=true",
                *[key + "=" + value for key, value in self.configured[env].items()],
            ]
            self.images[row["Image"]] = {
                "Id": row["Image"],
                "Config": {**start, "Env": ["SYNTHETIC_FIXTURE=true"]},
            }
        # The genuinely signed original PV must bind the complete actual production
        # runtime. Update only this disposable fixture before issuing its PV.
        original = self.store.get(self.record)["record"]
        details = copy.deepcopy(original["details"])
        prod_runtime = recovery.api.r.summary(self.rows[self.production_name])
        details["observations"]["actual_runtime"] = prod_runtime
        replacement = self.store.put(
            "production-verification", self.binding, details, parent=original["parent"]
        )
        self.record = replacement["record"]["id"]

        def source(archive, _binding):
            with tarfile.open(archive) as data:
                return {}, {
                    entry.name: hashlib.sha256(
                        data.extractfile(entry).read()
                    ).hexdigest()
                    for entry in data.getmembers()
                    if entry.isfile()
                }

        self.tools = SimpleNamespace(
            ENV={"staging": "staging", "production": "production"},
            runtime_values=lambda env: self.configured[env],
            docker=lambda *args: json.dumps([self.images[args[-1]]]),
            component_folder=lambda binding: (
                self.root / "artifacts" / binding["candidate_commit"]
            ),
            source_inventory=source,
            read=lambda _path: {"fixture": True},
            image_security=Mock(),
            verify_application_bytes=Mock(),
        )
        self.enterContext(
            patch.object(recovery, "robot_source_tools", return_value=self.tools)
        )
        self.enterContext(
            patch.object(
                self.ci,
                "api",
                create=True,
                return_value={"sha": self.stage_commit, "tree": {"sha": "e" * 40}},
            )
        )
        private = owner.private
        self.enterContext(
            patch.object(
                owner,
                "private",
                side_effect=lambda path, **kw: private(
                    path, **{"uid": os.getuid(), **kw}
                ),
            )
        )

    def test_genuine_accepted_api_recognizes_equivalent_stage_without_any_release_grant(
        self,
    ):
        self.prepare()
        before = self.store.db.execute("SELECT id,kind,revoked FROM records").fetchall()
        result, provenance = recovery.independent_receipts(
            self.main, self.refs(self.record)
        )
        self.assertEqual(
            result[self.stage_name], recovery.api.r.summary(self.rows[self.stage_name])
        )
        proof = provenance[0]["preservation_only"]
        self.assertFalse(proof["staging_qualified"])
        self.assertFalse(proof["staging_release_authorized"])
        self.assertEqual(proof["provider_requests"], 0)
        self.assertNotEqual(
            proof["actual_stage_source"], proof["original_accepted_source"]
        )
        self.assertEqual(
            before,
            self.store.db.execute("SELECT id,kind,revoked FROM records").fetchall(),
        )
        self.assertEqual((self.root / "provider-count").read_text(), "1")
        self.assertEqual(self.tools.verify_application_bytes.call_count, 2)

    def test_revoked_staging_qualification_is_not_relabelled_or_consumed(self):
        self.prepare()
        stage_binding = {
            **self.binding,
            "candidate_commit": self.stage_commit,
            "source_tree": "e" * 40,
            "source_sha256": self.rows[self.stage_name]["Config"]["Labels"][
                "org.onesa.source-archive-sha256"
            ],
            "artifact_digest": self.rows[self.stage_name]["Image"],
        }
        self.ci.source = self.stage_commit
        context = self.store.issue_context(stage_binding)["record"]["id"]
        q = self.store.qualify(context)["record"]["id"]
        self.store.revoke(context)
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(q))
        result, provenance = recovery.independent_receipts(
            self.main, self.refs(self.record)
        )
        self.assertTrue(result)
        self.assertFalse(provenance[0]["preservation_only"]["staging_qualified"])
        self.assertEqual(
            self.store.db.execute(
                "SELECT revoked FROM records WHERE id=?", (context,)
            ).fetchone()[0],
            1,
        )

    def test_changed_stage_backend_content_or_executable_mode_fails_closed(self):
        self.prepare()
        for changed, executable in [(True, False), (False, True)]:
            self.rows[self.stage_name]["Config"]["Labels"][
                "org.onesa.source-archive-sha256"
            ] = self.archive(self.stage_commit, changed=changed, executable=executable)
            with (
                self.subTest(changed=changed, executable=executable),
                self.assertRaises(owner.Rejected),
            ):
                recovery.independent_receipts(self.main, self.refs(self.record))

    def test_original_production_drift_unaccepted_state_and_revocation_are_not_overridden(
        self,
    ):
        self.prepare()
        saved = copy.deepcopy(self.rows[self.production_name])
        self.rows[self.production_name]["RestartCount"] = 1
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(self.record))
        self.rows[self.production_name] = saved
        self.store.db.execute("UPDATE deployments SET state='deployed-unverified'")
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(self.record))
        self.store.db.execute("UPDATE deployments SET state='accepted'")
        self.store.revoke(self.record)
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(self.record))

    def test_mutable_code_mount_start_override_interpreter_injection_and_physical_flags_refused(
        self,
    ):
        self.prepare()
        saved = copy.deepcopy(self.rows[self.stage_name])
        for change in ["mutable", "mount", "start", "python", "physical", "context"]:
            self.rows[self.stage_name] = copy.deepcopy(saved)
            row = self.rows[self.stage_name]
            self.configured["staging"] = {
                "ROBOT_DEPLOYMENT_ENVIRONMENT": "staging",
                "ROBOT_ACTUATION_ENABLED": "false",
                "ROBOT_CONTEXT_IMPORT_ENABLED": "false",
                "ROBOT_STORAGE_MODE": "turso",
            }
            if change == "mutable":
                row["HostConfig"]["ReadonlyRootfs"] = False
            elif change == "mount":
                row["Mounts"] = [{"Destination": "/app/robot_api"}]
            elif change == "start":
                row["Config"]["Cmd"] = ["different.py"]
            else:
                key, value = {
                    "python": ("PYTHONPATH", "/app/data"),
                    "physical": ("ROBOT_ACTUATION_ENABLED", "true"),
                    "context": ("ROBOT_CONTEXT_IMPORT_ENABLED", "true"),
                }[change]
                self.configured["staging"][key] = value
                row["Config"]["Env"] = [
                    "SYNTHETIC_FIXTURE=true",
                    *[k + "=" + v for k, v in self.configured["staging"].items()],
                ]
            with self.subTest(change=change), self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, self.refs(self.record))

    def test_fresh_scan_references_preserve_old_reports_without_becoming_authority(
        self,
    ):
        self.prepare()
        refs = self.refs(self.record)
        checks = {}
        for env in ["staging", "production"]:
            path = self.root / (env + "-current-scan.json")
            path.write_bytes(b'{"fixture":true}')
            path.chmod(0o600)
            checks[env] = {"path": str(path), "sha256": owner.file_digest(path)}
        refs[0]["preservation_image_checks"] = checks
        with patch.object(recovery, "PEER_STORES", self.root):
            result, provenance = recovery.independent_receipts(self.main, refs)
            self.assertTrue(result)
            self.assertFalse(
                provenance[0]["preservation_only"]["staging_release_authorized"]
            )
            checks["staging"]["sha256"] = "0" * 64
            with self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, refs)
            checks["staging"] = {"path": "/tmp/caller-scan.json", "sha256": "0" * 64}
            with self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, refs)
            checks["staging"] = {"PASS": True}
            with self.assertRaises(owner.Rejected):
                recovery.independent_receipts(self.main, refs)

    def test_failed_scan_modified_archive_or_unrelated_git_source_never_becomes_a_baseline(
        self,
    ):
        self.prepare()
        self.tools.image_security.side_effect = owner.Rejected("FAILED_CURRENT_SCAN")
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(self.record))
        self.tools.image_security.side_effect = None
        with (
            patch.object(
                self.ci,
                "api",
                return_value={"sha": "0" * 40, "tree": {"sha": "e" * 40}},
            ),
            self.assertRaises(owner.Rejected),
        ):
            recovery.independent_receipts(self.main, self.refs(self.record))
        path = self.root / "artifacts" / self.stage_commit / "source.tar"
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaises(owner.Rejected):
            recovery.independent_receipts(self.main, self.refs(self.record))


class InspectorPinTests(unittest.TestCase):
    def test_unregistered_or_changed_inspector_is_refused_before_execution(self):
        import tempfile

        with tempfile.TemporaryDirectory(
            dir=Path.home() if os.getuid() == 0 else None
        ) as directory:
            root = Path(directory).resolve()
            root.chmod(0o700)
            install = root / "installed"
            path = install / ("robot-" + "a" * 40) / "runners" / "oracle_robot.py"
            path.parent.mkdir(mode=0o700, parents=True)
            path.write_text(
                "raise AssertionError('unreviewed code must never execute')"
            )
            path.chmod(0o600)
            peer = SimpleNamespace(
                root=root / ("robot-owner-" + "a" * 40),
                trust={"runner_root": str(path.parent)},
            )
            profile = {
                "runners": {"production": {"path": str(path), "sha256": "0" * 64}}
            }
            private = owner.private
            with (
                patch.object(recovery.installer, "INSTALL_PARENT", install),
                patch.object(
                    owner,
                    "private",
                    side_effect=lambda p, **kw: private(
                        p, **{"uid": os.getuid(), **kw}
                    ),
                ),
            ):
                with self.assertRaisesRegex(
                    owner.Rejected, "PINNED_ROBOT_SOURCE_INSPECTOR_CHANGED"
                ):
                    recovery.robot_source_tools(peer, profile)
                profile["runners"]["production"]["path"] = str(root / "caller.py")
                with self.assertRaisesRegex(
                    owner.Rejected, "ORIGINAL_EXTERNAL_ROBOT_RUNNER_REQUIRED"
                ):
                    recovery.robot_source_tools(peer, profile)

    def test_original_pinned_source_tool_loads_without_changing_import_search_paths(
        self,
    ):
        import sys
        import tempfile

        with tempfile.TemporaryDirectory(
            dir=Path.home() if os.getuid() == 0 else None
        ) as directory:
            root = Path(directory).resolve()
            root.chmod(0o700)
            install = root / "installed"
            path = install / ("robot-" + "a" * 40) / "runners" / "oracle_robot.py"
            path.parent.mkdir(mode=0o700, parents=True)
            path.write_text("SAFE_SYNTHETIC_INSPECTOR=True\n")
            path.chmod(0o600)
            peer = SimpleNamespace(
                root=root / ("robot-owner-" + "a" * 40),
                trust={"runner_root": str(path.parent)},
            )
            profile = {
                "runners": {
                    "production": {"path": str(path), "sha256": owner.file_digest(path)}
                }
            }
            private = owner.private
            before = list(sys.path)
            with (
                patch.object(recovery.installer, "INSTALL_PARENT", install),
                patch.object(
                    owner,
                    "private",
                    side_effect=lambda p, **kw: private(
                        p, **{"uid": os.getuid(), **kw}
                    ),
                ),
            ):
                module = recovery.robot_source_tools(peer, profile)
            self.assertTrue(module.SAFE_SYNTHETIC_INSPECTOR)
            self.assertEqual(sys.path, before)


if __name__ == "__main__":
    unittest.main()
