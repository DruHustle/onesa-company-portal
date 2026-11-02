"""Owner-enrolled, bounded process recovery on the existing Linux Docker host.

No container is created, started, updated or replaced here. A pinned live init
process receives TERM, then (only after its full grace) KILL. Docker's existing
unless-stopped policy owns exit recovery, including intentional-stop semantics.
Dependency health, public ingress and Docker's unhealthy bit are not actuators.
"""

import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts/release"))
import runtime_lifecycle as lifecycle

CONFIG = Path("/etc/onesa/runtime-recovery.json")
STATE = Path("/var/lib/onesa/runtime-recovery")
MAX_ATTEMPTS = 3
BUDGET_SECONDS = 24 * 60 * 60
FAILURE_SAMPLES = 3
FAILURE_SECONDS = 120
MAX_SAMPLE_GAP = 120
STARTUP_SECONDS = 180
BACKOFF_SECONDS = (300, 900)
HEX = r"[0-9a-f]{64}"
RESULTS = {
    "initialized", "healthy", "failed", "unknown", "stopped-or-transitioning",
    "startup-grace", "backoff", "cycle-budget", "signal-intent-recorded",
    "graceful-exit-observed", "forced-exit-observed", "incarnation-ended",
    "exit-unconfirmed", "restart-budget-exhausted", "ambiguous-action-owner-review",
    "observation-refused",
}


@dataclass(frozen=True)
class Target:
    name: str
    role: str
    project: str
    service: str
    environment: str
    grace_seconds: int


TARGETS = {
    **{
        f"portal-api-{environment}": Target(
            f"onesa-portal-oracle-api-{environment}-1", "api",
            "onesa-portal-oracle-api", environment, environment, 150,
        )
        for environment in ("production", "staging")
    },
    **{
        f"portal-worker-{environment}": Target(
            f"onesa-portal-oracle-{environment}-worker-1", "worker",
            f"onesa-portal-oracle-{environment}", "worker", environment, 180,
        )
        for environment in ("production", "staging")
    },
}


class Refused(ValueError):
    """Fixed error codes only; never include Docker output or environment values."""


def require(condition, code):
    if not condition:
        raise Refused(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def private_read(path):
    return lifecycle.read_private_json(path, limit=65536)


def directory(path):
    lifecycle.private_path(path, directory=True)


def write(path, value):
    """Durable intent precedes any signal; atomic replacement cannot replay it."""
    require(len(canonical(value)) + 1 <= 65536, "STATE_SIZE")
    lifecycle.write_private_json(path, value)


@contextmanager
def lock(path):
    directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and info.st_nlink == 1 and info.st_mode & 0o077 == 0, "LOCK_CUSTODY")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def validate_config(value):
    require(isinstance(value, dict) and set(value) == {
        "schema_version", "enabled", "targets"}, "CONFIG_SCHEMA")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1
            and type(value["enabled"]) is bool, "CONFIG_VERSION")
    targets = value["targets"]
    require(isinstance(targets, dict) and 1 <= len(targets) <= len(TARGETS)
            and set(targets) <= set(TARGETS), "TARGET_ALLOWLIST")
    ids = set()
    for binding in targets.values():
        require(isinstance(binding, dict) and set(binding) == {
            "container_id", "image_id", "source_commit", "configuration_sha256"},
            "BINDING_SCHEMA")
        for field, pattern in (
            ("container_id", HEX), ("image_id", "sha256:" + HEX),
            ("source_commit", r"[0-9a-f]{40}"), ("configuration_sha256", HEX),
        ):
            require(isinstance(binding[field], str)
                    and re.fullmatch(pattern, binding[field]), "BINDING_IDENTITY")
        require(binding["container_id"] not in ids, "DUPLICATE_TARGET")
        ids.add(binding["container_id"])
    return value


def fingerprint(row):
    # Hash private configuration in memory; neither it nor credentials enter records.
    # Endpoint/IP identity changes during a same-container restart are not config.
    return digest({
        "Config": row["Config"], "HostConfig": row["HostConfig"],
        "Mounts": row["Mounts"],
        "Networks": {name: value["NetworkID"] for name, value
                     in row["NetworkSettings"]["Networks"].items()},
    })


def validate_target(target, binding, row):
    config, host = row["Config"], row["HostConfig"]
    labels = config.get("Labels") or {}
    require(row["Id"] == binding["container_id"] and row["Image"] == binding["image_id"]
            and row["Name"] == "/" + target.name
            and fingerprint(row) == binding["configuration_sha256"], "RUNTIME_IDENTITY_CHANGED")
    require(labels.get("org.onesa.source-commit") == binding["source_commit"]
            and labels.get("com.docker.compose.project") == target.project
            and labels.get("com.docker.compose.service") == target.service, "RUNTIME_LABELS_CHANGED")
    require(config.get("User") == "node" and config.get("Entrypoint") == ["docker-entrypoint.sh"]
            and config.get("Cmd") == ["node", "dist/src/" + (
                "server.js" if target.role == "api" else "jobs/worker.js")]
            and config.get("StopTimeout") == target.grace_seconds, "PROCESS_PROFILE_CHANGED")
    require(host.get("RestartPolicy", {}).get("Name") == "unless-stopped"
            and host.get("Init") is True and host.get("ReadonlyRootfs") is True
            and host.get("Privileged") is False and not host.get("CapAdd")
            and host.get("CapDrop") == ["ALL"]
            and "no-new-privileges:true" in (host.get("SecurityOpt") or [])
            and not host.get("PidMode") and host.get("NetworkMode") != "host",
            "UNSAFE_RUNTIME_PROFILE")
    require(all(item.get("HostIp") == "127.0.0.1"
                for items in (host.get("PortBindings") or {}).values()
                for item in (items or [])), "PUBLIC_PORT_BINDING")


def incarnation(row):
    return (row["State"]["Pid"], row["State"]["StartedAt"])


def running(row):
    state = row["State"]
    return (state.get("Running") is True and state.get("Status") == "running"
            and state.get("Paused") is False and state.get("Restarting") is False
            and state.get("Dead") is False and type(state.get("Pid")) is int
            and state["Pid"] > 1)


class Runtime:
    def command(self, arguments, timeout=6):
        # Ignore ambient Docker contexts, API hosts, credentials and CLI plugins.
        return subprocess.run(
            ["/usr/bin/docker", "--host=unix:///var/run/docker.sock",
             "--config=/var/empty/onesa-runtime-recovery", *arguments],
            env={"PATH": "/usr/bin:/bin", "LANG": "C"},
            capture_output=True, timeout=timeout, check=False,
        )

    def inspect(self, container_id):
        require(isinstance(container_id, str) and re.fullmatch(HEX, container_id), "FULL_CONTAINER_ID_REQUIRED")
        result = self.command(["inspect", "--type=container", container_id])
        require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, "DOCKER_INSPECTION_FAILED")
        rows = json.loads(result.stdout, object_pairs_hook=unique)
        require(isinstance(rows, list) and len(rows) == 1 and rows[0]["Id"] == container_id,
                "DOCKER_INSPECTION_IDENTITY")
        return rows[0]

    def probe(self, target, binding):
        if target.role == "api":
            program = (
                "try{const r=await fetch('http://127.0.0.1:8300/api/v1/health',"
                "{redirect:'error',signal:AbortSignal.timeout(3000)});"
                "const t=await r.text();console.log(r.status===200&&t.length<=512&&"
                "JSON.parse(t).status==='ok'?'healthy':'failed')}"
                "catch{console.log('failed')}"
            )
            command = ["node", "--input-type=module", "-e", program]
        else:
            command = ["node", "dist/src/jobs/liveness-check.js"]
        try:
            result = self.command(["exec", binding["container_id"], *command])
            if len(result.stdout) > 1024:
                return "unknown"
            if target.role == "api" and result.returncode == 0:
                value = result.stdout.decode().strip()
                return value if value in {"healthy", "failed"} else "unknown"
            if target.role == "worker" and result.returncode in {0, 1}:
                value = json.loads(result.stdout, object_pairs_hook=unique)
                if (isinstance(value, dict) and set(value) == {"event", "alive"}
                        and value["event"] == "worker_liveness" and type(value["alive"]) is bool
                        and result.returncode == (0 if value["alive"] else 1)):
                    return "healthy" if value["alive"] else "failed"
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            pass
        return "unknown"

    @staticmethod
    def process_identity(pid, container_id):
        # Bind a Linux PID to this container's full cgroup ID, never a PID alone.
        cgroups = Path(f"/proc/{pid}/cgroup").read_text()
        suffixes = {container_id, "docker-" + container_id + ".scope"}
        require(any(part in suffixes for line in cgroups.splitlines()
                    for part in line.split(":", 2)[-1].split("/")), "PROCESS_CGROUP_MISMATCH")
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19]

    def recover(self, target, binding, original, before_signal=lambda: None):
        validate_target(target, binding, original)
        require(running(original), "PROCESS_NOT_RUNNING")
        pid, _started = incarnation(original)
        first_identity = self.process_identity(pid, binding["container_id"])
        handle = os.pidfd_open(pid)
        try:
            poll = select.poll()
            poll.register(handle, select.POLLIN)

            def current():
                if poll.poll(0):
                    return False
                row = self.inspect(binding["container_id"])
                validate_target(target, binding, row)
                return (running(row) and incarnation(row) == incarnation(original)
                        and self.process_identity(pid, binding["container_id"]) == first_identity)

            require(current(), "PROCESS_INCARNATION_CHANGED")
            before_signal()
            require(current(), "PROCESS_INCARNATION_CHANGED")
            signal.pidfd_send_signal(handle, signal.SIGTERM)
            deadline = time.monotonic() + target.grace_seconds
            while time.monotonic() < deadline:
                if poll.poll(min(1000, max(1, int((deadline - time.monotonic()) * 1000)))):
                    return "graceful-exit-observed"
            # The pinned descriptor cannot signal a replacement or reused PID.
            # No SIGCONT, Docker restart or start can undo an operator's stop.
            if current():
                before_signal()
                if current():
                    signal.pidfd_send_signal(handle, signal.SIGKILL)
                    return "forced-exit-observed" if poll.poll(5000) else "exit-unconfirmed"
            return "incarnation-ended"
        finally:
            os.close(handle)


def initial_state(config, now):
    return {
        "schema_version": 1, "enrollment_sha256": digest(config["targets"]),
        "last_checked_at": now,
        "targets": {name: {"attempts": [], "pending": None, "latched": False,
                            "failures": 0, "first_failure_at": None,
                            "last_sample_at": None, "incarnation": None,
                            "result": "initialized"} for name in config["targets"]},
    }


def validate_state(config, state, now):
    require(isinstance(state, dict) and set(state) == {
        "schema_version", "enrollment_sha256", "last_checked_at", "targets"}
        and type(state["schema_version"]) is int and state["schema_version"] == 1
        and state["enrollment_sha256"] == digest(config["targets"])
        and isinstance(state["targets"], dict)
        and set(state["targets"]) == set(config["targets"]), "ENROLLMENT_STATE_CHANGED")
    require(type(now) in (int, float) and math.isfinite(now)
            and type(state["last_checked_at"]) in (int, float)
            and 0 <= state["last_checked_at"] <= now, "CLOCK_REGRESSION")
    for row in state["targets"].values():
        require(isinstance(row, dict) and set(row) == {"attempts", "pending", "latched", "failures", "first_failure_at",
                            "last_sample_at", "incarnation", "result"}
                and isinstance(row["attempts"], list) and len(row["attempts"]) <= MAX_ATTEMPTS
                and all(type(t) in (int, float) and math.isfinite(t) and 0 <= t <= now
                        for t in row["attempts"])
                and row["attempts"] == sorted(row["attempts"])
                and type(row["latched"]) is bool and type(row["failures"]) is int
                and 0 <= row["failures"] <= FAILURE_SAMPLES
                and isinstance(row["result"], str) and row["result"] in RESULTS,
                "RECOVERY_STATE_INVALID")
        def valid_incarnation(value):
            return (isinstance(value, list) and len(value) == 2
                    and type(value[0]) is int and value[0] >= 0
                    and isinstance(value[1], str) and 1 <= len(value[1]) <= 64)
        require(row["incarnation"] is None or valid_incarnation(row["incarnation"]),
                "RECOVERY_INCARNATION_INVALID")
        for field in ("first_failure_at", "last_sample_at"):
            require(row[field] is None or type(row[field]) in (int, float)
                    and math.isfinite(row[field]) and 0 <= row[field] <= now,
                    "RECOVERY_TIME_INVALID")
        require(row["pending"] is None or isinstance(row["pending"], dict)
                and set(row["pending"]) == {"at", "incarnation"}
                and type(row["pending"]["at"]) in (int, float)
                and row["pending"]["at"] in row["attempts"]
                and valid_incarnation(row["pending"]["incarnation"]), "RECOVERY_INTENT_INVALID")


class Controller:
    def __init__(self, runtime, save):
        self.runtime, self.save = runtime, save

    def tick(self, config, state, now, guard=lambda: None):
        """At most one attempted recovery per cycle; unknown observations never count."""
        validate_state(config, state, now)
        state = copy.deepcopy(state)
        state["last_checked_at"] = now
        acted = False
        for name, binding in config["targets"].items():
            target, item = TARGETS[name], state["targets"][name]
            if item["pending"] is not None:
                item.update(latched=True, result="ambiguous-action-owner-review")
                continue
            if item["latched"]:
                continue
            item["attempts"] = [t for t in item["attempts"] if now - t < BUDGET_SECONDS]
            try:
                row = self.runtime.inspect(binding["container_id"])
                validate_target(target, binding, row)
                if not running(row):
                    status = "stopped-or-transitioning"
                else:
                    started = dt.datetime.fromisoformat(row["State"]["StartedAt"].replace("Z", "+00:00")).timestamp()
                    require(0 <= now - started, "START_TIME_INVALID")
                    status = "startup-grace" if now - started < STARTUP_SECONDS else self.runtime.probe(target, binding)
                identity = list(incarnation(row))
                if item["incarnation"] != identity:
                    item.update(incarnation=identity, failures=0, first_failure_at=None, last_sample_at=None)
                previous = item["last_sample_at"]
                item["last_sample_at"] = now
                item["result"] = status
                if status != "failed":
                    item.update(failures=0, first_failure_at=None)
                    continue
                if previous is None or not 0 < now - previous <= MAX_SAMPLE_GAP:
                    item.update(failures=0, first_failure_at=now)
                if item["first_failure_at"] is None:
                    item["first_failure_at"] = now
                item["failures"] = min(FAILURE_SAMPLES, item["failures"] + 1)
                if item["failures"] < FAILURE_SAMPLES or now - item["first_failure_at"] < FAILURE_SECONDS:
                    continue
                count = len(item["attempts"])
                if count >= MAX_ATTEMPTS:
                    item.update(latched=True, result="restart-budget-exhausted")
                    continue
                if count and now - item["attempts"][-1] < BACKOFF_SECONDS[count - 1]:
                    item["result"] = "backoff"
                    continue
                if acted:
                    item["result"] = "cycle-budget"
                    continue
                guard()
                fresh = self.runtime.inspect(binding["container_id"])
                validate_target(target, binding, fresh)
                require(running(fresh) and incarnation(fresh) == incarnation(row), "PRE_ACTION_STATE_CHANGED")
                require(self.runtime.probe(target, binding) == "failed", "PRE_ACTION_HEALTH_CHANGED")
                item["attempts"].append(now)
                item["pending"] = {"at": now, "incarnation": identity}
                item["result"] = "signal-intent-recorded"
                self.save(state)  # fsync failure means no signal; crash means no replay.
                acted = True
                try:
                    item["result"] = self.runtime.recover(target, binding, fresh, before_signal=guard)
                    if item["result"] == "exit-unconfirmed":
                        item.update(latched=True, result="ambiguous-action-owner-review")
                    else:
                        item["pending"] = None
                    item.update(failures=0, first_failure_at=None, last_sample_at=None)
                except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
                    item.update(latched=True, result="ambiguous-action-owner-review")
                self.save(state)
            except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
                # Refusal/unknown acquisition is evidence, never a failed liveness sample.
                item.update(failures=0, first_failure_at=None, result="observation-refused")
        self.save(state)
        return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "initialize"], nargs="?", default="run")
    args = parser.parse_args()
    require(os.geteuid() == 0, "ROOT_OWNER_REQUIRED")
    if not CONFIG.exists():
        require(args.action == "run", "OWNER_ENROLLMENT_REQUIRED")
        print(json.dumps({"event": "runtime_recovery", "status": "disabled"}))
        return
    config = validate_config(private_read(CONFIG))
    if not config["enabled"] and args.action == "run":
        print(json.dumps({"event": "runtime_recovery", "status": "disabled"}))
        return
    directory(STATE)
    with lock(STATE / "cycle.lock"):
        path = STATE / "state.json"
        runtime = Runtime()
        now = time.time()
        if args.action == "initialize":
            require(not config["enabled"] and not path.exists(), "DISABLED_NEW_ENROLLMENT_REQUIRED")
            with lifecycle.lifecycle_lock() as owner:
                require(owner.active and owner.read_hold() is None, "OWNER_MAINTENANCE_HOLD")
                for name, binding in config["targets"].items():
                    row = runtime.inspect(binding["container_id"])
                    validate_target(TARGETS[name], binding, row)
                    require(running(row) and runtime.probe(TARGETS[name], binding) == "healthy", "HEALTHY_ENROLLMENT_REQUIRED")
                require(private_read(CONFIG) == config, "ENROLLMENT_CHANGED")
                write(path, initial_state(config, now))
            print(json.dumps({"event": "runtime_recovery", "status": "initialized-disabled"}))
            return
        with lifecycle.lifecycle_lock(required=True) as owner:
            def guard():
                require(private_read(CONFIG) == config, "ENROLLMENT_CHANGED")
                require(owner.active and owner.read_hold() is None, "OWNER_MAINTENANCE_HOLD")
            guard()
            state = Controller(runtime, lambda value: write(path, value)).tick(
                config, private_read(path), now, guard,
            )
            print(json.dumps({"event": "runtime_recovery", "status": "observed",
                              "targets": {name: value["result"] for name, value in state["targets"].items()}}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print(json.dumps({"event": "runtime_recovery", "status": "blocked-owner-review"}))
        raise SystemExit(1) from None
