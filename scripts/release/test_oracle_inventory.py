"""Disposable inventory races; all Docker calls are mocked and read-only."""

import copy
import json
import unittest
from unittest.mock import patch

import oracle_portal as r


class RuntimeInventoryTests(unittest.TestCase):
    def setUp(self):
        self.clock = 0
        self.rows = {name: self.row(name) for name in r.TARGET.values()}
        self.rows["independent-workload"] = self.row("independent-workload")
        self.helper = self.row("temporary-monitor", auto_remove=True)

    @staticmethod
    def row(name, auto_remove=False):
        return {
            "Name": "/" + name,
            "Id": "id-" + name,
            "Image": "sha256:fixture",
            "State": {"StartedAt": "fixture", "Running": True},
            "RestartCount": 0,
            "Config": {"Env": ["SYNTHETIC=value"], "Labels": {}},
            "HostConfig": {"AutoRemove": auto_remove},
        }

    def sleep(self, seconds):
        self.clock += seconds

    def call(self, docker):
        with (
            patch.object(r, "docker", side_effect=docker),
            patch.object(r.time, "monotonic", side_effect=lambda: self.clock),
            patch.object(r.time, "sleep", side_effect=self.sleep),
        ):
            return r.inventory()

    def docker(self, *args, **kwargs):
        self.assertLessEqual(kwargs["timeout"], 5)
        self.assertIn(args[0], ["ps", "inspect"])
        if args[0] == "ps":
            return "\n".join(self.rows).encode()
        return json.dumps(list(self.rows.values())).encode()

    def test_every_persistent_including_unknown_workload_is_retained(self):
        self.assertEqual(self.call(self.docker), self.rows)

    def test_finished_temporary_monitor_is_never_a_preservation_baseline(self):
        self.rows["temporary-monitor"] = self.helper

        def docker(*args, **kwargs):
            result = self.docker(*args, **kwargs)
            if args[0] == "inspect" and "temporary-monitor" in self.rows:
                del self.rows["temporary-monitor"]
            return result

        observed = self.call(docker)
        self.assertEqual(observed, self.rows)
        r.unchanged(observed, copy.deepcopy(self.rows))
        self.assertGreater(self.clock, 0)

    def test_container_exit_between_list_and_inspect_is_read_only_resampled(self):
        self.rows["temporary-monitor"] = self.helper

        def docker(*args, **kwargs):
            if args[0] == "inspect" and "temporary-monitor" in self.rows:
                del self.rows["temporary-monitor"]
                raise r.Refused("PINNED_COMMAND_FAILED_INSPECT_WITHOUT_RETRY")
            return self.docker(*args, **kwargs)

        self.assertEqual(self.call(docker), self.rows)

    def test_long_lived_auto_remove_workload_blocks_instead_of_being_excluded(self):
        self.rows["temporary-monitor"] = self.helper
        with self.assertRaisesRegex(r.Refused, "RUNTIME_INVENTORY_NOT_QUIESCENT"):
            self.call(self.docker)
        self.assertLessEqual(self.clock, 20.25)

    def test_unchanged_inventory_does_not_hide_docker_failures(self):
        def docker(*args, **kwargs):
            if args[0] == "inspect":
                raise r.Refused("PINNED_COMMAND_FAILED_INSPECT_WITHOUT_RETRY")
            return self.docker(*args, **kwargs)

        with self.assertRaisesRegex(r.Refused, "PINNED_COMMAND_FAILED"):
            self.call(docker)

    def test_missing_required_service_or_lifecycle_metadata_fails_closed(self):
        del self.rows[next(iter(r.TARGET.values()))]
        with self.assertRaisesRegex(r.Refused, "RUNTIME_MISSING"):
            self.call(self.docker)
        self.rows = {name: self.row(name) for name in r.TARGET.values()}
        self.rows[next(iter(self.rows))].pop("HostConfig")
        with self.assertRaisesRegex(r.Refused, "LIFECYCLE_METADATA"):
            self.call(self.docker)

    def test_real_unknown_workload_loss_or_identity_change_still_fails(self):
        observed = self.call(self.docker)
        for field, value in [
            ("Id", "replacement"),
            ("Image", "sha256:changed"),
            ("RestartCount", 1),
            ("State", {"StartedAt": "new"}),
            ("Config", {"Env": ["SYNTHETIC=changed"], "Labels": {}}),
        ]:
            changed = copy.deepcopy(observed)
            changed["independent-workload"][field] = value
            with self.subTest(field=field), self.assertRaises(r.Refused):
                r.unchanged(observed, changed)
        del observed["independent-workload"]
        with self.assertRaises(r.Refused):
            r.unchanged(self.rows, observed)

    def test_partial_inspect_response_is_not_accepted(self):
        def docker(*args, **kwargs):
            if args[0] == "inspect":
                return json.dumps(list(self.rows.values())[:-1]).encode()
            return self.docker(*args, **kwargs)

        with self.assertRaisesRegex(r.Refused, "INVENTORY_INCOMPLETE"):
            self.call(docker)


if __name__ == "__main__":
    unittest.main()
