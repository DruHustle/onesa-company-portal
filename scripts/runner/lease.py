#!/usr/bin/env python3
"""Serialize all trusted repository jobs before service containers start.

The lease belongs to Runner.Worker, not the short-lived hook process. PID plus
Linux start time prevents PID reuse; a dead worker's lease can be reclaimed.
"""

import contextlib
import fcntl
import json
import os
import sys
import time
from pathlib import Path

STATE = Path("/var/lib/onesa-ci")


def identity(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2 :].split()
        return [pid, fields[19]] if fields[0] != "Z" else None
    except FileNotFoundError:
        return None


def worker():
    pid = os.getppid()
    while pid > 1:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[0]
        if Path(os.fsdecode(command)).name == "Runner.Worker":
            return identity(pid)
        raw = Path(f"/proc/{pid}/stat").read_text()
        pid = int(raw[raw.rfind(")") + 2 :].split()[1])
    raise RuntimeError("Hook must be a descendant of Runner.Worker")


@contextlib.contextmanager
def guard(state):
    os.umask(0o007)
    with (state / "lock").open("a") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def acquire(owner, state=STATE, timeout=5400):
    deadline = time.monotonic() + timeout
    announced = False
    while True:
        with guard(state):
            path = state / "lease.json"
            lease = json.loads(path.read_text()) if path.exists() else None
            if lease is None or identity(lease["worker"][0]) != lease["worker"]:
                record = {
                    "worker": owner,
                    "repository": os.environ.get("GITHUB_REPOSITORY", "maintenance"),
                }
                # Atomic replace under flock; corrupt state fails closed.
                temporary = state / f"lease-{os.getpid()}.tmp"
                temporary.write_text(json.dumps(record))
                temporary.replace(path)
                print("Acquired shared VM execution lease", flush=True)
                return
            if lease["worker"] == owner:
                return
        if not announced:
            print(
                "Waiting for the shared VM execution lease (maximum 90 minutes)",
                flush=True,
            )
            announced = True
        if time.monotonic() >= deadline:
            raise TimeoutError(
                "Shared VM busy; no build or service container was started"
            )
        time.sleep(1)


def release(owner, state=STATE):
    with guard(state):
        path = state / "lease.json"
        if path.exists() and json.loads(path.read_text())["worker"] == owner:
            path.unlink()


if __name__ == "__main__":
    {"acquire": acquire, "release": release}[sys.argv[1]](worker())
