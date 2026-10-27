"""Exercise real helper failure paths with disposable state and no database I/O."""

import contextlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "infra/oracle/operations"))
import backup
import database_snapshots


class BackupCleanup(unittest.TestCase):
    def exercise(self, product, fault):
        module = backup if product == "portal" else database_snapshots
        commands = []
        uri = urlsplit("postgresql://synthetic:fixture@invalid.example/neondb")
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if path == Path("/etc/onesa/operations.json"):
                return json.dumps({"image": "onesa-portal-worker:" + "a" * 40})
            return original_read(path, *args, **kwargs)

        def command(argv, **_kwargs):
            commands.append(argv)
            if argv[1] == "run" and fault == "container_start":
                return subprocess.CompletedProcess(argv, 1, b"", b"")
            if argv[1] == "rm" and fault == "remove_timeout":
                raise subprocess.TimeoutExpired(argv, 20)
            return subprocess.CompletedProcess(argv, 0, b"synthetic-container", b"")

        pipe = Mock()
        pipe.stdin.write.side_effect = OSError("synthetic pipe interruption")
        pipe.poll.return_value = None
        pipe.wait.side_effect = subprocess.TimeoutExpired("synthetic pipe", 20)
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            state = Path(directory)
            stack.enter_context(patch.object(module, "STATE", state))
            stack.enter_context(patch.object(backup.os, "geteuid", return_value=0))
            stack.enter_context(patch.object(backup, "checked_env", return_value=({}, uri)))
            stack.enter_context(patch.object(Path, "read_text", read))
            stack.enter_context(patch.object(subprocess, "run", side_effect=command))
            process = stack.enter_context(patch.object(subprocess, "Popen"))
            if fault == "pipe_wait":
                process.return_value = pipe
            else:
                process.side_effect = OSError("synthetic psql launch interruption")
            with self.assertRaises((ValueError, OSError, subprocess.SubprocessError)):
                if product == "portal":
                    backup.backup()
                else:
                    database_snapshots.pg_snapshot(uri)
            self.assertEqual(list(state.glob("*.conf")), [], "credential file survived")
            starts = [c for c in commands if c[1] == "run"]
            removals = [c for c in commands if c[1] == "rm"]
            self.assertEqual(len(starts), 1)
            self.assertEqual(len(removals), 1, "pipe failure skipped container cleanup")
            client = starts[0][starts[0].index("--name") + 1]
            self.assertEqual(removals[0][-1], client)
            self.assertIn("--volumes", removals[0])
            self.assertIn("--rm", starts[0], "bounded helper must clean up on natural exit")
            self.assertNotIn("--volumes-from", starts[0])
            self.assertTrue(starts[0][starts[0].index("-v") + 1].endswith(":ro"))
            if fault == "container_start":
                process.assert_not_called()
            if fault == "pipe_wait":
                pipe.kill.assert_called_once()

    def test_failed_start_removes_private_configuration(self):
        for product in ("portal", "ai"):
            with self.subTest(product=product):
                self.exercise(product, "container_start")

    def test_psql_launch_failure_cleans_up_owned_helper(self):
        for product in ("portal", "ai"):
            with self.subTest(product=product):
                self.exercise(product, "psql_start")

    def test_docker_timeout_still_removes_private_configuration(self):
        for product in ("portal", "ai"):
            with self.subTest(product=product):
                self.exercise(product, "remove_timeout")

    def test_pipe_wait_timeout_still_attempts_container_cleanup(self):
        for product in ("portal", "ai"):
            with self.subTest(product=product):
                self.exercise(product, "pipe_wait")


if __name__ == "__main__":
    unittest.main()
