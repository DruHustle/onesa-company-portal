"""Exercise actual recovery signals on disposable GitHub-hosted Docker fixtures.

This harness never reads an application environment or enrolls a runtime. Both
containers use the exact local backend image, synthetic configuration and no
network. The one-second grace belongs only to the injected lab Target; installed
targets retain their separately tested 150/180-second shutdown allowances.
"""

import argparse
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DOCKER = "/usr/bin/docker"
LABEL = "org.onesa.recovery-fixture"
PHASES = {
    "guard", "setup", "dependency-liveness", "crash", "hang",
    "manual-stop", "preservation", "cleanup",
}
REFUSAL_CODES = {
    "RUNTIME_IDENTITY_CHANGED", "RUNTIME_LABELS_CHANGED", "PROCESS_PROFILE_CHANGED",
    "UNSAFE_RUNTIME_PROFILE", "PUBLIC_PORT_BINDING", "PROCESS_NOT_RUNNING",
    "FULL_CONTAINER_ID_REQUIRED", "DOCKER_INSPECTION_FAILED",
    "DOCKER_INSPECTION_IDENTITY", "PROCESS_CGROUP_MISMATCH",
    "PROCESS_INCARNATION_CHANGED",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def phase(name):
    require(name in PHASES, "Fixed fixture diagnostic phase required")
    print(json.dumps({"event": "isolated_recovery_smoke", "phase": name}), flush=True)


def diagnostic_code(error):
    # Only these fixed controller codes may leave the fixture. Arbitrary errors,
    # Docker responses, argument values and exception messages remain redacted.
    value = str(error)
    return value if value in REFUSAL_CODES else "FIXTURE_FAILURE"


def runner_guard(image):
    require(
        os.geteuid() == 0
        and sys.platform == "linux"
        and hasattr(os, "pidfd_open")
        and hasattr(signal, "pidfd_send_signal"),
        "Linux root fixture with PIDFD support required",
    )
    require(
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("RUNNER_OS") == "Linux"
        and os.environ.get("GITHUB_REPOSITORY")
        == "DruHustle/onesa-company-portal"
        and re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")),
        "Disposable GitHub-hosted Portal runner required",
    )
    require(not Path("/etc/onesa").exists(), "Installed Onesa host refused")
    require(
        re.fullmatch(r"sha256:[a-f0-9]{64}", image),
        "Already-built immutable local backend image required",
    )


class Fixtures:
    def __init__(self, image, folder):
        self.image = image
        self.operation = uuid4().hex
        self.project = "onesa-recovery-fixture-" + self.operation
        self.owned = {}
        self.env = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "DOCKER_HOST": "unix:///var/run/docker.sock",
            "DOCKER_CONFIG": str(folder / "docker"),
        }
        Path(self.env["DOCKER_CONFIG"]).mkdir(mode=0o700)

    def command(self, *arguments, timeout=20, check=True):
        result = subprocess.run(
            [DOCKER, "--host", "unix:///var/run/docker.sock", *arguments],
            capture_output=True,
            timeout=timeout,
            env=self.env,
            check=False,
        )
        if check:
            require(result.returncode == 0, "Isolated Docker fixture command failed")
        return result

    def inspect(self, identifier):
        rows = json.loads(self.command("inspect", identifier).stdout)
        require(len(rows) == 1, "Unique fixture container required")
        row = rows[0]
        require(
            row["Id"] == self.owned.get(row["Name"].lstrip("/"))
            and row["Config"]["Labels"].get(LABEL) == self.operation,
            "Run-owned fixture identity required",
        )
        return row

    def prepare(self):
        image = json.loads(self.command("image", "inspect", self.image).stdout)[0]
        require(
            image["Id"] == self.image
            and image["Config"]["Cmd"] == ["node", "dist/src/server.js"]
            and image["Config"]["User"] == "node",
            "Actual Portal backend runtime image required",
        )
        # Prior native image fixtures must finish their cleanup. There is no
        # wildcard cleanup: an unexpected Onesa workload aborts before creation.
        names = self.command("ps", "-a", "--format", "{{.Names}}").stdout.decode()
        require(
            not any(name.startswith("onesa-") for name in names.splitlines()),
            "Existing Onesa workload refused",
        )

    def create(self, suffix):
        name = self.project + "-" + suffix
        identifier = self.command(
            "run", "-d", "--pull=never", "--name", name,
            "--network", "none", "--init", "--restart", "unless-stopped",
            "--stop-timeout", "1", "--read-only", "--tmpfs", "/tmp",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128",
            "--label", LABEL + "=" + self.operation,
            "--label", "com.docker.compose.project=" + self.project,
            "--label", "com.docker.compose.service=staging",
            "--label", "org.onesa.product=portal",
            "--label", "org.onesa.environment=staging",
            "--label", "org.onesa.source-commit=" + os.environ["GITHUB_SHA"],
            "-e", "NODE_ENV=production", "-e", "PORT=8300",
            "-e", "SESSION_KEY=local-recovery-fixture-only-" + "x" * 48,
            "-e", "PROXY_SHARED_KEY=local-recovery-fixture-only-" + "y" * 48,
            "-e", "DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/onesa_recovery_test",
            "-e", "PUBLIC_ORIGIN=https://portal.example.invalid",
            "-e", "STORAGE_DIR=/tmp/storage",
            "-e", "AWS_EC2_METADATA_DISABLED=true",
            self.image,
        ).stdout.decode().strip()
        require(re.fullmatch(r"[a-f0-9]{64}", identifier), "Full fixture ID required")
        self.owned[name] = identifier
        row = self.inspect(identifier)
        require(
            row["Image"] == self.image
            and row["HostConfig"]["NetworkMode"] == "none"
            and not row["HostConfig"]["PortBindings"]
            and not row["Mounts"],
            "Network-isolated, mount-free fixture required",
        )
        return name, identifier

    def http(self, identifier, path, expected):
        require(path in {"health", "ready"}, "Read-only fixture probe required")
        self.inspect(identifier)
        script = (
            "fetch('http://127.0.0.1:8300/api/v1/" + path
            + "',{signal:AbortSignal.timeout(1500)})"
            + ".then(r=>process.exit(r.status===" + str(expected)
            + "?0:1)).catch(()=>process.exit(1))"
        )
        return self.command(
            "exec", identifier, "node", "-e", script,
            timeout=4, check=False,
        ).returncode == 0

    def wait_healthy(self, identifier, *, previous_start=None):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            row = self.inspect(identifier)
            if (
                row["State"]["Running"]
                and not row["State"]["Restarting"]
                and (previous_start is None or row["State"]["StartedAt"] != previous_start)
                and self.http(identifier, "health", 200)
            ):
                return row
            time.sleep(0.2)
        raise ValueError("Actual fixture process failed to become live")

    def signal_application(self, identifier, requested_signal):
        """Fault only this run's exact Node child, using a pinned process handle."""
        require(requested_signal in {signal.SIGSTOP, signal.SIGKILL}, "Fixture fault required")
        row = self.inspect(identifier)
        init = row["State"]["Pid"]
        require(row["State"]["Running"] and init > 1, "Running fixture init required")
        children = Path(f"/proc/{init}/task/{init}/children").read_text().split()
        require(len(children) == 1, "One actual application child required")
        child = int(children[0])

        def process_identity():
            fields = Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()
            cgroups = Path(f"/proc/{child}/cgroup").read_text().splitlines()
            require(
                int(fields[1]) == init
                and any(
                    part in {identifier, "docker-" + identifier + ".scope"}
                    for line in cgroups
                    for part in line.split(":", 2)[-1].split("/")
                ),
                "Application child must belong to this fixture container",
            )
            return fields[19]

        original_identity = process_identity()
        fd = os.pidfd_open(child)
        try:
            command = Path(f"/proc/{child}/cmdline").read_bytes().split(b"\0")
            require(
                command[:2] == [b"node", b"dist/src/server.js"],
                "Actual default API process required",
            )
            same = self.inspect(identifier)
            require(
                same["State"]["Pid"] == init
                and same["State"]["StartedAt"] == row["State"]["StartedAt"]
                and process_identity() == original_identity,
                "Fixture process changed before fault",
            )
            signal.pidfd_send_signal(fd, requested_signal)
        finally:
            os.close(fd)
        return row

    def cleanup(self):
        for name, identifier in reversed(list(self.owned.items())):
            # Never infer ownership from a reused name or remove another run's
            # object. All created containers have a durable full-ID readback.
            self.inspect(identifier)
            self.command("rm", "-f", identifier)


def load_recovery():
    path = ROOT / "infra/oracle/operations/recovery.py"
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("onesa_recovery_smoke_runtime", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    args = parser.parse_args()
    phase("guard")
    runner_guard(args.image)
    recovery = load_recovery()
    with tempfile.TemporaryDirectory(prefix="onesa-recovery-smoke-") as folder:
        fixtures = Fixtures(args.image, Path(folder))
        phase("setup")
        fixtures.prepare()
        try:
            name, identifier = fixtures.create("api")
            _sentinel_name, sentinel_id = fixtures.create("sentinel")
            before = fixtures.wait_healthy(identifier)
            sentinel = fixtures.wait_healthy(sentinel_id)
            target = recovery.Target(
                name=name, role="api", project=fixtures.project,
                service="staging", environment="staging", grace_seconds=1,
            )
            binding = {
                "container_id": identifier, "image_id": args.image,
                "source_commit": os.environ["GITHUB_SHA"],
                "configuration_sha256": recovery.fingerprint(before),
            }
            runtime = recovery.Runtime()
            phase("dependency-liveness")
            recovery.validate_target(target, binding, before)
            require(fixtures.http(identifier, "ready", 503), "Unavailable DB must fail readiness")
            for _ in range(3):
                require(runtime.probe(target, binding) == "healthy", "DB outage must preserve process liveness")
            require(fixtures.inspect(identifier)["RestartCount"] == before["RestartCount"], "Dependency outage restarted API")

            # Exercise Docker's actual exit recovery after its normal successful
            # startup window; no restart/start request is issued by the harness.
            phase("crash")
            time.sleep(10)
            crashed = fixtures.signal_application(identifier, signal.SIGKILL)
            recovered = fixtures.wait_healthy(identifier, previous_start=crashed["State"]["StartedAt"])
            require(recovered["RestartCount"] == crashed["RestartCount"] + 1, "Crash did not recover exactly once")

            phase("hang")
            hung = fixtures.signal_application(identifier, signal.SIGSTOP)
            require(runtime.probe(target, binding) == "failed", "Stopped application must fail actual liveness")
            runtime.recover(target, binding, hung)
            recovered = fixtures.wait_healthy(identifier, previous_start=hung["State"]["StartedAt"])
            require(recovered["Id"] == identifier and recovered["Image"] == args.image, "Recovery changed runtime identity")
            require(recovered["RestartCount"] == hung["RestartCount"] + 1, "Hung process did not recover exactly once")
            require(fixtures.http(identifier, "ready", 503), "Recovery fabricated database readiness")

            # Stop at the last possible callback before signaling the pinned
            # process. Docker's intentional-stop decision must remain final.
            phase("manual-stop")
            raced = fixtures.signal_application(identifier, signal.SIGSTOP)
            callbacks = []

            def operator_stop():
                callbacks.append(True)
                require(len(callbacks) == 1, "Stopped fixture received another recovery signal")
                fixtures.command("stop", "--time", "1", identifier, timeout=5)

            try:
                runtime.recover(target, binding, raced, before_signal=operator_stop)
            except recovery.Refused:
                # Refusal after the callback is the expected fail-closed result
                # when its pinned process has ended during an operator stop.
                pass
            require(len(callbacks) == 1, "Manual-stop race was not exercised")
            stopped = fixtures.inspect(identifier)
            require(not stopped["State"]["Running"], "Operator stop was reversed")
            try:
                runtime.recover(target, binding, stopped)
            except recovery.Refused:
                pass
            time.sleep(2)
            still_stopped = fixtures.inspect(identifier)
            require(
                not still_stopped["State"]["Running"]
                and still_stopped["RestartCount"] == raced["RestartCount"],
                "Stopped container was automatically started",
            )

            phase("preservation")
            preserved = fixtures.inspect(sentinel_id)
            require(
                preserved["Id"] == sentinel["Id"]
                and preserved["Image"] == sentinel["Image"]
                and preserved["State"]["StartedAt"] == sentinel["State"]["StartedAt"]
                and preserved["RestartCount"] == sentinel["RestartCount"]
                and fixtures.http(sentinel_id, "health", 200),
                "Independent fixture changed during recovery",
            )
        finally:
            phase("cleanup")
            fixtures.cleanup()
    print(
        "PASS: actual image process health with DB unavailable; crash and hang "
        "recover same container/image; racing and existing operator stops remain "
        "stopped; unrelated container preserved. Synthetic isolated fixtures only."
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"event": "isolated_recovery_smoke", "result": "failed", "code": diagnostic_code(error)}), file=sys.stderr)
        print("Isolated recovery smoke failed; no hosted acceptance claimed", file=sys.stderr)
        raise SystemExit(1) from None
