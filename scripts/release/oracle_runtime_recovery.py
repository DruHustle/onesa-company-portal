"""Owner-run installation, enrollment and acceptance of bounded Portal recovery.

This is not the initial operations bootstrap. It preserves monitor/backup services,
keys, release records and recovery budgets. Every mutating command needs the existing
owner sudo route, an immutable source pin, current-main CI and genuine signed runtime
acceptance. Only test-staging deliberately faults a process; production is observed.
"""

import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_owner as owner
import runtime_lifecycle as lifecycle

REPOSITORY = "DruHustle/onesa-company-portal"
ROOT = Path("/opt/onesa/runtime-recovery")
UNITS = Path("/etc/systemd/system")
SERVICE = "onesa-runtime-recovery.service"
TIMER = "onesa-runtime-recovery.timer"
SOURCES = (
    "scripts/release/oracle_runtime_recovery.py",
    "scripts/release/oracle_owner.py",
    "scripts/release/runtime_lifecycle.py",
    "infra/oracle/operations/recovery.py",
    "infra/oracle/operations/" + SERVICE,
    "infra/oracle/operations/" + TIMER,
)
HEX = re.compile(r"[a-f0-9]{64}")
STAGING = {"portal-api-staging", "portal-worker-staging"}
PRODUCTION = {"portal-api-production", "portal-worker-production"}
SAMPLE_SECONDS = 300
SAMPLE_COUNT = 6
MAX_SOURCE = 1024 * 1024


def require(value, code):
    if not value:
        raise owner.Rejected(code)


def digest(value):
    return hashlib.sha256(owner.canonical(value)).hexdigest()


def controller(source=None):
    root = source or Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "onesa_commissioned_recovery", root / "infra/oracle/operations/recovery.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def validate_plan(value):
    require(isinstance(value, dict) and set(value) == {
        "schema_version", "repository", "candidate_commit", "source_tree", "targets"
    }, "RECOVERY_PLAN_SCHEMA")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1
            and value["repository"] == REPOSITORY
            and isinstance(value["candidate_commit"], str) and isinstance(value["source_tree"], str)
            and re.fullmatch(r"[a-f0-9]{40}", value["candidate_commit"])
            and re.fullmatch(r"[a-f0-9]{40}", value["source_tree"]), "RECOVERY_SOURCE_BINDING")
    require(isinstance(value["targets"], dict)
            and set(value["targets"]) in [STAGING, STAGING | PRODUCTION], "RECOVERY_TARGET_SCOPE")
    c = controller()
    bindings = {}
    for name, entry in value["targets"].items():
        require(isinstance(entry, dict) and set(entry) == {"binding", "store", "record"}, "RECOVERY_ACCEPTANCE_REFERENCE")
        require(isinstance(entry["store"], str) and Path(entry["store"]).is_absolute()
                and ".." not in Path(entry["store"]).parts, "RECOVERY_STORE_PATH")
        require(isinstance(entry["record"], str) and str(UUID(entry["record"])) == entry["record"], "RECOVERY_RECORD_ID")
        bindings[name] = entry["binding"]
        require(isinstance(entry["binding"], dict)
                and entry["binding"].get("source_commit") == value["candidate_commit"], "RECOVERY_RUNTIME_SOURCE")
    c.validate_config({"schema_version": 1, "enabled": False, "targets": bindings})
    return value


def source_payloads(plan, bundle, github):
    """Compare every executable and unit byte with genuine qualified main blobs."""
    github.owner()
    ci = github.qualify({key: plan[key] for key in ["repository", "candidate_commit", "source_tree"]})
    require(ci, "RECOVERY_CURRENT_MAIN_CI_REQUIRED")
    listing = github.api("repos/" + REPOSITORY + "/git/trees/" + plan["source_tree"] + "?recursive=1")
    require(listing.get("truncated") is False, "RECOVERY_SOURCE_TREE_TRUNCATED")
    blobs = {entry["path"]: entry for entry in listing["tree"] if entry["type"] == "blob"}
    payloads = {}
    for name in SOURCES:
        blob = blobs.get(name)
        require(blob and blob["mode"] == "100644", "RECOVERY_SOURCE_MODE")
        path = Path(bundle) / name
        owner.private(path)
        require(0 < path.stat().st_size <= MAX_SOURCE, "RECOVERY_SOURCE_SIZE")
        data = path.read_bytes()
        observed = github.api("repos/" + REPOSITORY + "/git/blobs/" + blob["sha"])
        require(observed["encoding"] == "base64"
                and base64.b64decode(observed["content"]) == data, "RECOVERY_SOURCE_CHANGED")
        payloads[name] = data
    require(payloads[SOURCES[0]] == Path(__file__).read_bytes()
            and payloads[SOURCES[1]] == Path(owner.__file__).read_bytes()
            and payloads[SOURCES[2]] == Path(lifecycle.__file__).read_bytes(), "RECOVERY_EXECUTED_TOOLCHAIN_CHANGED")
    require(hashlib.sha256(payloads[SOURCES[2]]).hexdigest() == owner.LIFECYCLE_SHA256,
            "RECOVERY_OWNER_INTERLOCK_PIN")
    return payloads, ci


def accepted_targets(plan, github, runtime, names, *, store_factory=owner.Store):
    """An inspect response or a caller's PASS cannot supply runtime acceptance."""
    c = controller()
    result = {}
    for name in sorted(names):
        entry = plan["targets"][name]
        store = store_factory(Path(entry["store"]), github)
        try:
            kind = "qualification" if name in STAGING else "production-verification"
            record = store.get(entry["record"], kind, historical=True)["record"]
            # An accepted runtime snapshot is provenance, not a reused deployment
            # authorization. Still require a recent signature and a live, wholly
            # unrevoked chain; Store's historical read alone permits revocations.
            issued = datetime.fromisoformat(record["issued_at"])
            age = (datetime.now(timezone.utc) - issued).total_seconds()
            require(0 <= age <= 86400, "RECOVERY_ACCEPTED_RUNTIME_TOO_OLD")
            reference, visited = entry["record"], set()
            while reference:
                require(reference not in visited and len(visited) < 128, "RECOVERY_ACCEPTANCE_CHAIN_BOUND")
                visited.add(reference)
                row = store.db.execute("SELECT revoked,parent FROM records WHERE id=?", (reference,)).fetchone()
                require(row is not None and row[0] == 0, "RECOVERY_ACCEPTANCE_REVOKED")
                reference = row[1]
            require(record["binding"]["repository"] == REPOSITORY
                    and record["binding"]["component"] == "identity"
                    and record["binding"]["candidate_commit"] == plan["candidate_commit"]
                    and record["binding"]["source_tree"] == plan["source_tree"], "RECOVERY_ACCEPTED_SOURCE_CHANGED")
            observations = (record["details"]["staging"]["observations"] if name in STAGING
                            else record["details"]["observations"])
            require(observations["environment"] == ("staging" if name in STAGING else "production")
                    and observations.get("runtime_targets", {}).get(name) == entry["binding"],
                    "RECOVERY_SIGNED_RUNTIME_BINDING_REQUIRED")
            checks = observations.get("checks", {})
            needed = {"source_build_image_identity", "authentication_and_authorization"}
            needed.add("configuration_and_isolation" if name in STAGING else "configuration_preserved")
            require(all(checks.get(key) == "PASS" for key in needed), "RECOVERY_ACCEPTED_CHECKS_REQUIRED")
            row = runtime.inspect(entry["binding"]["container_id"])
            c.validate_target(c.TARGETS[name], entry["binding"], row)
            require(c.running(row) and runtime.probe(c.TARGETS[name], entry["binding"]) == "healthy",
                    "RECOVERY_HEALTHY_COMPATIBLE_RUNTIME_REQUIRED")
            result[name] = copy.deepcopy(entry["binding"])
        finally:
            store.db.close()
    return result


def commissioned_owner(plan, github, *, store_factory=owner.Store):
    """Retain the existing commissioned SSH principal and matched verifier custody."""
    observed = subprocess.run(
        ["/usr/bin/ssh-keygen", "-lf", "/home/ubuntu/.ssh/authorized_keys", "-E", "sha256"],
        capture_output=True, text=True, timeout=15, check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
    )
    require(observed.returncode == 0 and len(observed.stdout) < 65536, "RECOVERY_OWNER_PRINCIPAL_UNAVAILABLE")
    principals = {line.split()[1] for line in observed.stdout.splitlines() if len(line.split()) >= 2}
    for path in sorted({entry["store"] for entry in plan["targets"].values()}):
        store = store_factory(Path(path), github)
        try:
            require(store.trust["owner_ssh_principal"] in principals
                    and store.trust["verifier_sha256"] == owner.file_digest(owner.__file__),
                    "RECOVERY_COMMISSIONED_OWNER_CHANGED")
            require(owner.file_digest(lifecycle.__file__) == owner.LIFECYCLE_SHA256,
                    "RECOVERY_COMMISSIONED_INTERLOCK_CHANGED")
        finally:
            store.db.close()


def mkdir_private(path):
    path = Path(path)
    if not path.exists():
        parent = path.parent
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0,
                "RECOVERY_DIRECTORY_PARENT")
        path.mkdir(mode=0o700)
        lifecycle._sync_directory(parent)
    lifecycle.private_path(path, directory=True)


def write_bytes(path, value, *, mode=0o600):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), "wb") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    lifecycle._sync_directory(Path(path).parent)


class Host:
    def __init__(self):
        self.c = controller()
        self.runtime = self.c.Runtime()

    @staticmethod
    def command(arguments, timeout=20):
        result = subprocess.run(arguments, capture_output=True, timeout=timeout, check=False,
                                env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        require(result.returncode == 0 and len(result.stdout) <= MAX_SOURCE, "RECOVERY_HOST_COMMAND_FAILED")
        return result.stdout

    def systemctl(self, *args):
        require(all(isinstance(arg, str) and "\n" not in arg for arg in args), "RECOVERY_SYSTEMD_ARGUMENT")
        return self.command(["/usr/bin/systemctl", *args])

    def properties(self, unit):
        require(unit in {SERVICE, TIMER}, "RECOVERY_UNIT_SCOPE")
        fields = ["LoadState", "ActiveState", "UnitFileState", "FragmentPath", "Result", "InvocationID",
                  "ExecMainStartTimestampMonotonic", "LastTriggerUSecMonotonic"]
        result = subprocess.run(["/usr/bin/systemctl", "show", unit, "--property=" + ",".join(fields)],
                                capture_output=True, timeout=15, check=False,
                                env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        require(len(result.stdout) <= 65536, "RECOVERY_SYSTEMD_RESPONSE_BOUND")
        value = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
        require(result.returncode == 0 or result.returncode == 4 and value.get("LoadState") == "not-found",
                "RECOVERY_SYSTEMD_OBSERVATION_FAILED")
        return value

    def inventory(self):
        # Keep only identities; private inspect output is never journaled or printed.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            result = self.runtime.command(["ps", "-aq", "--no-trunc"])
            require(result.returncode == 0 and len(result.stdout) < 65536, "RECOVERY_INVENTORY_FAILED")
            identifiers = result.stdout.decode().splitlines()
            require(0 < len(identifiers) <= 256 and len(set(identifiers)) == len(identifiers),
                    "RECOVERY_INVENTORY_BOUND")
            rows, transient = {}, False
            for identifier in identifiers:
                try:
                    row = self.runtime.inspect(identifier)
                except self.c.Refused:
                    latest = self.runtime.command(["ps", "-aq", "--no-trunc"])
                    require(latest.returncode == 0 and set(latest.stdout.decode().splitlines()) != set(identifiers),
                            "RECOVERY_UNCHANGED_INVENTORY_INSPECTION_FAILED")
                    transient = True
                    break
                require(type(row["HostConfig"].get("AutoRemove")) is bool, "RECOVERY_RUNTIME_LIFECYCLE_METADATA")
                transient = transient or row["HostConfig"]["AutoRemove"]
                rows[identifier] = {"image_id": row["Image"], "started_at": row["State"]["StartedAt"],
                                    "running": row["State"]["Running"], "restarts": row["RestartCount"],
                                    "configuration_sha256": self.c.fingerprint(row)}
            if not transient:
                return rows
            # Do not omit short-lived clients or silently allow an unknown workload.
            time.sleep(0.25)
        raise owner.Rejected("RECOVERY_INVENTORY_NOT_QUIESCENT")

    def fault(self, name, binding, signum):
        require(name in STAGING and signum in {signal.SIGSTOP, signal.SIGKILL}, "RECOVERY_STAGING_FAULT_SCOPE")
        row = self.runtime.inspect(binding["container_id"])
        self.c.validate_target(self.c.TARGETS[name], binding, row)
        require(self.c.running(row), "RECOVERY_FAULT_TARGET_NOT_RUNNING")
        init = row["State"]["Pid"]
        children = Path(f"/proc/{init}/task/{init}/children").read_text().split()
        require(len(children) == 1, "RECOVERY_ONE_APPLICATION_CHILD_REQUIRED")
        pid = int(children[0])
        identity = self.runtime.process_identity(pid, binding["container_id"])
        handle = os.pidfd_open(pid)
        try:
            expected = [b"node", ("dist/src/server.js" if name == "portal-api-staging"
                                  else "dist/src/jobs/worker.js").encode()]
            require(Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[:2] == expected,
                    "RECOVERY_FAULT_PROCESS_PROFILE")
            fresh = self.runtime.inspect(binding["container_id"])
            self.c.validate_target(self.c.TARGETS[name], binding, fresh)
            require(self.c.incarnation(fresh) == self.c.incarnation(row)
                    and self.runtime.process_identity(pid, binding["container_id"]) == identity,
                    "RECOVERY_FAULT_PROCESS_CHANGED")
            signal.pidfd_send_signal(handle, signum)
        finally:
            os.close(handle)
        return row


def installation(plan, *, executed=True):
    expected = ROOT / "releases" / plan["candidate_commit"]
    current = ROOT / "current"
    require(current.is_symlink() and current.lstat().st_uid == 0
            and os.readlink(current) == str(expected), "RECOVERY_ACTIVE_SOURCE_LINK")
    record = lifecycle.read_private_json(expected / "installation.json")
    require(record["source"] == plan["candidate_commit"] and record["source_tree"] == plan["source_tree"]
            and set(record["files"]) == set(SOURCES), "RECOVERY_INSTALLATION_BINDING")
    for name, checksum in record["files"].items():
        path = expected / name
        owner.private(path)
        require(owner.file_digest(path) == checksum, "RECOVERY_INSTALLED_SOURCE_CHANGED")
    if executed:
        for name, loaded in [(SOURCES[0], __file__), (SOURCES[1], owner.__file__), (SOURCES[2], lifecycle.__file__)]:
            require(Path(loaded).read_bytes() == (expected / name).read_bytes(), "RECOVERY_EXECUTED_SOURCE_CHANGED")
    for unit in [SERVICE, TIMER]:
        path = UNITS / unit
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and info.st_mode & 0o022 == 0 and path.read_bytes() == (expected / "infra/oracle/operations" / unit).read_bytes(),
                "RECOVERY_INSTALLED_UNIT_CHANGED")
    return record


def install(plan, bundle, github, host):
    payloads, ci = source_payloads(plan, bundle, github)
    config = lifecycle.read_private_json(lifecycle.CONFIG, required=False)
    require(config is None or config.get("enabled") is False, "RECOVERY_DISABLE_BEFORE_INSTALL")
    require(host.properties(TIMER).get("ActiveState") in {"inactive", "failed"}, "RECOVERY_TIMER_MUST_BE_STOPPED")
    mkdir_private(ROOT)
    mkdir_private(ROOT / "releases")
    mkdir_private(lifecycle.STATE)
    with lifecycle.lifecycle_lock() as guard:
        require(guard.read_hold() is None, "RECOVERY_EXISTING_HOLD")
        target = ROOT / "releases" / plan["candidate_commit"]
        if target.exists():
            existing = installation(plan)
            require(existing["files"] == {name: hashlib.sha256(value).hexdigest() for name, value in payloads.items()},
                    "RECOVERY_INSTALLATION_SOURCE_DIFFERENCE")
            return {"status": "installed-disabled", "source": plan["candidate_commit"], "changed": False}
        current = ROOT / "current"
        prior_units = {}
        if current.exists() or current.is_symlink():
            require(current.is_symlink() and current.lstat().st_uid == 0, "RECOVERY_EXISTING_SOURCE_ALIAS")
            previous = Path(os.readlink(current))
            require(previous.parent == ROOT / "releases" and re.fullmatch(r"[a-f0-9]{40}", previous.name),
                    "RECOVERY_EXISTING_SOURCE_PATH")
            prior = lifecycle.read_private_json(previous / "installation.json")
            installation({"candidate_commit": previous.name, "source_tree": prior["source_tree"]}, executed=False)
            prior_units = {unit: (previous / "infra/oracle/operations" / unit).read_bytes() for unit in [SERVICE, TIMER]}
        token = guard.begin_hold("recovery-install", REPOSITORY + ":recovery", digest(plan))
        target.mkdir(mode=0o700)
        for name, data in payloads.items():
            path = target / name
            for directory in reversed(list(path.parent.parents)):
                if directory.is_relative_to(target) and not directory.exists():
                    directory.mkdir(mode=0o700)
            path.parent.mkdir(mode=0o700, exist_ok=True)
            write_bytes(path, data)
        record = {"schema_version": 1, "source": plan["candidate_commit"], "source_tree": plan["source_tree"],
                  "files": {name: hashlib.sha256(value).hexdigest() for name, value in payloads.items()}, "ci": ci}
        lifecycle.write_private_json(target / "installation.json", record, create_only=True)
        for unit in [SERVICE, TIMER]:
            path = UNITS / unit
            data = payloads["infra/oracle/operations/" + unit]
            if path.exists() or path.is_symlink():
                info = path.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                        and info.st_mode & 0o022 == 0
                        and path.read_bytes() in [data, prior_units.get(unit)], "RECOVERY_EXISTING_UNIT_DIFFERS")
                if path.read_bytes() != data:
                    temporary = path.with_name("." + unit + "." + uuid4().hex)
                    write_bytes(temporary, data, mode=0o644)
                    require(path.lstat().st_ino == info.st_ino and path.read_bytes() == prior_units[unit],
                            "RECOVERY_EXISTING_UNIT_CHANGED")
                    os.replace(temporary, path)
                    lifecycle._sync_directory(UNITS)
            else:
                write_bytes(path, data, mode=0o644)
        link = ROOT / (".current-" + uuid4().hex)
        link.symlink_to(target)
        os.replace(link, ROOT / "current")
        lifecycle._sync_directory(ROOT)
        host.command(["/usr/bin/systemd-analyze", "verify", str(UNITS / SERVICE), str(UNITS / TIMER)])
        host.systemctl("daemon-reload")
        installation(plan)
        guard.complete_hold(token)
    return {"status": "installed-disabled", "source": plan["candidate_commit"], "changed": True}


def enrollment_state(c, old_config, old_state, new_config, now):
    result = c.initial_state(new_config, now)
    if old_state is None:
        require(old_config is None, "RECOVERY_EXISTING_CONFIG_WITHOUT_STATE")
        return result
    c.validate_state(old_config, old_state, now)
    require(set(old_config["targets"]) <= set(new_config["targets"]), "RECOVERY_ENROLLMENT_CANNOT_DROP_TARGETS")
    for name, row in old_state["targets"].items():
        require(row["pending"] is None and not row["latched"], "RECOVERY_UNRESOLVED_ACTION_RETAINED")
        if old_config["targets"][name] == new_config["targets"][name]:
            result["targets"][name] = copy.deepcopy(row)
        else:
            # Replacement cannot erase a target's already-consumed daily budget.
            result["targets"][name]["attempts"] = copy.deepcopy(row["attempts"])
    return result


def enroll(plan, github, host, environment):
    installation(plan)
    names = STAGING if environment == "staging" else STAGING | PRODUCTION
    require(names <= set(plan["targets"]), "RECOVERY_ENROLLMENT_PLAN_SCOPE")
    bindings = accepted_targets(plan, github, host.runtime, names)
    config = {"schema_version": 1, "enabled": False, "targets": bindings}
    state_path = lifecycle.STATE / "state.json"
    pending_path = lifecycle.STATE / "enrollment-pending.json"
    with lifecycle.lifecycle_lock() as guard:
        old = lifecycle.read_private_json(lifecycle.CONFIG, required=False)
        require(old is None or old["enabled"] is False, "RECOVERY_DISABLE_BEFORE_ENROLLMENT")
        old_state = lifecycle.read_private_json(state_path, required=False)
        token = guard.begin_hold("recovery-enroll", REPOSITORY + ":recovery", digest(plan) + ":" + environment, resume=True)
        require(not guard.read_hold().get("revocations"), "RECOVERY_ENROLLMENT_REVOKED")
        pending = lifecycle.read_private_json(pending_path, required=False)
        if pending:
            require(pending["plan"] == digest(plan) and pending["config"] == config
                    and old in [pending["previous_config"], config]
                    and old_state in [pending["previous_state"], pending["state"]], "RECOVERY_ENROLLMENT_UNCERTAIN")
            state = pending["state"]
        else:
            state = enrollment_state(host.c, old, old_state, config, time.time())
            pending = {"plan": digest(plan), "previous_config": old, "previous_state": old_state,
                       "config": config, "state": state}
            lifecycle.write_private_json(pending_path, pending, create_only=True)
        accepted_targets(plan, github, host.runtime, names)
        lifecycle.write_private_json(lifecycle.CONFIG, config)
        lifecycle.write_private_json(state_path, state)
        host.c.validate_state(config, lifecycle.read_private_json(state_path), time.time())
        pending_path.unlink()
        lifecycle._sync_directory(lifecycle.STATE)
        guard.complete_hold(token)
    return {"status": "enrolled-disabled", "targets": sorted(names)}


def stage_binding(plan):
    return {"source": plan["candidate_commit"], "source_tree": plan["source_tree"],
            "targets": {name: plan["targets"][name]["binding"] for name in sorted(STAGING)}}


def activate(plan, github, host, environment):
    installation(plan)
    names = STAGING if environment == "staging" else STAGING | PRODUCTION
    accepted = accepted_targets(plan, github, host.runtime, names)
    with lifecycle.lifecycle_lock() as guard:
        hold = guard.read_hold()
        require(hold is None or hold["kind"] == "recovery-enable" and hold["scope"] == REPOSITORY + ":recovery"
                and hold["reference"] == digest(plan) + ":" + environment and not hold.get("revocations"),
                "RECOVERY_EXISTING_HOLD")
        require(not (lifecycle.STATE / "acceptance-pending.json").exists(), "RECOVERY_STAGING_TEST_UNRESOLVED")
        config = host.c.validate_config(lifecycle.read_private_json(lifecycle.CONFIG))
        require(config["targets"] == accepted, "RECOVERY_ENROLLMENT_CHANGED")
        state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
        host.c.validate_state(config, state, time.time())
        require(all(row["pending"] is None and not row["latched"] for row in state["targets"].values()),
                "RECOVERY_UNRESOLVED_ACTION_RETAINED")
        if environment == "production":
            receipt = lifecycle.read_private_json(lifecycle.STATE / "staging-acceptance.json")
            checks = {name + ":" + case for name in STAGING for case in ["crash", "hang", "maintenance", "manual-stop"]}
            require(receipt.get("binding") == stage_binding(plan)
                    and receipt.get("status") == "passed"
                    and set(receipt.get("checks", {})) == checks
                    and all(value == "PASS" for value in receipt["checks"].values())
                    and 0 <= time.time() - receipt["observed_at"] <= 86400, "RECOVERY_STAGING_ACCEPTANCE_REQUIRED")
            observation = lifecycle.read_private_json(lifecycle.STATE / "staging-observation.json")
            evidence = observation.get("sample_evidence", [])
            require(observation.get("binding") == stage_binding(plan)
                    and observation.get("status") == "passed" and observation.get("manual_invocations") == 0
                    and observation.get("span_seconds", 0) >= SAMPLE_SECONDS
                    and observation.get("samples", 0) >= SAMPLE_COUNT
                    and len(evidence) == observation["samples"]
                    and all(set(item) == {"invocation", "checked_at", "monotonic"} for item in evidence)
                    and len({item["invocation"] for item in evidence}) == len(evidence)
                    and all(b["monotonic"] > a["monotonic"] and b["checked_at"] > a["checked_at"]
                            for a, b in zip(evidence, evidence[1:]))
                    and (evidence[-1]["monotonic"] - evidence[0]["monotonic"]) / 1_000_000 == observation["span_seconds"]
                    and receipt["observed_at"] <= observation["observed_at"] <= time.time(),
                    "RECOVERY_ORDINARY_STAGING_OBSERVATION_REQUIRED")
        token = guard.begin_hold("recovery-enable", REPOSITORY + ":recovery", digest(plan) + ":" + environment, resume=True)
        config["enabled"] = True
        lifecycle.write_private_json(lifecycle.CONFIG, config)
        host.systemctl("enable", "--now", TIMER)
        require(host.properties(TIMER).get("ActiveState") == "active", "RECOVERY_TIMER_NOT_ACTIVE")
        guard.complete_hold(token)
    return {"status": "enabled-unverified", "targets": sorted(names)}


def disable(host):
    """Stopping remediation never clears a pending action or a maintenance hold."""
    with lifecycle.lifecycle_lock() as guard:
        config = lifecycle.read_private_json(lifecycle.CONFIG, required=False)
        if config:
            config["enabled"] = False
            lifecycle.write_private_json(lifecycle.CONFIG, config)
        host.systemctl("disable", "--now", TIMER)
        return {"status": "disabled", "hold_preserved": guard.read_hold() is not None}


def timer_observation(host):
    timer, service = host.properties(TIMER), host.properties(SERVICE)
    require(timer.get("ActiveState") == "active" and timer.get("UnitFileState") == "enabled"
            and timer.get("FragmentPath") == str(UNITS / TIMER)
            and service.get("FragmentPath") == str(UNITS / SERVICE), "RECOVERY_INSTALLED_TIMER_INACTIVE")
    return timer, service


def observe(plan, host, environment, *, clock=time.monotonic, sleep=time.sleep):
    installation(plan)
    names = STAGING if environment == "staging" else STAGING | PRODUCTION
    expected = {name: plan["targets"][name]["binding"] for name in names}
    start, deadline = clock(), clock() + SAMPLE_SECONDS + 300
    samples, invocation = [], None
    while clock() < deadline:
        config = host.c.validate_config(lifecycle.read_private_json(lifecycle.CONFIG))
        require(config["enabled"] and config["targets"] == expected, "RECOVERY_OBSERVED_ENROLLMENT_CHANGED")
        timer, service = timer_observation(host)
        state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
        host.c.validate_state(config, state, time.time())
        current = service.get("ExecMainStartTimestampMonotonic")
        if (current and current != "0" and current != invocation and int(current) / 1_000_000 >= start
                and service.get("ActiveState") == "inactive"
                and service.get("Result") == "success"):
            healthy = all(row["result"] == "healthy" and row["pending"] is None and not row["latched"]
                          for row in state["targets"].values())
            if not healthy:
                require(not samples and all(row["result"] in {"healthy", "startup-grace"}
                        and row["pending"] is None and not row["latched"] for row in state["targets"].values()),
                        "RECOVERY_SCHEDULED_SAMPLE_NOT_HEALTHY")
                sleep(5)
                continue
            require(0 <= time.time() - state["last_checked_at"] < 90, "RECOVERY_STALE_SCHEDULED_STATE")
            stamp = int(service.get("ExecMainStartTimestampMonotonic", "0"))
            trigger = int(timer.get("LastTriggerUSecMonotonic", "0"))
            require(stamp > 0 and trigger > 0 and abs(stamp - trigger) <= 5_000_000,
                    "RECOVERY_ORDINARY_TIMER_TRIGGER_REQUIRED")
            require(not samples or state["last_checked_at"] > samples[-1]["checked_at"], "RECOVERY_REPEATED_STATE_SAMPLE")
            samples.append({"invocation": current, "checked_at": state["last_checked_at"], "monotonic": stamp})
            invocation = current
            span = (samples[-1]["monotonic"] - samples[0]["monotonic"]) / 1_000_000
            if len(samples) >= SAMPLE_COUNT and span >= SAMPLE_SECONDS:
                value = {"binding": stage_binding(plan) if environment == "staging" else
                         {"source": plan["candidate_commit"], "source_tree": plan["source_tree"], "targets": expected},
                         "samples": len(samples), "span_seconds": span, "observed_at": time.time(),
                         "sample_evidence": samples, "status": "passed", "manual_invocations": 0}
                lifecycle.write_private_json(lifecycle.STATE / (environment + "-observation.json"), value)
                return value
        sleep(min(5, max(0, deadline - clock())))
    raise owner.Rejected("RECOVERY_SCHEDULED_OBSERVATION_TIMEOUT")


def test_staging(plan, github, host, *, clock=time.monotonic, sleep=time.sleep):
    installation(plan)
    require(set(plan["targets"]) == STAGING, "RECOVERY_FAULT_PLAN_STAGING_ONLY")
    accepted = accepted_targets(plan, github, host.runtime, STAGING)
    timer_observation(host)
    pending_path = lifecycle.STATE / "acceptance-pending.json"
    with lifecycle.lifecycle_lock(required=True) as guard:
        require(guard.read_hold() is None and not pending_path.exists(), "RECOVERY_ACCEPTANCE_ALREADY_PENDING")
        config = host.c.validate_config(lifecycle.read_private_json(lifecycle.CONFIG))
        require(config["enabled"] and config["targets"] == accepted, "RECOVERY_STAGING_ONLY_ENROLLMENT_REQUIRED")
        state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
        host.c.validate_state(config, state, time.time())
        require(all(not row["attempts"] and row["pending"] is None and not row["latched"]
                    for row in state["targets"].values()), "RECOVERY_STAGING_BUDGET_NOT_FRESH")
        journal = {"operation": str(uuid4()), "binding": stage_binding(plan), "phase": "prepared",
                   "observed_at": time.time(), "checks": {}}
        lifecycle.write_private_json(pending_path, journal, create_only=True)
    unrelated = host.inventory()
    for binding in accepted.values():
        unrelated.pop(binding["container_id"], None)

    held = None

    def check_hold(hold):
        require(hold is None if held is None else hold is not None and hold["token"] == held
                and not hold.get("revocations"), "RECOVERY_OWNER_OPERATION_DURING_ACCEPTANCE")

    @contextmanager
    def owner_lock():
        deadline, entered = clock() + 330, False
        while clock() < deadline:
            try:
                with lifecycle.lifecycle_lock(required=True) as guard:
                    entered = True
                    check_hold(guard.read_hold())
                    yield guard
                    return
            except lifecycle.LifecycleBusy:
                if entered:
                    raise
                # The scheduled controller legitimately holds this lock through
                # the full grace period. A foreign durable owner hold still blocks.
                check_hold(lifecycle.read_private_json(lifecycle.HOLD, required=False))
                sleep(1)
        raise owner.Rejected("RECOVERY_LIFECYCLE_WAIT_EXHAUSTED")

    def preservation():
        current = host.inventory()
        for binding in accepted.values():
            current.pop(binding["container_id"], None)
        require(current == unrelated, "RECOVERY_UNRELATED_RUNTIME_CHANGED")
        # This observation grants no action and must not contend with a controller
        # that is still waiting through the approved TERM grace under its lock.
        check_hold(lifecycle.read_private_json(lifecycle.HOLD, required=False))
        require(lifecycle.read_private_json(lifecycle.CONFIG) == config, "RECOVERY_ACCEPTANCE_CONFIGURATION_CHANGED")

    def save(phase):
        preservation()
        journal["phase"] = phase
        lifecycle.write_private_json(pending_path, journal)

    @contextmanager
    def action_guard():
        # Exclude another commissioned owner action at the actual signal/stop/start
        # boundary, not merely at a preceding observation.
        with owner_lock():
            require(lifecycle.read_private_json(lifecycle.CONFIG) == config, "RECOVERY_ACCEPTANCE_CONFIGURATION_CHANGED")
            yield

    def wait_live(name, binding, before, fault):
        deadline = clock() + host.c.STARTUP_SECONDS + host.c.FAILURE_SECONDS + host.c.TARGETS[name].grace_seconds + 240
        while clock() < deadline:
            preservation()
            row = host.runtime.inspect(binding["container_id"])
            host.c.validate_target(host.c.TARGETS[name], binding, row)
            if (host.c.running(row) and host.c.incarnation(row) != host.c.incarnation(before)
                    and host.runtime.probe(host.c.TARGETS[name], binding) == "healthy"):
                require(row["RestartCount"] == before["RestartCount"] + 1, "RECOVERY_UNEXPECTED_RESTART_COUNT")
                if fault == "hang":
                    state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
                    host.c.validate_state(config, state, time.time())
                    item = state["targets"][name]
                    require(len(item["attempts"]) == 1 and item["pending"] is None and not item["latched"],
                            "RECOVERY_SCHEDULED_ACTION_NOT_CONFIRMED")
                return
            sleep(5)
        raise owner.Rejected("RECOVERY_STAGING_FAULT_TIMEOUT")

    for name, binding in sorted(accepted.items()):
        for fault, signum in [("crash", signal.SIGKILL), ("hang", signal.SIGSTOP)]:
            # Intent survives interruption. No automatic repeat or deletion follows.
            save(name + ":" + fault + "-intent")
            if fault == "hang":
                with owner_lock() as guard:
                    held = guard.begin_hold("recovery-staging-test", REPOSITORY + ":recovery", journal["operation"] + ":" + name)
            with action_guard():
                before = host.fault(name, binding, signum)
            if fault == "hang":
                # Actual scheduled observations are blocked by the durable hold.
                until = clock() + 130
                initial_trigger = host.properties(TIMER).get("LastTriggerUSecMonotonic")
                while clock() < until:
                    preservation()
                    row = host.runtime.inspect(binding["container_id"])
                    host.c.validate_target(host.c.TARGETS[name], binding, row)
                    require(host.c.incarnation(row) == host.c.incarnation(before)
                            and row["RestartCount"] == before["RestartCount"], "RECOVERY_MAINTENANCE_DID_NOT_SUPPRESS")
                    sleep(5)
                timer, _service = timer_observation(host)
                require(int(timer.get("LastTriggerUSecMonotonic", "0")) > int(initial_trigger or "0")
                        and host.runtime.probe(host.c.TARGETS[name], binding) == "failed",
                        "RECOVERY_MAINTENANCE_NOT_EXERCISED")
                with owner_lock() as guard:
                    guard.complete_hold(held)
                held = None
                journal["checks"][name + ":maintenance"] = "PASS"
            wait_live(name, binding, before, fault)
            journal["checks"][name + ":" + fault] = "PASS"
            save(name + ":" + fault + "-observed")
        # The owner test deliberately stops and restores only this enrolled staging
        # target. An interruption leaves its intent, never an automatic start retry.
        save(name + ":manual-stop-intent")
        with action_guard():
            before_stop = host.runtime.inspect(binding["container_id"])
            host.c.validate_target(host.c.TARGETS[name], binding, before_stop)
            require(host.c.running(before_stop), "RECOVERY_STAGING_STOP_TARGET_CHANGED")
            result = host.runtime.command(["stop", "--time", str(host.c.TARGETS[name].grace_seconds), binding["container_id"]],
                                          timeout=host.c.TARGETS[name].grace_seconds + 15)
        require(result.returncode == 0, "RECOVERY_STAGING_STOP_UNCERTAIN")
        stopped = host.runtime.inspect(binding["container_id"])
        stopped_at = time.time()
        host.c.validate_target(host.c.TARGETS[name], binding, stopped)
        require(stopped["State"]["Running"] is False, "RECOVERY_STAGING_STOP_FAILED")
        until = clock() + 130
        while clock() < until:
            preservation()
            current = host.runtime.inspect(binding["container_id"])
            host.c.validate_target(host.c.TARGETS[name], binding, current)
            require(current["State"]["Running"] is False
                    and current["State"]["FinishedAt"] == stopped["State"]["FinishedAt"]
                    and current["RestartCount"] == stopped["RestartCount"], "RECOVERY_MANUAL_STOP_NOT_PRESERVED")
            sleep(5)
        observed_state = lifecycle.read_private_json(lifecycle.STATE / "state.json")
        host.c.validate_state(config, observed_state, time.time())
        require(observed_state["targets"][name]["result"] == "stopped-or-transitioning"
                and observed_state["last_checked_at"] >= stopped_at,
                "RECOVERY_STOP_NOT_OBSERVED_BY_CONTROLLER")
        journal["checks"][name + ":manual-stop"] = "PASS"
        save(name + ":owner-restore-intent")
        with action_guard():
            current = host.runtime.inspect(binding["container_id"])
            host.c.validate_target(host.c.TARGETS[name], binding, current)
            require(current["State"]["Running"] is False and current["State"]["FinishedAt"] == stopped["State"]["FinishedAt"]
                    and current["RestartCount"] == stopped["RestartCount"], "RECOVERY_STAGING_RESTORE_TARGET_CHANGED")
            result = host.runtime.command(["start", binding["container_id"]])
        require(result.returncode == 0, "RECOVERY_STAGING_RESTORE_UNCERTAIN")
        deadline = clock() + 120
        while clock() < deadline:
            preservation()
            current = host.runtime.inspect(binding["container_id"])
            host.c.validate_target(host.c.TARGETS[name], binding, current)
            if host.c.running(current) and host.runtime.probe(host.c.TARGETS[name], binding) == "healthy":
                break
            sleep(5)
        else:
            raise owner.Rejected("RECOVERY_STAGING_RESTORE_TIMEOUT")
        save(name + ":owner-restore-observed")
    preservation()
    journal.update(status="passed", phase="complete", observed_at=time.time())
    lifecycle.write_private_json(lifecycle.STATE / "staging-acceptance.json", journal)
    pending_path.unlink()
    lifecycle._sync_directory(lifecycle.STATE)
    return {"status": "passed", "binding": journal["binding"], "checks": journal["checks"],
            "production_faults": 0, "controller_policy_shortened": False}


def owner_route(source_pin):
    require(os.geteuid() == 0 and os.getenv("SUDO_USER") == "ubuntu"
            and not os.getenv("GITHUB_ACTIONS") and sys.platform == "linux", "RECOVERY_EXISTING_OWNER_ROUTE_REQUIRED")
    owner.private(Path(__file__).resolve())
    require(isinstance(source_pin, str) and HEX.fullmatch(source_pin)
            and owner.file_digest(__file__) == source_pin, "RECOVERY_REVIEWED_SOURCE_PIN_REQUIRED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "enroll", "activate", "observe", "test-staging", "disable"])
    parser.add_argument("--source-pin", required=True)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--plan-pin")
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--environment", choices=["staging", "production"], default="staging")
    args = parser.parse_args()
    owner_route(args.source_pin)
    host = Host()
    if args.action == "disable":
        value = disable(host)
    else:
        require(args.plan is not None and isinstance(args.plan_pin, str) and HEX.fullmatch(args.plan_pin), "RECOVERY_PLAN_PIN_REQUIRED")
        plan = validate_plan(lifecycle.read_private_json(args.plan))
        require(owner.file_digest(args.plan) == args.plan_pin, "RECOVERY_PLAN_CHANGED")
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536, "RECOVERY_PRIVATE_INPUT_BOUND")
        request = json.loads(raw, object_pairs_hook=lifecycle._unique)
        require(isinstance(request, dict) and set(request) == {"owner_token"}, "RECOVERY_PRIVATE_INPUT_SCHEMA")
        github = owner.GitHub(request["owner_token"])
        github.owner()
        github.qualify({key: plan[key] for key in ["repository", "candidate_commit", "source_tree"]})
        commissioned_owner(plan, github)
        if args.action == "install":
            require(args.bundle is not None, "RECOVERY_SOURCE_BUNDLE_REQUIRED")
            value = install(plan, args.bundle, github, host)
        elif args.action == "enroll":
            value = enroll(plan, github, host, args.environment)
        elif args.action == "activate":
            value = activate(plan, github, host, args.environment)
        elif args.action == "observe":
            value = observe(plan, host, args.environment)
        else:
            value = test_staging(plan, github, host)
    print(json.dumps(value, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({"status": "blocked-owner-review", "details": "Private state retained; no automatic retry"}))
        raise SystemExit(1) from None
