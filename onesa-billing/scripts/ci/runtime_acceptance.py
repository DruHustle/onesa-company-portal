"""Build, scan and exercise a disposable billing image; never authorize a release.

The executable path is limited to canonical GitHub-hosted native Linux jobs.
Fixture credentials are generated after image construction and never enter an
image, scanner report or uploaded record. No existing host workload is selected.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PRODUCT = "onesa-billing"
REPOSITORY = "DruHustle/onesa-company-portal"
REPOSITORY_ID = "1412150327"
POSTGRES = (
    "postgres@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e"
)
TRIVY = "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
NODE = "node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53"
LABEL = "eu.onesa.billing.runtime-fixture"
ROLE_LABEL = LABEL + ".role"
SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
LANES = ("api", "dispatcher", "webhook", "meter")
NATIVE_PROFILES = {
    "amd64": {
        "machine": "x86_64",
        "runner_arch": "X64",
        "daemon_architectures": {"amd64", "x86_64"},
        "host_refusal": "HOSTED_AMD64_REQUIRED",
    },
    "arm64": {
        "machine": "aarch64",
        "runner_arch": "ARM64",
        "daemon_architectures": {"arm64", "aarch64"},
        "host_refusal": "HOSTED_ARM64_REQUIRED",
    },
}
SCANNER_MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
ADVISORY_ID = re.compile(
    r"(?:CVE-[0-9]{4}-[0-9]{4,19}|GHSA-[23456789cfghjmpqrvwx]{4}"
    r"-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})\Z"
)
SECRET_RULE_CATEGORIES = {
    "aws-access-key-id": "AWS",
    "aws-secret-access-key": "AWS",
    "private-key": "PRIVATE_KEY",
    "jwt-token": "JWT",
    "npm-access-token": "NPM",
    "stripe-publishable-token": "STRIPE",
    "stripe-secret-token": "STRIPE",
}
SCAN_COMMAND_OPERATIONS = frozenset(
    {
        "trivy_image_pull",
        "postgres_image_pull",
        "postgres_image_inspect",
        "runtime_image_save",
        "scanner_image_inspect",
        "scanner_container_create",
        "scanner_container_inspect",
        "scanner_container_start",
        "scanner_container_wait",
    }
)
START_ERRNO_INDICATORS = (
    ("EACCES", (b"permission denied",)),
    ("EPERM", (b"operation not permitted",)),
    ("EROFS", (b"read-only file system", b"read only file system")),
    ("ENOENT", (b"no such file or directory", b"executable file not found")),
    ("ENOEXEC", (b"exec format error",)),
    ("ENOMEM", (b"cannot allocate memory", b"out of memory")),
    ("ENOSPC", (b"no space left on device",)),
    ("EINVAL", (b"invalid argument",)),
    ("ENOTDIR", (b"not a directory",)),
    ("EISDIR", (b"is a directory",)),
    ("EAGAIN", (b"resource temporarily unavailable",)),
    ("EMFILE", (b"too many open files",)),
)
START_SUBSYSTEM_INDICATORS = (
    ("OCI_RUNTIME", (b"oci runtime", b"container init", b"runc ", b"shim task")),
    ("MOUNT", (b"mount ", b"mount:", b"mounting")),
    ("CGROUP", (b"cgroup",)),
    ("EXECUTION", (b"exec ", b"exec:", b"executable file")),
    ("LOGGING", (b"logging driver", b"log driver", b"logger:")),
    ("NETWORK", (b"network", b"endpoint", b"iptables", b"port allocation")),
    ("USER", (b"unable to find user", b"setgroups", b"setuid", b"setgid")),
    ("SECURITY_PROFILE", (b"seccomp", b"apparmor", b"selinux", b"security profile")),
)
PROCESS_ERRNO_INDICATORS = START_ERRNO_INDICATORS + (
    ("ECONNREFUSED", (b"connection refused",)),
    ("ECONNRESET", (b"connection reset",)),
    ("ETIMEDOUT", (b"connection timed out", b"i/o timeout")),
    ("ENETUNREACH", (b"network is unreachable", b"no route to host")),
)
PROCESS_CATEGORY_INDICATORS = (
    ("CACHE", (b"cache",)),
    ("DATABASE", (b"database", b"trivy-db", b"db update", b"db schema")),
    ("DOWNLOAD", (b"download", b"fetch")),
    (
        "REGISTRY",
        (
            b"registry",
            b"ghcr.io",
            b"mirror.gcr.io",
            b"unauthorized",
            b"toomanyrequests",
            b"too many requests",
            b"rate limit",
        ),
    ),
    ("TLS", (b"tls", b"x509", b"certificate", b"ssl")),
    ("TIMEOUT", (b"timeout", b"timed out", b"deadline exceeded")),
    ("EXTRACTION", (b"extract", b"unpack", b"untar", b"decompress", b"archive")),
    ("IMAGE", (b"image", b"manifest", b"artifact")),
    (
        "FORMAT",
        (
            b"invalid character",
            b"unexpected eof",
            b"invalid format",
            b"unsupported format",
            b"invalid json",
            b"malformed",
            b"cannot unmarshal",
            b"invalid tar",
            b"invalid header",
        ),
    ),
)
HTTP_CASES = {
    "health",
    "anonymous_refused",
    "wrong_issuer_refused",
    "foreign_origin_refused",
    "test_sales_closed",
    "checkout_paused",
    "invoice_paused",
    "finalize_paused",
    "unsigned_webhook_refused",
}
REQUIRED_CHECKS = {
    "dockerfile_base_pins",
    "native_docker_architecture",
    "image_architecture_and_entrypoint",
    "internal_network",
    "migration_applied",
    "migration_current",
    "restricted_role_ddl_refusals",
    "runtime_role_api_refused",
    "runtime_role_dispatcher_refused",
    "runtime_role_webhook_refused",
    "runtime_role_meter_refused",
    "migration_checksum_refused",
    "unauthorized_live_refused",
    "api_default_startup",
    "worker_exact_startup",
    "private_runtime_controls",
    "http_closed_mode_and_auth",
    "empty_provider_queues",
    "api_graceful_shutdown",
    "worker_graceful_shutdown",
    "runtime_pools_drained",
    "provider_get_only",
    "source_unchanged",
    "scan_passed",
    "owned_cleanup",
}
CONTAINER_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
    '"labels":{{json .Config.Labels}},"user":{{json .Config.User}},'
    '"cmd":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},'
    '"state":{{json .State}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
    '"privileged":{{json .HostConfig.Privileged}},"caps":{{json .HostConfig.CapDrop}},'
    '"added_caps":{{json .HostConfig.CapAdd}},"security":{{json .HostConfig.SecurityOpt}},'
    '"ports":{{json .HostConfig.PortBindings}},"publish_all":{{json .HostConfig.PublishAllPorts}},'
    '"networks":{{json .NetworkSettings.Networks}},"network_mode":{{json .HostConfig.NetworkMode}},'
    '"pid_mode":{{json .HostConfig.PidMode}},"mounts":{{json .Mounts}}}'
)
IMAGE_FORMAT = (
    '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
    '"user":{{json .Config.User}},"cmd":{{json .Config.Cmd}},'
    '"entrypoint":{{json .Config.Entrypoint}},"labels":{{json .Config.Labels}}}'
)
SCANNER_STATE_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
    '"owner":{{json (index .Config.Labels "eu.onesa.billing.runtime-fixture")}},'
    '"role":{{json (index .Config.Labels "eu.onesa.billing.runtime-fixture.role")}},'
    '"status":{{json .State.Status}},"running":{{json .State.Running}},'
    '"oom_killed":{{json .State.OOMKilled}},"exit_code":{{json .State.ExitCode}}}'
)


class Refused(Exception):
    """Only fixed categories from this module may appear in a public receipt."""


class ScanCommandFailed(Refused):
    """A pre-credential command failed; never retain its arguments or streams."""

    def __init__(self, operation, exit_code, stderr=b""):
        require(
            type(operation) is str and operation in SCAN_COMMAND_OPERATIONS,
            "SCAN_OPERATION_REFUSED",
        )
        require(
            type(exit_code) is int and -255 <= exit_code <= 255 and exit_code != 0,
            "EXIT_CODE_REFUSED",
        )
        super().__init__("COMMAND_FAILED")
        self.summary = {"operation": operation, "exit_code": exit_code}
        if operation == "scanner_container_start":
            self.summary["stderr_indicators"] = scanner_start_indicators(stderr)


class ScanFindingsFailed(Refused):
    """Retain only bounded identifiers and closed categories, never report text."""

    def __init__(self, summary):
        super().__init__("SCANNER_BLOCKING_FINDINGS")
        self.summary = summary


def require(condition, code):
    if not condition:
        raise Refused(code)


def scanner_start_indicators(stderr):
    """Fixed substring indicators, never a raw diagnostic or a cause assertion."""
    require(
        type(stderr) is bytes and len(stderr) <= 2 * 1024 * 1024, "COMMAND_OUTPUT_BOUND"
    )
    folded = stderr.lower()

    def matched(patterns):
        return [
            name
            for name, needles in patterns
            if any(value in folded for value in needles)
        ] or ["UNKNOWN"]

    return {
        "errno": matched(START_ERRNO_INDICATORS),
        "subsystems": matched(START_SUBSYSTEM_INDICATORS),
    }


def scanner_process_indicators(logs):
    """Closed text indicators only: neither scanner findings nor proven causes."""
    require(
        type(logs) is bytes and len(logs) <= 2 * 1024 * 1024,
        "COMMAND_OUTPUT_BOUND",
    )
    folded = logs.lower()

    def matched(patterns):
        return [
            name
            for name, needles in patterns
            if any(value in folded for value in needles)
        ] or ["UNKNOWN"]

    return {
        "errno": matched(PROCESS_ERRNO_INDICATORS),
        "categories": matched(PROCESS_CATEGORY_INDICATORS),
    }


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "DUPLICATE_JSON_KEY")
            value[key] = item
        return value

    def constant(_value):
        raise Refused("NONFINITE_JSON")

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, TypeError):
        raise Refused("INVALID_JSON") from None


def native_profile(architecture):
    require(
        type(architecture) is str and architecture in NATIVE_PROFILES,
        "NATIVE_ARCHITECTURE_REFUSED",
    )
    return NATIVE_PROFILES[architecture]


def hosted_identity(environment, git, machine, architecture="amd64"):
    profile = native_profile(architecture)
    require(
        environment.get("GITHUB_ACTIONS") == "true"
        and environment.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and environment.get("RUNNER_OS") == "Linux"
        and machine == profile["machine"]
        and environment.get("RUNNER_ARCH") == profile["runner_arch"],
        profile["host_refusal"],
    )
    require(
        architecture != "arm64"
        or environment.get("BILLING_REPOSITORY_VISIBILITY") == "public",
        "PUBLIC_ARM64_REPOSITORY_REQUIRED",
    )
    require(
        environment.get("GITHUB_REPOSITORY") == REPOSITORY
        and environment.get("GITHUB_REPOSITORY_ID") == REPOSITORY_ID,
        "CANONICAL_REPOSITORY_REQUIRED",
    )
    require(
        environment.get("GITHUB_EVENT_NAME")
        in {"push", "pull_request", "schedule", "workflow_dispatch"},
        "WORKFLOW_EVENT_REFUSED",
    )
    run_id = environment.get("GITHUB_RUN_ID", "")
    require(
        re.fullmatch(r"[1-9][0-9]{0,19}", run_id)
        and environment.get("GITHUB_RUN_ATTEMPT") == "1",
        "FIRST_ATTEMPT_REQUIRED",
    )
    head = git("rev-parse", "HEAD")
    require(
        HEX40.fullmatch(head) and head == environment.get("GITHUB_SHA"),
        "SOURCE_HEAD_CHANGED",
    )
    require(
        git("config", "--get", "remote.origin.url")
        in {
            "https://github.com/" + REPOSITORY,
            "https://github.com/" + REPOSITORY + ".git",
            "git@github.com:" + REPOSITORY + ".git",
        },
        "SOURCE_ORIGIN_REFUSED",
    )
    root_tree = git("rev-parse", "HEAD^{tree}")
    product_tree = git("rev-parse", "HEAD:" + PRODUCT)
    require(
        HEX40.fullmatch(root_tree)
        and HEX40.fullmatch(product_tree)
        and git("cat-file", "-t", product_tree) == "tree",
        "SOURCE_TREE_REFUSED",
    )
    require(
        not git("status", "--porcelain", "--untracked-files=normal"), "SOURCE_DIRTY"
    )
    return {
        "repository": REPOSITORY,
        "repository_id": int(REPOSITORY_ID),
        "source_path": PRODUCT,
        "native_architecture": architecture,
        "candidate_commit": head,
        "source_tree": root_tree,
        "product_source_tree": product_tree,
        "workflow_run_id": int(run_id),
        "workflow_attempt": 1,
        "workflow_event": environment["GITHUB_EVENT_NAME"],
    }


def native_image_identity(value, architecture):
    native_profile(architecture)
    require(
        isinstance(value, dict)
        and value.get("os") == "linux"
        and value.get("architecture") == architecture,
        "IMAGE_ARCHITECTURE_REFUSED",
    )


def image_identity(value, nonce, architecture="amd64"):
    require(
        isinstance(value, dict) and SHA.fullmatch(value.get("id", "")),
        "IMAGE_ID_REFUSED",
    )
    native_image_identity(value, architecture)
    require(
        value.get("user") == "node"
        and value.get("cmd") == ["node", "dist/main.js"]
        and value.get("entrypoint") == ["docker-entrypoint.sh"],
        "DEFAULT_IMAGE_STARTUP_CHANGED",
    )
    require(value.get("labels", {}).get(LABEL) == nonce, "IMAGE_CUSTODY_REFUSED")
    return {
        "config_image_id": value["id"],
        "os": "linux",
        "architecture": architecture,
        "user": "node",
        "api_cmd": ["node", "dist/main.js"],
        "worker_cmd": ["node", "dist/worker-main.js"],
    }


def validate_build_source(data):
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeError:
        raise Refused("DOCKERFILE_ENCODING_REFUSED") from None
    bases = [
        line.strip() for line in lines if re.match(r"\s*FROM\b", line, re.IGNORECASE)
    ]
    require(
        bases == ["FROM " + NODE + " AS build", "FROM " + NODE],
        "DOCKERFILE_BASE_CHANGED",
    )


def blocking_findings_summary(results, counts, secret_count):
    advisories = []
    omitted = 0
    unidentified = 0
    secret_categories = set()
    for row in results:
        package_type = "OTHER"
        if row.get("Class") == "os-pkgs" and row.get("Type") == "alpine":
            package_type = "ALPINE"
        elif row.get("Class") == "lang-pkgs" and row.get("Type") == "node-pkg":
            package_type = "NODE"
        for finding in row.get("Vulnerabilities", []):
            if finding["Severity"] not in {"HIGH", "CRITICAL"}:
                continue
            advisory_id = finding.get("VulnerabilityID")
            if not (
                type(advisory_id) is str
                and len(advisory_id) <= 32
                and ADVISORY_ID.fullmatch(advisory_id)
            ):
                unidentified += 1
            elif len(advisories) < 50:
                advisories.append(
                    {
                        "id": advisory_id,
                        "severity": finding["Severity"],
                        "package_type": package_type,
                    }
                )
            else:
                omitted += 1
        for finding in row.get("Secrets", []):
            rule = finding.get("RuleID") if isinstance(finding, dict) else None
            secret_categories.add(
                SECRET_RULE_CATEGORIES.get(rule, "OTHER")
                if type(rule) is str
                else "OTHER"
            )
    return {
        "status": "OBSERVED",
        "vulnerability_counts": counts,
        "secret_findings": secret_count,
        "blocking_advisories": advisories,
        "omitted_advisory_count": omitted,
        "unidentified_vulnerability_count": unidentified,
        "secret_rule_categories": sorted(secret_categories),
    }


def scan_summary(report, image_id):
    require(
        isinstance(report, dict)
        and report.get("SchemaVersion") == 2
        and report.get("ArtifactType") == "container_image"
        and isinstance(report.get("ArtifactName"), str)
        and report.get("Metadata", {}).get("ImageID") == image_id
        and report.get("Trivy", {}).get("Version") == "0.75.0",
        "SCANNER_IDENTITY_REFUSED",
    )
    results = report.get("Results")
    require(
        isinstance(results, list) and 0 < len(results) <= 10000,
        "SCANNER_RESULTS_INCOMPLETE",
    )
    # Trivy image scans disable lockfile analyzers; installed Node packages use
    # node-pkg, while npm identifies the disabled package-lock.json analyzer.
    require(
        any(
            isinstance(row, dict)
            and row.get("Class") == "os-pkgs"
            and row.get("Type") == "alpine"
            for row in results
        )
        and any(
            isinstance(row, dict)
            and row.get("Class") == "lang-pkgs"
            and row.get("Type") == "node-pkg"
            for row in results
        ),
        "SCANNER_PACKAGE_COVERAGE_MISSING",
    )
    counts = {
        severity: 0 for severity in ("UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL")
    }
    secret_count = 0
    for row in results:
        require(
            isinstance(row, dict) and isinstance(row.get("Target"), str),
            "SCANNER_RESULT_INVALID",
        )
        vulnerabilities, found_secrets = (
            row.get("Vulnerabilities", []),
            row.get("Secrets", []),
        )
        require(
            isinstance(vulnerabilities, list) and isinstance(found_secrets, list),
            "SCANNER_RESULT_INVALID",
        )
        require(
            not row.get("ExperimentalModifiedFindings"), "SCANNER_FINDINGS_MODIFIED"
        )
        for finding in vulnerabilities:
            require(
                isinstance(finding, dict) and finding.get("Severity") in counts,
                "SCANNER_SEVERITY_INVALID",
            )
            counts[finding["Severity"]] += 1
        secret_count += len(found_secrets)
    if counts["HIGH"] or counts["CRITICAL"] or secret_count:
        try:
            summary = blocking_findings_summary(results, counts, secret_count)
        except Exception:  # noqa: BLE001 -- diagnostics must never mask the blocking finding or publish raw errors.
            summary = {"status": "UNAVAILABLE"}
        raise ScanFindingsFailed(summary)
    return {
        "status": "PASS",
        "scanner_image": TRIVY,
        "scanner_version": "0.75.0",
        "scanners": ["vuln", "secret"],
        "unfixed_included": True,
        "vulnerability_counts": counts,
        "secret_findings": secret_count,
        "config_image_id": image_id,
    }


def scanner_workspace(work):
    # The expanded vulnerability DB exceeds 1.5 GiB. Keep its cache and download
    # scratch off the 512 MiB /tmp tmpfs without raising the 1 GiB RAM limit.
    # This is a capacity preflight, not a disk quota; all paths are private to this
    # run and removed with work after exact owned-container cleanup.
    require(
        shutil.disk_usage(work).free >= SCANNER_MIN_FREE_BYTES,
        "SCANNER_DISK_SPACE",
    )
    workspace = work / "scanner"
    workspace.mkdir(mode=0o700)
    (workspace / "cache").mkdir(mode=0o700)
    (workspace / "tmp").mkdir(mode=0o700)
    return workspace


class Commands:
    def __init__(self, directory, deadline):
        self.directory = directory
        self.deadline = deadline
        config = directory / "docker-config"
        config.mkdir(mode=0o700)
        self.env = {
            "PATH": os.defpath + ":/usr/local/bin",
            "DOCKER_CONFIG": str(config),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
        # setup-node's selected executable may live outside /usr/bin.
        self.node = shutil.which("node")
        self.docker = shutil.which("docker")
        self.openssl = shutil.which("openssl")
        require(
            self.node and self.docker and self.openssl, "REQUIRED_EXECUTABLE_ABSENT"
        )

    def run(self, args, timeout=20, data=None, check=True, operation=None):
        require(
            operation is None
            or (type(operation) is str and operation in SCAN_COMMAND_OPERATIONS),
            "SCAN_OPERATION_REFUSED",
        )
        remaining = min(timeout, self.deadline - time.monotonic())
        require(remaining > 0, "TOTAL_DEADLINE")
        expires = time.monotonic() + remaining
        process = subprocess.Popen(
            args,
            cwd=ROOT,
            env=self.env,
            stdin=subprocess.PIPE if data else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        buffers = {"out": bytearray(), "err": bytearray()}
        selector = selectors.DefaultSelector()
        try:
            for stream, label in ((process.stdout, "out"), (process.stderr, "err")):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, label)
            pending = memoryview(data or b"")
            if data:
                os.set_blocking(process.stdin.fileno(), False)
                selector.register(process.stdin, selectors.EVENT_WRITE, "in")
            while selector.get_map():
                require(time.monotonic() < expires, "COMMAND_DEADLINE")
                for key, _mask in selector.select(min(0.2, expires - time.monotonic())):
                    if key.data == "in":
                        written = os.write(key.fd, pending[:4096])
                        pending = pending[written:]
                        if not pending:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        continue
                    chunk = os.read(key.fd, 16384)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    else:
                        buffers[key.data].extend(chunk)
                        require(
                            sum(map(len, buffers.values())) <= 2 * 1024 * 1024,
                            "COMMAND_OUTPUT_BOUND",
                        )
            remaining = expires - time.monotonic()
            require(remaining > 0, "COMMAND_DEADLINE")
            status = process.wait(timeout=remaining)
        except BaseException:
            # Do this before poll()/wait(): even an exited, unreaped leader can
            # have descendants retaining pipes. Never kill a reused process ID.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
            raise
        finally:
            selector.close()
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()
        if check and status != 0 and operation is not None:
            raise ScanCommandFailed(
                operation,
                status,
                bytes(buffers["err"])
                if operation == "scanner_container_start"
                else b"",
            )
        require(not check or status == 0, "COMMAND_FAILED")
        return status, bytes(buffers["out"]), bytes(buffers["err"])

    def dc(self, *args, **kwargs):
        return self.run(
            [self.docker, "--host", "unix:///var/run/docker.sock", *args], **kwargs
        )

    def git(self, *args):
        return (
            self.run(["git", "--no-lazy-fetch", "-C", str(ROOT), *args])[1]
            .decode()
            .strip()
        )


class Fixture:
    def __init__(self, commands, nonce):
        self.commands = commands
        self.nonce = nonce
        self.network = "onesa-billing-fixture-" + nonce
        self.volume = self.network + "-db"
        self.tag = "onesa-billing-runtime-fixture:" + nonce
        self.resources = []
        self.image_id = None
        self.build_started = False

    def inspect(self, reference, *, operation=None):
        return json_bytes(
            self.commands.dc(
                "inspect",
                "--type",
                "container",
                "--format",
                CONTAINER_FORMAT,
                reference,
                operation=operation,
            )[1]
        )

    def container(self, role, image, options, command=()):
        name = self.network + "-" + role
        expected_image = (
            image
            if SHA.fullmatch(image)
            else self.commands.dc(
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                image,
                operation="scanner_image_inspect" if role == "scanner" else None,
            )[1]
            .decode()
            .strip()
        )
        require(SHA.fullmatch(expected_image), "CONTAINER_IMAGE_ID_REFUSED")
        resource = {
            "kind": "container",
            "name": name,
            "id": None,
            "image": image,
            "image_id": expected_image,
            "role": role,
        }
        self.resources.append(resource)
        raw = (
            self.commands.dc(
                "create",
                "--name",
                name,
                "--label",
                LABEL + "=" + self.nonce,
                "--label",
                ROLE_LABEL + "=" + role,
                "--log-driver",
                "local",
                "--log-opt",
                "max-size=1m",
                "--log-opt",
                "max-file=1",
                "--log-opt",
                "compress=false",
                *options,
                image,
                *command,
                operation="scanner_container_create" if role == "scanner" else None,
            )[1]
            .decode()
            .strip()
        )
        require(HEX64.fullmatch(raw), "CONTAINER_ID_REFUSED")
        resource["id"] = raw
        observed = self.inspect(
            raw, operation="scanner_container_inspect" if role == "scanner" else None
        )
        require(
            observed["id"] == raw
            and observed["name"] == "/" + name
            and observed["labels"].get(LABEL) == self.nonce
            and observed["labels"].get(ROLE_LABEL) == role,
            "CONTAINER_CUSTODY_REFUSED",
        )
        require(observed["image"] == expected_image, "CONTAINER_IMAGE_CHANGED")
        return raw

    def start(self, container, *, operation=None):
        self.commands.dc("start", container, operation=operation)

    def logs(self, container):
        _code, out, err = self.commands.dc("logs", container)
        return out + err

    def wait(self, container, seconds=20, *, operation=None):
        result = (
            self.commands.dc("wait", container, timeout=seconds, operation=operation)[1]
            .decode()
            .strip()
        )
        require(re.fullmatch(r"[0-9]{1,3}", result), "CONTAINER_EXIT_INVALID")
        return int(result)

    def scanner_failure_diagnostics(self, container, exit_code):
        # This is called only after a nonzero wait result, before credentials
        # exist. It never extends the work deadline or retries a Docker read.
        result = {
            "status": "UNAVAILABLE",
            "state": None,
            "log_indicators": scanner_process_indicators(b""),
        }
        try:
            require(
                type(container) is str
                and HEX64.fullmatch(container)
                and type(exit_code) is int
                and 1 <= exit_code <= 999,
                "SCANNER_DIAGNOSTIC_SCOPE_REFUSED",
            )
            selected = [
                value
                for value in self.resources
                if value.get("kind") == "container"
                and value.get("role") == "scanner"
                and value.get("id") == container
            ]
            require(len(selected) == 1, "SCANNER_DIAGNOSTIC_SCOPE_REFUSED")
            resource = selected[0]
            require(
                resource["name"] == self.network + "-scanner"
                and resource["image"] == TRIVY
                and type(resource["image_id"]) is str
                and SHA.fullmatch(resource["image_id"]),
                "SCANNER_DIAGNOSTIC_SCOPE_REFUSED",
            )
            deadline = min(self.commands.deadline, time.monotonic() + 10)

            def read(*args):
                remaining = min(4, deadline - time.monotonic())
                require(remaining > 0, "SCANNER_DIAGNOSTIC_DEADLINE")
                return self.commands.dc(*args, timeout=remaining)

            def state():
                value = json_bytes(
                    read(
                        "inspect",
                        "--type",
                        "container",
                        "--format",
                        SCANNER_STATE_FORMAT,
                        container,
                    )[1]
                )
                require(
                    type(value) is dict
                    and set(value)
                    == {
                        "id",
                        "name",
                        "image",
                        "owner",
                        "role",
                        "status",
                        "running",
                        "oom_killed",
                        "exit_code",
                    }
                    and value["id"] == container
                    and value["name"] == "/" + resource["name"]
                    and value["image"] == resource["image_id"]
                    and value["owner"] == self.nonce
                    and value["role"] == "scanner",
                    "SCANNER_DIAGNOSTIC_CUSTODY_REFUSED",
                )
                require(
                    value["status"] in {"exited", "dead"}
                    and value["running"] is False
                    and type(value["oom_killed"]) is bool
                    and type(value["exit_code"]) is int
                    and 0 <= value["exit_code"] <= 255
                    and value["exit_code"] == exit_code,
                    "SCANNER_DIAGNOSTIC_STATE_REFUSED",
                )
                return {
                    key: value[key]
                    for key in ("status", "running", "oom_killed", "exit_code")
                }

            before = state()
            # STATE_ONLY is the first observation, not a stability assertion.
            result.update(status="STATE_ONLY", state=before)
            _code, out, err = read("logs", "--tail", "200", container)
            after = state()
            require(before == after, "SCANNER_DIAGNOSTIC_STATE_CHANGED")
            indicators = scanner_process_indicators(out + err)
            result.update(status="OBSERVED", log_indicators=indicators)
        except Exception:  # noqa: BLE001 -- optional diagnostics cannot replace the original scanner failure or expose child errors.
            return result
        return result

    def ready(self, container, marker, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            observed = self.inspect(container)
            require(
                observed["state"]["Running"] is True, "CONTAINER_STOPPED_BEFORE_READY"
            )
            lines = self.logs(container).decode().splitlines()
            if marker in lines:
                return
            time.sleep(0.2)
        raise Refused("READINESS_DEADLINE")

    def runtime_options(self, configuration, *extra):
        return [
            "--network",
            self.network,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "100",
            "--memory",
            "256m",
            "--cpus",
            "1",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=16m",
            "--mount",
            f"type=bind,src={configuration},dst=/fixture,readonly",
            *extra,
        ]

    def oneoff(self, role, configuration, command, extra=(), expected=0):
        container = self.container(
            role, self.image_id, self.runtime_options(configuration, *extra), command
        )
        self.start(container)
        require(self.wait(container) == expected, "ONEOFF_EXIT_UNEXPECTED")
        return container, self.logs(container)

    def private_runtime(self, container, expected_command):
        value = self.inspect(container)
        require(
            value["image"] == self.image_id
            and value["user"] == "node"
            and value["cmd"] == expected_command
            and value["entrypoint"] == ["docker-entrypoint.sh"],
            "RUNTIME_COMMAND_CHANGED",
        )
        require(
            value["readonly"] is True
            and value["privileged"] is False
            and value["caps"] == ["ALL"]
            and not value["added_caps"]
            and value["security"] == ["no-new-privileges"]
            and value["pid_mode"] == ""
            and not value["ports"]
            and value["publish_all"] is False
            and value["network_mode"] == self.network
            and set(value["networks"]) == {self.network},
            "PRIVATE_RUNTIME_CONTROLS_CHANGED",
        )
        require(
            all(
                mount["Type"] in {"bind", "tmpfs"}
                and (mount["Destination"] == "/tmp" or mount["RW"] is False)
                and mount["Destination"] in {"/tmp", "/fixture"}
                for mount in value["mounts"]
            ),
            "RUNTIME_MOUNT_CHANGED",
        )

    def cleanup(self):
        # Cleanup gets its own small total budget after the acceptance deadline.
        self.commands.deadline = time.monotonic() + 60
        complete = True
        for resource in reversed(self.resources):
            try:
                kind, name = resource["kind"], resource["name"]
                if kind == "container":
                    value = self.inspect(resource["id"] or name)
                    require(
                        value["name"] == "/" + name
                        and value["labels"].get(LABEL) == self.nonce
                        and value["labels"].get(ROLE_LABEL) == resource["role"]
                        and value["image"] == resource["image_id"],
                        "CLEANUP_CUSTODY_REFUSED",
                    )
                    if resource["id"]:
                        require(
                            value["id"] == resource["id"], "CLEANUP_CUSTODY_REFUSED"
                        )
                    self.commands.dc("rm", "--force", "--volumes", value["id"])
                elif kind == "network":
                    value = json_bytes(self.commands.dc("network", "inspect", name)[1])[
                        0
                    ]
                    require(
                        value["Labels"].get(LABEL) == self.nonce
                        and value["Internal"] is True
                        and value["Name"] == name
                        and not value.get("Containers"),
                        "CLEANUP_CUSTODY_REFUSED",
                    )
                    if resource["id"]:
                        require(
                            value["Id"] == resource["id"], "CLEANUP_CUSTODY_REFUSED"
                        )
                    self.commands.dc("network", "rm", value["Id"])
                elif kind == "volume":
                    value = json_bytes(self.commands.dc("volume", "inspect", name)[1])[
                        0
                    ]
                    require(
                        value["Name"] == name
                        and value["Labels"].get(LABEL) == self.nonce,
                        "CLEANUP_CUSTODY_REFUSED",
                    )
                    self.commands.dc("volume", "rm", name)
                else:
                    raise Refused("CLEANUP_KIND_REFUSED")
            except Exception:  # noqa: BLE001 -- any cleanup uncertainty prevents qualification.
                complete = False
        if self.build_started:
            try:
                value = json_bytes(
                    self.commands.dc(
                        "image", "inspect", "--format", IMAGE_FORMAT, self.tag
                    )[1]
                )
                require(
                    SHA.fullmatch(value.get("id", ""))
                    and value["labels"].get(LABEL) == self.nonce,
                    "CLEANUP_IMAGE_CUSTODY_REFUSED",
                )
                if self.image_id:
                    require(
                        value["id"] == self.image_id, "CLEANUP_IMAGE_CUSTODY_REFUSED"
                    )
                self.commands.dc("image", "rm", self.tag)
            except Exception:  # noqa: BLE001 -- do not remove a resource with unproved custody.
                complete = False
        return complete


def sql(fixture, database, query):
    require(len(query) <= 16384, "FIXTURE_SQL_BOUND")
    return (
        fixture.commands.dc(
            "exec",
            "-i",
            database,
            "psql",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "-U",
            "billing_fixture_admin",
            "-d",
            "onesa_billing_runtime_test",
            "-Atq",
            data=query.encode(),
        )[1]
        .decode()
        .strip()
    )


def validate_queue_projection(value):
    # Account creation reserves its immutable customer intent. It does not
    # enqueue customer_create or any other provider command.
    require(value == "1|1|0|0|0|0|t", "PROVIDER_QUEUE_UNEXPECTED")


def phase(name):
    print("BILLING_RUNTIME " + name, flush=True)


def certificates(commands, directory):
    provider = directory / "provider"
    commands.run(
        [
            commands.openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=Billing CI Disposable CA",
            "-keyout",
            str(provider / "ca.key"),
            "-out",
            str(provider / "ca.crt"),
            "-addext",
            "basicConstraints=critical,CA:TRUE",
        ],
        timeout=15,
    )
    commands.run(
        [
            commands.openssl,
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=api.stripe.com",
            "-keyout",
            str(provider / "server.key"),
            "-out",
            str(provider / "server.csr"),
        ],
        timeout=15,
    )
    extensions = provider / "server.ext"
    extensions.write_text(
        "subjectAltName=DNS:api.stripe.com\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n"
    )
    commands.run(
        [
            commands.openssl,
            "x509",
            "-req",
            "-days",
            "1",
            "-in",
            str(provider / "server.csr"),
            "-CA",
            str(provider / "ca.crt"),
            "-CAkey",
            str(provider / "ca.key"),
            "-CAcreateserial",
            "-extfile",
            str(extensions),
            "-out",
            str(provider / "server.crt"),
        ]
    )
    # The signing key is not needed by any container. No certificate verification
    # bypass is used: the app receives this public CA via NODE_EXTRA_CA_CERTS.
    (provider / "ca.key").unlink()
    for name in ("server.key", "server.crt", "ca.crt"):
        (provider / name).chmod(0o444)
    shutil.copyfile(provider / "ca.crt", directory / "runtime" / "ca.crt")
    (directory / "runtime" / "ca.crt").chmod(0o444)


def runtime_checks(fixture, directory, checks):
    commands = fixture.commands
    fixture_source = ROOT / PRODUCT / "scripts/ci/runtime_fixture.cjs"
    commands.run([commands.node, str(fixture_source), "prepare", str(directory)])
    certificates(commands, directory)
    fixture_bind = [
        "--mount",
        f"type=bind,src={fixture_source},dst=/runtime-fixture.cjs,readonly",
    ]
    for kind, name in (("network", fixture.network), ("volume", fixture.volume)):
        resource = {"kind": kind, "name": name, "id": None}
        fixture.resources.append(resource)
        args = [kind, "create", "--label", LABEL + "=" + fixture.nonce]
        if kind == "network":
            args += ["--internal"]
        value = commands.dc(*args, name)[1].decode().strip()
        if kind == "network":
            require(HEX64.fullmatch(value), "NETWORK_ID_REFUSED")
            resource["id"] = value
            observed = json_bytes(commands.dc("network", "inspect", value)[1])[0]
            require(
                observed["Internal"] is True
                and observed["Labels"].get(LABEL) == fixture.nonce,
                "NETWORK_NOT_INTERNAL",
            )
            checks["internal_network"] = True
    database = fixture.container(
        "postgres",
        POSTGRES,
        [
            "--network",
            fixture.network,
            "--network-alias",
            "billing-db",
            "--env-file",
            str(directory / "postgres.env"),
            "--mount",
            f"type=volume,src={fixture.volume},dst=/var/lib/postgresql/data",
            "--memory",
            "512m",
            "--cpus",
            "1",
            "--pids-limit",
            "150",
        ],
    )
    database_mounts = fixture.inspect(database)["mounts"]
    require(
        len(
            [
                mount
                for mount in database_mounts
                if mount["Destination"] == "/var/lib/postgresql/data"
                and mount["Type"] == "volume"
                and mount.get("Name") == fixture.volume
            ]
        )
        == 1,
        "DATABASE_VOLUME_CUSTODY_REFUSED",
    )
    fixture.start(database)
    until = time.monotonic() + 30
    while True:
        code, _out, _err = commands.dc(
            "exec",
            database,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "billing_fixture_admin",
            "-d",
            "onesa_billing_runtime_test",
            check=False,
        )
        if code == 0:
            break
        require(time.monotonic() < until, "POSTGRES_READINESS_DEADLINE")
        time.sleep(0.2)
    for suffix, marker in (
        ("applied", "BILLING_MIGRATION_APPLIED"),
        ("current", "BILLING_MIGRATION_CURRENT"),
    ):
        _container, logs = fixture.oneoff(
            "migration-" + suffix,
            directory / "migration",
            ["node", "dist/migrate.js"],
            ["--env", "BILLING_MIGRATION_DATABASE_URL_FILE=/fixture/owner.url"],
        )
        require(logs.decode().splitlines() == [marker], "MIGRATION_RESULT_UNEXPECTED")
        checks["migration_" + suffix] = True
    sql(fixture, database, (directory / "roles.sql").read_text())
    _container, logs = fixture.oneoff(
        "role-proof",
        directory / "runtime",
        ["node", "/runtime-fixture.cjs", "roles"],
        fixture_bind,
    )
    require(json_bytes(logs) == {lane: True for lane in LANES}, "ROLE_PROOF_INCOMPLETE")
    checks["restricted_role_ddl_refusals"] = True
    env = ["--env-file", str(directory / "runtime.env")]
    for lane in LANES:
        _container, logs = fixture.oneoff(
            "bad-" + lane,
            directory / "runtime",
            (),
            [
                *env,
                "--env",
                "BILLING_"
                + lane.upper()
                + "_DATABASE_URL_FILE=/fixture/unprivileged.url",
            ],
            expected=1,
        )
        require(
            logs.decode().splitlines() == ["BILLING_RUNTIME_ROLE_UNVERIFIED"],
            "ROLE_STARTUP_REFUSAL_MISSING",
        )
        checks["runtime_role_" + lane + "_refused"] = True
    checksum = digest(
        (ROOT / PRODUCT / "backend/migrations/001_company_billing.sql").read_bytes()
    )
    sql(
        fixture,
        database,
        "UPDATE billing.schema_migrations SET checksum='" + "0" * 64 + "';",
    )
    _container, logs = fixture.oneoff(
        "bad-checksum", directory / "runtime", (), env, expected=1
    )
    require(
        logs.decode().splitlines() == ["MIGRATION_CHECKSUM_MISMATCH"],
        "CHECKSUM_REFUSAL_MISSING",
    )
    sql(
        fixture,
        database,
        "UPDATE billing.schema_migrations SET checksum='" + checksum + "';",
    )
    checks["migration_checksum_refused"] = True
    _container, logs = fixture.oneoff(
        "bad-live",
        directory / "runtime",
        (),
        [*env, "--env", "BILLING_MODE=live"],
        expected=1,
    )
    require(
        logs.decode().splitlines() == ["LIVE_MODE_NOT_AUTHORIZED"],
        "LIVE_REFUSAL_MISSING",
    )
    checks["unauthorized_live_refused"] = True
    provider = fixture.container(
        "provider",
        fixture.image_id,
        fixture.runtime_options(
            directory / "provider",
            "--network-alias",
            "api.stripe.com",
            "--sysctl",
            "net.ipv4.ip_unprivileged_port_start=0",
            *fixture_bind,
        ),
        ["node", "/runtime-fixture.cjs", "serve"],
    )
    fixture.start(provider)
    fixture.ready(provider, "BILLING_PROVIDER_FIXTURE_READY")
    api = fixture.container(
        "api",
        fixture.image_id,
        fixture.runtime_options(
            directory / "runtime", *env, "--network-alias", "billing-api"
        ),
    )
    worker = fixture.container(
        "worker",
        fixture.image_id,
        fixture.runtime_options(directory / "runtime", *env),
        ["node", "dist/worker-main.js"],
    )
    for container, marker, check, command in (
        (
            api,
            "ONESA_BILLING_API_READY",
            "api_default_startup",
            ["node", "dist/main.js"],
        ),
        (
            worker,
            "ONESA_BILLING_WORKER_READY usage_export=not_configured",
            "worker_exact_startup",
            ["node", "dist/worker-main.js"],
        ),
    ):
        fixture.start(container)
        fixture.ready(container, marker)
        fixture.private_runtime(container, command)
        checks[check] = True
    checks["private_runtime_controls"] = True
    _container, logs = fixture.oneoff(
        "http-proof",
        directory / "client",
        ["node", "/runtime-fixture.cjs", "probe"],
        fixture_bind,
    )
    result = json_bytes(logs)
    require(
        set(result) == HTTP_CASES and all(value is True for value in result.values()),
        "HTTP_PROOF_INCOMPLETE",
    )
    checks["http_closed_mode_and_auth"] = True
    counts = sql(
        fixture,
        database,
        "SELECT (SELECT count(*) FROM billing.accounts),"
        "(SELECT count(*) FROM billing.commercial_intents),(SELECT count(*) FROM billing.operations),"
        "(SELECT count(*) FROM billing.webhook_events),(SELECT count(*) FROM billing.usage_events),"
        "(SELECT count(*) FROM billing.usage_outbox),"
        "EXISTS(SELECT 1 FROM billing.commercial_intents i "
        "JOIN billing.accounts a ON a.id=i.account_id JOIN billing.scope_refs s ON s.ref=i.scope_ref "
        "WHERE i.id=a.id AND i.kind='customer' AND i.client_key='account-customer' "
        "AND i.catalog_snapshot='[]'::jsonb AND i.request_snapshot='{}'::jsonb "
        "AND i.application='company' AND a.application='company' AND s.application='company' "
        "AND s.mode='test' AND s.stripe_account_id='acct_runtimeFixture' "
        "AND s.config_version='runtime-fixture-1');",
    )
    validate_queue_projection(counts)
    checks["empty_provider_queues"] = True
    for role, container, marker in (
        ("api", api, "ONESA_BILLING_API_READY"),
        ("worker", worker, "ONESA_BILLING_WORKER_READY usage_export=not_configured"),
    ):
        require(
            fixture.inspect(container)["state"]["Running"] is True,
            "RUNTIME_STOPPED_EARLY",
        )
        commands.dc("kill", "--signal", "TERM", container)
        require(
            fixture.wait(container, 12) == 0
            and fixture.logs(container).decode().splitlines() == [marker],
            "GRACEFUL_SHUTDOWN_FAILED",
        )
        checks[role + "_graceful_shutdown"] = True
    require(
        sql(
            fixture,
            database,
            "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'onesa-billing-%';",
        )
        == "0",
        "RUNTIME_POOLS_NOT_DRAINED",
    )
    checks["runtime_pools_drained"] = True
    commands.dc("kill", "--signal", "TERM", provider)
    require(fixture.wait(provider) == 0, "PROVIDER_SHUTDOWN_FAILED")
    lines = fixture.logs(provider).decode().splitlines()
    require(
        len(lines) == 2
        and lines[0] == "BILLING_PROVIDER_FIXTURE_READY"
        and lines[1].startswith("BILLING_PROVIDER_COUNTS "),
        "PROVIDER_COUNTERS_MISSING",
    )
    provider_counts = json_bytes(lines[1].split(" ", 1)[1])
    require(
        provider_counts
        == {
            "accepted": 2,
            "forbidden": 0,
            "authorization_error": 0,
            "api_version_error": 0,
        },
        "PROVIDER_REQUEST_BOUNDARY_FAILED",
    )
    checks["provider_get_only"] = True
    return {
        "http_cases": result,
        "provider_startup_gets": 2,
        "provider_posts": 0,
        "account_bound_customer_intents": 1,
        "provider_operations": 0,
        "external_provider_calls": 0,
        "usage_export_configured": False,
        "sales_enabled": False,
        "mode": "test",
        "migration_sha256": checksum,
        "provider_fixture": "private TLS; exact GET /v1/account only",
        "limitations": [
            "No live merchant, tax or usage qualification",
            "No customer-create command was enqueued",
            "No production host, other architecture or release authority",
        ],
    }


def verification_manifest(source, image, scan, runtime, checks, architecture="amd64"):
    native_profile(architecture)
    require(
        source.get("repository") == REPOSITORY
        and source.get("repository_id") == int(REPOSITORY_ID)
        and source.get("source_path") == PRODUCT
        and source.get("native_architecture") == architecture
        and source.get("workflow_attempt") == 1
        and type(source.get("workflow_run_id")) is int
        and source["workflow_run_id"] > 0
        and all(
            HEX40.fullmatch(source.get(key, ""))
            for key in ("candidate_commit", "source_tree", "product_source_tree")
        ),
        "EVIDENCE_SOURCE_REFUSED",
    )
    require(
        set(checks) == REQUIRED_CHECKS
        and all(value is True for value in checks.values()),
        "VERIFICATION_INCOMPLETE",
    )
    require(
        image["architecture"] == architecture
        and image["os"] == "linux"
        and scan["config_image_id"] == image["config_image_id"]
        and scan["status"] == "PASS",
        "EVIDENCE_IMAGE_MISMATCH",
    )
    require(
        runtime["mode"] == "test"
        and runtime["sales_enabled"] is False
        and runtime["external_provider_calls"] == 0
        and runtime["provider_posts"] == 0,
        "EVIDENCE_SCOPE_REFUSED",
    )
    return {
        "schema_version": 1,
        **source,
        "component": "company-billing-runtime",
        "status": "VERIFIED",
        "verification_only": True,
        "release_authorized": False,
        "image": image,
        "build_base": NODE,
        "postgres_fixture_image": POSTGRES,
        "security": scan,
        "runtime": runtime,
        "checks": checks,
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }


def write_once(path, value):
    data = canonical(value) + b"\n"
    require(len(data) <= 32768, "RECEIPT_OUTPUT_BOUND")
    with path.open("xb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--native-architecture", choices=tuple(NATIVE_PROFILES), default="amd64"
    )
    args = parser.parse_args()
    architecture = args.native_architecture
    profile = native_profile(architecture)
    runner_temp = Path(os.environ.get("RUNNER_TEMP", "/nonexistent")).resolve(
        strict=True
    )
    output = args.output.absolute()
    require(
        output.parent.resolve(strict=True) == runner_temp and not output.exists(),
        "NEW_RUNNER_OUTPUT_REQUIRED",
    )
    output.mkdir(mode=0o700)
    work = Path(tempfile.mkdtemp(prefix="onesa-billing-runtime-", dir=runner_temp))
    fixture = None
    record = {
        "schema_version": 1,
        "verification_only": True,
        "release_authorized": False,
        "status": "FAILED",
        "checks": {},
        "cleanup": False,
    }
    try:
        commands = Commands(work, time.monotonic() + 600)
        source = hosted_identity(
            os.environ, commands.git, platform.machine(), architecture
        )
        record["source"] = source
        fixture = Fixture(commands, secrets.token_hex(12))
        checks = record["checks"]
        validate_build_source((ROOT / PRODUCT / "backend/Dockerfile").read_bytes())
        checks["dockerfile_base_pins"] = True
        daemon = json_bytes(
            commands.dc(
                "info",
                "--format",
                '{"os":{{json .OSType}},"architecture":{{json .Architecture}}}',
            )[1]
        )
        require(
            daemon.get("os") == "linux"
            and daemon.get("architecture") in profile["daemon_architectures"],
            "DOCKER_ARCHITECTURE_REFUSED",
        )
        checks["native_docker_architecture"] = True
        phase("build_started")
        iid = work / "image.id"
        fixture.build_started = True
        commands.dc(
            "build",
            "--platform",
            "linux/" + architecture,
            "--iidfile",
            str(iid),
            "--label",
            LABEL + "=" + fixture.nonce,
            "--tag",
            fixture.tag,
            str(ROOT / PRODUCT / "backend"),
            timeout=180,
        )
        fixture.image_id = iid.read_text().strip()
        require(SHA.fullmatch(fixture.image_id), "BUILD_IMAGE_ID_INVALID")
        image = image_identity(
            json_bytes(
                commands.dc(
                    "image", "inspect", "--format", IMAGE_FORMAT, fixture.image_id
                )[1]
            ),
            fixture.nonce,
            architecture,
        )
        checks["image_architecture_and_entrypoint"] = True
        phase("build_passed_scan_started")
        commands.dc(
            "pull",
            "--platform",
            "linux/" + architecture,
            TRIVY,
            timeout=90,
            operation="trivy_image_pull",
        )
        commands.dc(
            "pull",
            "--platform",
            "linux/" + architecture,
            POSTGRES,
            timeout=90,
            operation="postgres_image_pull",
        )
        for image_pin, operation in (
            (TRIVY, "scanner_image_inspect"),
            (POSTGRES, "postgres_image_inspect"),
        ):
            native_image_identity(
                json_bytes(
                    commands.dc(
                        "image",
                        "inspect",
                        "--format",
                        '{"os":{{json .Os}},"architecture":{{json .Architecture}}}',
                        image_pin,
                        operation=operation,
                    )[1]
                ),
                architecture,
            )
        reports = work / "reports"
        reports.mkdir(mode=0o700)
        commands.dc(
            "save",
            fixture.image_id,
            "--output",
            str(reports / "image.tar"),
            timeout=30,
            operation="runtime_image_save",
        )
        scanner_work = scanner_workspace(work)
        scanner = fixture.container(
            "scanner",
            TRIVY,
            [
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "--pids-limit",
                "100",
                "--memory",
                "1g",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=512m",
                "--env",
                "TRIVY_CACHE_DIR=/scanner/cache",
                "--env",
                "TMPDIR=/scanner/tmp",
                "--mount",
                f"type=bind,src={scanner_work},dst=/scanner",
                "--mount",
                f"type=bind,src={reports},dst=/reports",
            ],
            [
                "image",
                "--timeout",
                "3m",
                "--db-repository",
                "ghcr.io/aquasecurity/trivy-db:2",
                "--db-repository",
                "mirror.gcr.io/aquasec/trivy-db:2",
                "--scanners",
                "vuln,secret",
                "--format",
                "json",
                "--output",
                "/reports/runtime.json",
                "--input",
                "/reports/image.tar",
            ],
        )
        fixture.start(scanner, operation="scanner_container_start")
        scanner_exit = fixture.wait(scanner, 185, operation="scanner_container_wait")
        if scanner_exit != 0:
            record["scanner_failure"] = {
                "exit_code": scanner_exit,
                "diagnostics": {"status": "UNAVAILABLE"},
            }
            try:
                record["scanner_failure"]["diagnostics"] = (
                    fixture.scanner_failure_diagnostics(scanner, scanner_exit)
                )
            except Exception:  # noqa: BLE001 -- even an unexpected diagnostic error must retain the original wait result and failure.
                record["scanner_failure"]["diagnostics"] = {"status": "UNAVAILABLE"}
        require(scanner_exit == 0, "SCANNER_FAILED")
        report = reports / "runtime.json"
        require(
            report.is_file() and report.stat().st_size <= 32 * 1024 * 1024,
            "SCANNER_REPORT_BOUND",
        )
        raw_scan = report.read_bytes()
        scan = scan_summary(json_bytes(raw_scan), fixture.image_id)
        scan["report_sha256"] = digest(raw_scan)
        checks["scan_passed"] = True
        phase("scan_passed_runtime_started")
        runtime = runtime_checks(fixture, work, checks)
        require(
            hosted_identity(os.environ, commands.git, platform.machine(), architecture)
            == source,
            "SOURCE_CHANGED_DURING_PROOF",
        )
        checks["source_unchanged"] = True
        record.update(image=image, security=scan, runtime=runtime)
        record["evidence_sources"] = {
            name: digest((ROOT / PRODUCT / name).read_bytes())
            for name in (
                "backend/Dockerfile",
                "backend/package-lock.json",
                "backend/migrations/001_company_billing.sql",
                "scripts/ci/runtime_acceptance.py",
                "scripts/ci/runtime_fixture.cjs",
                "scripts/ci/workflows/verify.yml",
                *(
                    ("scripts/ci/workflows/verify-arm64.yml",)
                    if architecture == "arm64"
                    else ()
                ),
            )
        }
    except ScanCommandFailed as error:
        record["failure"] = str(error)
        record["command_failure"] = error.summary
    except ScanFindingsFailed as error:
        record["failure"] = str(error)
        record["scanner_findings"] = error.summary
    except Refused as error:
        record["failure"] = str(error)
    except Exception:  # noqa: BLE001 -- the outer evidence boundary must not emit private child errors.
        record["failure"] = "UNEXPECTED_FIXTURE_FAILURE"
    finally:
        if fixture:
            record["cleanup"] = fixture.cleanup()
        try:
            shutil.rmtree(work)
        except OSError:
            record["cleanup"] = False
    record["checks"]["owned_cleanup"] = record["cleanup"]
    if not record.get("failure") and record["cleanup"]:
        try:
            manifest = verification_manifest(
                record["source"],
                record["image"],
                record["security"],
                record["runtime"],
                record["checks"],
                architecture,
            )
            manifest["evidence_sources"] = record["evidence_sources"]
            write_once(output / "manifest.json", manifest)
            record["status"] = "VERIFIED"
            record["manifest_sha256"] = digest(canonical(manifest) + b"\n")
        except Refused as error:
            record["failure"] = str(error)
    write_once(output / "receipt.json", record)
    phase(
        "verified"
        if record["status"] == "VERIFIED"
        else "refused_" + record.get("failure", "OWNED_CLEANUP_UNPROVED")
    )
    return 0 if record["status"] == "VERIFIED" else 1


if __name__ == "__main__":

    def interrupted(_number, _frame):
        raise Refused("WORKFLOW_INTERRUPTED")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        raise SystemExit(main())
    except Refused as error:
        raise SystemExit("BILLING_RUNTIME " + str(error)) from None
