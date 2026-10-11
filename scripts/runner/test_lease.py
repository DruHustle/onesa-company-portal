"""Linux lease tests exercise exclusion, stale recovery and owner-only release."""

import multiprocessing
import os
import tempfile
import time
import unittest
from pathlib import Path

from lease import acquire, identity, release


def contender(state, queue):
    started = time.monotonic()
    owner = identity(os.getpid())
    acquire(owner, Path(state), timeout=5)
    queue.put(time.monotonic() - started)
    release(owner, Path(state))


class LeaseTests(unittest.TestCase):
    def test_exclusion_and_owner_release(self):
        with tempfile.TemporaryDirectory() as directory:
            state, owner = Path(directory), identity(os.getpid())
            acquire(owner, state)
            release([owner[0], "wrong-start-time"], state)
            self.assertTrue((state / "lease.json").exists())
            queue = multiprocessing.Queue()
            child = multiprocessing.Process(target=contender, args=(directory, queue))
            child.start()
            time.sleep(1.2)
            self.assertTrue(queue.empty())
            release(owner, state)
            self.assertGreater(queue.get(timeout=5), 1)
            child.join(5)
            self.assertEqual(child.exitcode, 0)

    def test_dead_worker_and_reused_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            state, owner = Path(directory), identity(os.getpid())
            acquire([99999999, "0"], state)
            acquire(owner, state, timeout=0)
            release(owner, state)
            acquire([owner[0], "wrong-start-time"], state)
            acquire(owner, state, timeout=0)
            release(owner, state)

    def test_live_owner_times_out(self):
        with tempfile.TemporaryDirectory() as directory:
            state, owner = Path(directory), identity(os.getpid())
            acquire(owner, state)
            with self.assertRaises(TimeoutError):
                acquire([99999999, "0"], state, timeout=0)
