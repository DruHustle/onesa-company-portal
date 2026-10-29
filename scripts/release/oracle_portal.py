"""Owner-installed Portal frontend observations for the existing Oracle bridge.

This module cannot issue authority. Only a separately commissioned verifier may
reserve a context, authorize its exact artifacts and invoke these pinned runners.
API, worker, scanner and other products are observed and retained independently.
"""

import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import UUID

ROOT = Path("/var/lib/onesa/release-verification/portal")
PLAN = Path("/etc/onesa/oracle-portal-frontend-release.json")
ENV = {
    env: Path("/etc/onesa/backends/portal-" + env + ".env")
    for env in ["staging", "production"]
}
TARGET = {env: "onesa-portal-oracle-api-" + env + "-1" for env in ENV}
VERIFIER = Path(__file__).resolve().with_name("oracle_owner.py")
if not VERIFIER.exists():
    VERIFIER = Path(__file__).resolve().parent.parent / "oracle_owner.py"
OPENSSL = "/usr/bin/openssl" if sys.platform == "linux" else "/opt/homebrew/bin/openssl"


class Refused(ValueError):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def now():
    return dt.datetime.now(dt.timezone.utc)


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def private(path, *, uid=0, directory=False):
    path = Path(path)
    require(
        path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]),
        "CUSTODY_PATH_ALIAS",
    )
    s = path.stat()
    require(
        s.st_uid == uid
        and s.st_mode & 0o077 == 0
        and (
            stat.S_ISDIR(s.st_mode)
            if directory
            else stat.S_ISREG(s.st_mode) and s.st_nlink == 1
        ),
        "PRIVATE_CUSTODY_REQUIRED",
    )
    require(
        all(
            (p.stat().st_uid == 0 and p.stat().st_mode & 0o022 == 0)
            or (uid != 0 and p.stat().st_uid == uid and p.stat().st_mode & 0o077 == 0)
            for p in path.parents
        ),
        "CUSTODY_ANCESTOR",
    )
    return path


def read(path):
    return json.loads(private(path).read_bytes())


def pinned_public_file(path, expected):
    # Existing code and public recovery material are read-only, not secrets.
    # Their reviewed modes need not be changed to match credential custody.
    path = Path(path)
    require(
        path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]),
        "PINNED_PUBLIC_FILE_ALIAS",
    )
    info = path.stat()
    require(
        path.is_file()
        and info.st_uid == 0
        and not info.st_mode & 0o022
        and info.st_nlink == 1
        and all(
            p.stat().st_uid == 0 and not p.stat().st_mode & 0o022 for p in path.parents
        )
        and sha(path) == expected,
        "PINNED_PUBLIC_FILE_CHANGED",
    )
    return path


def write(path, value):
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb"
    ) as f:
        f.write(canonical(value))
        f.flush()
        os.fsync(f.fileno())
    fd = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_raw(path, data):
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb"
    ) as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(Path(path).parent)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def command(args, *, data=None, timeout=30):
    r = subprocess.run(
        args,
        input=data,
        capture_output=True,
        timeout=timeout,
        check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    require(
        r.returncode == 0 and len(r.stdout) <= 8 * 1024 * 1024,
        "PINNED_COMMAND_FAILED_INSPECT_WITHOUT_RETRY",
    )
    return r.stdout


def docker(*args, **kwargs):
    return command(["/usr/bin/docker", *args], **kwargs)


def inventory():
    """Capture every workload only after temporary Docker clients finish."""
    deadline = time.monotonic() + 20
    while True:
        require(time.monotonic() < deadline, "RUNTIME_INVENTORY_NOT_QUIESCENT")
        names = docker("ps", "--format", "{{.Names}}", timeout=5).decode().splitlines()
        require(all(v in names for v in TARGET.values()), "PORTAL_RUNTIME_MISSING")
        try:
            values = json.loads(docker("inspect", *names, timeout=5))
        except Refused:
            # A --rm client can finish between list and inspect. Only retry this
            # read when a fresh list proves the inventory actually changed.
            current = docker("ps", "--format", "{{.Names}}", timeout=5)
            require(
                set(current.decode().splitlines()) != set(names),
                "PINNED_COMMAND_FAILED_INSPECT_WITHOUT_RETRY",
            )
        else:
            observed = {v["Name"].lstrip("/"): v for v in values}
            require(set(observed) == set(names), "RUNTIME_INVENTORY_INCOMPLETE")
            require(
                all(
                    type(v.get("HostConfig", {}).get("AutoRemove")) is bool
                    for v in values
                ),
                "RUNTIME_LIFECYCLE_METADATA_REQUIRED",
            )
            # Do not omit helpers or classify an unknown workload as safe. Wait
            # for automatic removal; a long-lived --rm workload blocks release.
            if not any(v["HostConfig"]["AutoRemove"] for v in values):
                return observed
        require(time.monotonic() < deadline, "RUNTIME_INVENTORY_NOT_QUIESCENT")
        time.sleep(0.25)


def summary(row):
    return {
        "container_id": row["Id"],
        "image": row["Image"],
        "started_at": row["State"]["StartedAt"],
        "restart_count": row["RestartCount"],
        "source": row["Config"].get("Labels", {}).get("org.onesa.source-commit")
        or row["Config"].get("Labels", {}).get("org.opencontainers.image.revision"),
        "environment_sha256": hashlib.sha256(
            "\n".join(sorted(row["Config"]["Env"])).encode()
        ).hexdigest(),
    }


def healthy(row):
    return (
        row["State"]["Running"]
        and not row["State"]["OOMKilled"]
        and row["State"].get("Health", {}).get("Status") == "healthy"
    )


def unchanged(before, after, except_names=()):
    require(
        all(
            name in after and summary(row) == summary(after[name])
            for name, row in before.items()
            if name not in except_names
        ),
        "CONCURRENT_OR_INDEPENDENT_RUNTIME_CHANGED",
    )


def runtime_values(path):
    rows = private(path).read_text().splitlines()
    require(
        all("=" in r and not r.startswith("#") for r in rows if r), "RUNTIME_FILE_SHAPE"
    )
    values = dict(r.split("=", 1) for r in rows if r)
    require(len(values) == len([r for r in rows if r]), "DUPLICATE_CONFIGURATION_KEY")
    return values


def scanned_configuration_digest(identity, proof, architecture="arm64"):
    # OCI metadata is a content-addressed proof, never caller authorization.
    # The starting identity is independently pinned/observed from Docker.
    require(
        re.fullmatch("sha256:[a-f0-9]{64}", identity) and isinstance(proof, dict),
        "OCI_DESCRIPTOR_PROOF_REQUIRED",
    )
    require(architecture in {"arm64", "amd64"}, "SUPPORTED_SCAN_ARCHITECTURE_REQUIRED")
    current, visited = identity, set()
    for _ in range(5):
        require(current not in visited, "OCI_DESCRIPTOR_CYCLE")
        visited.add(current)
        encoded = proof.get(current)
        require(
            isinstance(encoded, str) and len(encoded) <= 1024 * 1024,
            "OCI_DESCRIPTOR_BOUND",
        )
        raw = base64.b64decode(encoded, validate=True)
        require(
            "sha256:" + hashlib.sha256(raw).hexdigest() == current,
            "OCI_DESCRIPTOR_HASH_MISMATCH",
        )
        item = json.loads(raw)
        require(item.get("schemaVersion") == 2, "OCI_DESCRIPTOR_SCHEMA")
        if "manifests" in item:
            native = [
                row
                for row in item["manifests"]
                if row.get("platform", {}).get("os") == "linux"
                and row.get("platform", {}).get("architecture") == architecture
            ]
            require(len(native) == 1, "SINGLE_EXPECTED_PLATFORM_MANIFEST_REQUIRED")
            current = native[0]["digest"]
            require(re.fullmatch("sha256:[a-f0-9]{64}", current), "OCI_CHILD_DIGEST")
            continue
        require(
            item.get("mediaType")
            in [
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            ],
            "OCI_IMAGE_MANIFEST_REQUIRED",
        )
        result = item.get("config", {}).get("digest", "")
        require(re.fullmatch("sha256:[a-f0-9]{64}", result), "OCI_CONFIGURATION_DIGEST")
        return result
    raise Refused("OCI_DESCRIPTOR_DEPTH")


def image_security(scan, identity, architecture="arm64"):
    configuration = identity
    if scan["Metadata"]["ImageID"] != identity:
        require(
            re.fullmatch("sha256:[a-f0-9]{64}", identity),
            "EXACT_IMAGE_IDENTITY_REQUIRED",
        )
        configuration = scanned_configuration_digest(
            identity,
            read(
                Path("/var/lib/onesa/release-verification/image-descriptors")
                / (identity[7:] + ".json")
            ),
            architecture,
        )
    require(
        scan["Metadata"]["ImageID"] == configuration
        and scan.get("Results")
        and scan.get("ArtifactName")
        and scan.get("CreatedAt"),
        "COMPLETE_CURRENT_IMAGE_SCAN_REQUIRED",
    )
    require(
        dt.timedelta(0)
        <= now() - dt.datetime.fromisoformat(scan["CreatedAt"].replace("Z", "+00:00"))
        < dt.timedelta(hours=24),
        "IMAGE_SCAN_STALE",
    )
    # Same gate as scripts/release/image_gate.py; retain all vendor findings.
    require(
        not any(
            row.get("Secrets")
            or any(
                v.get("Severity") in ["HIGH", "CRITICAL"]
                for v in row.get("Vulnerabilities", [])
            )
            for row in scan["Results"]
        ),
        "IMAGE_SECURITY_FAILED",
    )


def verify_invocation(binding, context, phase, plan, *, dependency=False):
    if phase == "staging":
        require(set(context) == {"context_id"}, "STAGING_SIGNED_CONTEXT_ONLY")
    elif phase == "deploy":
        require(
            set(context) == {"operation_id", "authorization_id"},
            "DEPLOY_SIGNED_AUTHORIZATION_OPERATION_ONLY",
        )
    elif phase == "production":
        require(
            set(context) == {"operation_id", "read_only"}
            and context["read_only"] is True,
            "READ_ONLY_PRODUCTION_OBSERVATION_ONLY",
        )
    elif phase == "operations":
        require(
            set(context) == {"context_id"}
            or set(context) == {"qualification_id", "owner_decision"}
            and context["owner_decision"] == "approve"
            or set(context) == {"authorization_id", "before_deployment"}
            and context["before_deployment"] is True,
            "OPERATIONS_SIGNED_INVOCATION_ONLY",
        )
    else:
        raise Refused("RUNNER_PHASE_SCOPE")
    store = private(Path(plan["verifier_store"]), directory=True)
    for name in ["trust.json", "public.pem", "policy.json", "records.sqlite"]:
        private(store / name)
    trust = read(store / "trust.json")
    registry = read(Path("/etc/onesa/oracle-release-trust.json"))
    anchor = registry["installations"].get(str(store))
    require(
        anchor
        and anchor["active"] is True
        and all(
            anchor[k] == trust[k]
            for k in ["installation_id", "key_id", "verifier_sha256", "policy_sha256"]
        ),
        "ISSUER_NOT_COMMISSIONED",
    )
    require(
        sha(store / "public.pem") == trust["key_id"]
        and sha(store / "policy.json") == trust["policy_sha256"]
        and sha(VERIFIER) == trust["verifier_sha256"],
        "ISSUER_CUSTODY_PIN_CHANGED",
    )
    require(sha(OPENSSL) == trust["openssl_sha256"], "SIGNATURE_TOOL_CHANGED")
    db = sqlite3.connect(
        "file:" + str(store / "records.sqlite") + "?mode=ro", uri=True, timeout=20
    )

    records = []
    visited = set()

    def record(identifier, kind=None, historical=False):
        require(
            identifier not in visited and len(visited) < 12,
            "SIGNED_RECORD_CHAIN_CYCLE_OR_BOUND",
        )
        visited.add(identifier)
        require(str(UUID(identifier)) == identifier, "CANONICAL_LEDGER_RECORD_REQUIRED")
        row = db.execute(
            "SELECT envelope,revoked,parent,kind FROM records WHERE id=?", (identifier,)
        ).fetchone()
        require(
            row and ((historical and not dependency) or not row[1]),
            "SIGNED_LEDGER_RECORD_MISSING_OR_REVOKED",
        )
        envelope = json.loads(row[0])
        r = envelope["record"]
        sig = envelope["signature"]
        require(
            sig["algorithm"] == "Ed25519" and sig["key_id"] == trust["key_id"],
            "FOREIGN_RECORD_SIGNER",
        )
        with tempfile.TemporaryDirectory(
            prefix=".runner-signature-", dir=store
        ) as folder:
            p = Path(folder)
            (p / "record").write_bytes(canonical(r))
            (p / "signature").write_bytes(base64.b64decode(sig["value"], validate=True))
            command(
                [
                    OPENSSL,
                    "pkeyutl",
                    "-verify",
                    "-rawin",
                    "-pubin",
                    "-inkey",
                    str(store / "public.pem"),
                    "-sigfile",
                    str(p / "signature"),
                    "-in",
                    str(p / "record"),
                ]
            )
        require(
            r["id"] == identifier
            and r["kind"] == row[3]
            and r["parent"] == row[2]
            and (kind is None or r["kind"] == kind)
            and r["binding"] == binding
            and r["workflow_run_id"] == 0,
            "SIGNED_RECORD_SOURCE_OR_PROVENANCE_MISMATCH",
        )
        provenance = r["owner_provenance"]
        require(
            provenance["owner"] == "DruHustle"
            and provenance["mechanism"]
            == "commissioned-pinned-OpenSSH-and-authenticated-owner"
            and provenance["installation_id"] == trust["installation_id"]
            and provenance["verifier_sha256"] == trust["verifier_sha256"],
            "OWNER_PROVENANCE_REQUIRED",
        )
        issued, expiry = (
            dt.datetime.fromisoformat(r["issued_at"]),
            dt.datetime.fromisoformat(r["expires_at"]),
        )
        require(
            r.get("schema_version") == 1
            and r.get("execution_context")
            == (
                "owner-operated-oracle-staging"
                if r["kind"] in ["context", "qualification"]
                else "owner-operated-oracle-release"
            )
            and dt.timedelta(0) < expiry - issued <= dt.timedelta(hours=24)
            and (historical or issued <= now() < expiry),
            "SIGNED_RECORD_EXPIRED",
        )
        records.append(r)
        if r["parent"]:
            record(r["parent"], historical=historical)
        return r

    try:
        historical = phase == "production"
        if "operation_id" in context:
            if dependency:
                child = db.execute(
                    "SELECT id FROM records WHERE kind='production-verification' AND parent=? ORDER BY sequence DESC LIMIT 1",
                    (context["operation_id"],),
                ).fetchone()
                require(child, "ACCEPTED_API_VERIFICATION_REQUIRED")
                record(child[0], "production-verification", True)
                op = next(
                    item for item in records if item["id"] == context["operation_id"]
                )
            else:
                op = record(context["operation_id"], "deployment-intent", historical)
            row = db.execute(
                "SELECT state,authorization FROM deployments WHERE id=?", (op["id"],)
            ).fetchone()
            require(
                row
                and (phase != "deploy" or row[0] == "request-recorded")
                and (not dependency or row[0] == "accepted"),
                "DURABLE_DEPLOYMENT_INTENT_REQUIRED",
            )
            require(
                op["details"]["provider_request_budget"] == 1
                and op["details"]["automatic_retry"] is False,
                "SINGLE_REQUEST_BUDGET_REQUIRED",
            )
            if phase == "deploy":
                require(
                    row[1] == context["authorization_id"] and op["parent"] == row[1],
                    "AUTHORIZATION_OPERATION_MISMATCH",
                )
        elif "context_id" in context:
            r = record(context["context_id"], "context")
            state = db.execute(
                "SELECT state FROM contexts WHERE id=?", (r["id"],)
            ).fetchone()
            require(
                state and state[0] == "reserved",
                "QUALIFICATION_NOT_ATOMICALLY_RESERVED",
            )
        elif "qualification_id" in context:
            record(context["qualification_id"], "qualification")
        elif "authorization_id" in context:
            record(context["authorization_id"], "authorization")
        else:
            raise Refused("SIGNED_OWNER_INVOCATION_REQUIRED")
    finally:
        db.close()
    return records


def source_inventory(archive_path, binding):
    expected = {}
    files = {}
    tree = {}
    total = 0
    with tarfile.open(archive_path, "r:") as archive:
        members = archive.getmembers()
        require(len(members) < 20000, "SOURCE_ARCHIVE_ENTRY_BOUND")
        for member in members:
            path = Path(member.name)
            require(
                not path.is_absolute()
                and ".." not in path.parts
                and (member.isfile() or member.isdir()),
                "SOURCE_ARCHIVE_TYPE_OR_PATH",
            )
            if member.isfile():
                total += member.size
                require(
                    member.size <= 32 * 1024 * 1024 and total <= 512 * 1024 * 1024,
                    "SOURCE_ARCHIVE_BYTE_BOUND",
                )
                data = archive.extractfile(member).read()
                node = tree
                for name in path.parts[:-1]:
                    node = node.setdefault(name, {})
                    require(isinstance(node, dict), "SOURCE_DIRECTORY_ALIAS")
                require(path.name not in node, "DUPLICATE_SOURCE_ARCHIVE_PATH")
                files[member.name] = hashlib.sha256(data).hexdigest()
                blob = hashlib.sha1(
                    b"blob " + str(len(data)).encode() + b"\0" + data
                ).digest()
                node[path.name] = (
                    b"100755" if member.mode & 0o111 else b"100644",
                    blob,
                )
            prefix = "onesa-company-portal-frontend/"
            if member.isfile() and member.name.startswith(prefix):
                rel = member.name[len(prefix) :]
                if rel in {
                    "src/config/products.ts",
                    "src/components/home-products.tsx",
                }:
                    require(member.size < 8 * 1024 * 1024, "SOURCE_FILE_BOUND")
                    expected[rel] = hashlib.sha256(data).hexdigest()

    def git_tree(node):
        value = b""
        for name, entry in sorted(
            node.items(),
            key=lambda p: (p[0] + ("/" if isinstance(p[1], dict) else "")).encode(),
        ):
            mode, digest = (
                (b"40000", git_tree(entry)) if isinstance(entry, dict) else entry
            )
            value += mode + b" " + name.encode() + b"\0" + digest
        return hashlib.sha1(
            b"tree " + str(len(value)).encode() + b"\0" + value
        ).digest()

    require(
        git_tree(tree).hex() == binding["source_tree"],
        "ARCHIVE_DIFFERS_FROM_QUALIFIED_GIT_TREE",
    )
    require(
        expected
        and "src/config/products.ts" in expected
        and "src/components/home-products.tsx" in expected,
        "COMPLETE_FRONTEND_ARCHIVE_REQUIRED",
    )
    return expected, files


def probe_cpu_limit():
    """Fit the bounded probe to the actual daemon; never request new capacity."""
    value = docker("info", "--format", "{{.NCPU}}", timeout=15).strip()
    require(re.fullmatch(rb"[1-9][0-9]{0,3}", value), "PROBE_HOST_CPU_UNVERIFIED")
    return str(min(2, int(value)))


CHECKS = {
    "staging": {
        "source_build_image_identity",
        "configuration_and_isolation",
        "authentication_and_authorization",
        "persistence",
        "affected_workflows",
        "schema_and_migrations",
        "rollback_readiness",
        "security_and_contracts",
    },
    "operations": {
        "backup_restore",
        "monitoring_and_capacity",
        "privacy_publication_controls",
        "preservation_baseline",
        "rollback_readiness",
    },
    "deploy": {
        "exact_authorized_artifact",
        "configuration_preserved",
        "independent_components_preserved",
        "provider_receipt",
    },
    "production": {
        "source_build_image_identity",
        "health_readiness",
        "authentication_and_authorization",
        "affected_workflows",
        "persistence_preserved",
        "independent_components_preserved",
        "configuration_preserved",
        "no_unapproved_processing_or_actuation",
    },
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def verify_toolchain(plan, binding):
    require(
        binding["repository"] == "DruHustle/onesa-company-portal"
        and binding["component"] == "frontend"
        and binding["target_environment"] == "production",
        "PORTAL_FRONTEND_COMPONENT_SCOPE",
    )
    store = private(Path(plan["verifier_store"]), directory=True)
    trust = read(store / "trust.json")
    anchor = read(Path("/etc/onesa/oracle-release-trust.json"))["installations"].get(
        str(store)
    )
    require(
        anchor
        and anchor["active"] is True
        and all(
            anchor[k] == trust[k]
            for k in ["installation_id", "key_id", "verifier_sha256", "policy_sha256"]
        ),
        "OWNER_INSTALLATION_NOT_COMMISSIONED",
    )
    require(
        sha(private(store / "policy.json")) == trust["policy_sha256"]
        and sha(private(VERIFIER)) == trust["verifier_sha256"]
        and sha(OPENSSL) == trust["openssl_sha256"],
        "COMMISSIONED_TOOLCHAIN_CHANGED",
    )
    policy = read(store / "policy.json")
    profile = policy["components"].get(
        binding["repository"] + ":" + binding["component"]
    )
    require(
        profile and profile["qualification_attempt_limit"] == 1,
        "COMPONENT_NOT_COMMISSIONED_WITH_ONE_CONTEXT",
    )
    require(
        all(
            set(CHECKS[phase]) <= set(profile["required_checks"][phase])
            for phase in CHECKS
        ),
        "MANDATORY_CHECKS_REMOVED",
    )
    installation = read(VERIFIER.parent / "installation.json")
    require(
        installation["state"] == "INSTALLED_NOT_COMMISSIONED"
        and installation["source"] == policy["toolchain"]["source_commit"],
        "INSTALLED_SOURCE_IDENTITY",
    )
    for name, pin in installation["files"].items():
        p = private(VERIFIER.parent / name)
        require(sha(p) == pin, "INSTALLED_EXECUTABLE_CHANGED")
    for phase in CHECKS:
        runner = profile["runners"][phase]
        script = "oracle_portal_frontend.py"
        path = Path(__file__).with_name(script)
        require(
            runner["path"] == str(path.resolve())
            and runner["sha256"] == sha(private(path)),
            "RUNNER_PATH_OR_PIN_CHANGED",
        )
    tool = policy["toolchain"]
    require(
        plan["probe_image"] == tool["probe_image"]
        and plan["cli_image"] == tool["cli_image"]
        and plan["builder_image"] == tool["builder_image"],
        "CANDIDATE_SELECTED_UNREVIEWED_TOOL_IMAGE",
    )
    return tool


def validate_frontend_builds(folder, binding, plan):
    tool = trusted_toolchain(plan)
    for env in ENV:
        build = plan["builds"][env]
        for name in ["archive", "receipt"]:
            require(Path(build[name]).name == build[name], "BUILD_RECEIPT_PATH_SCOPE")
        receipt = read(folder / build["receipt"])
        require(
            sha(private(folder / build["receipt"])) == build["receipt_sha256"]
            and receipt["binding"]["candidate_commit"] == binding["candidate_commit"]
            and receipt["binding"]["source_tree"] == binding["source_tree"]
            and receipt["binding"]["source_sha256"] == binding["source_sha256"]
            and receipt["environment"] == env
            and receipt["source_tree_verified"] is True
            and receipt["provider_credentials_mounted"] is False
            and receipt["builder_sha256"] == tool["builder_sha256"]
            and receipt["tool_image"] == tool["builder_image"],
            "CREDENTIAL_FREE_BUILD_PROVENANCE",
        )
        require(
            sha(private(folder / build["archive"]))
            == build["archive_sha256"]
            == receipt["artifact_sha256"],
            "FRONTEND_BUILD_BYTES_CHANGED",
        )
    require(
        binding["build_sha256"] == plan["builds"]["production"]["receipt_sha256"]
        and binding["artifact_digest"]
        == "sha256:" + plan["builds"]["production"]["archive_sha256"],
        "FRONTEND_ARTIFACT_BINDING",
    )
    require(plan["builder_sha256"] == tool["builder_sha256"], "BUILD_TOOL_PIN")


def verify_probe_bytes(folder, binding, plan):
    tool = trusted_toolchain(plan)
    expected = tool["probe_files"]
    require(
        set(expected) == set(probe_source_files({k: "" for k in expected})),
        "COMPLETE_PROBE_PINS_REQUIRED",
    )
    program = "import pathlib,hashlib,json,sys;root=pathlib.Path('/opt/onesa-company-portal');names=json.load(sys.stdin);print(json.dumps({n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names}))"
    actual = json.loads(
        docker(
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--entrypoint",
            "python3",
            plan["probe_image"],
            "-c",
            program,
            data=canonical(sorted(expected)),
            timeout=60,
        )
    )
    require(actual == expected, "PROBE_BYTES_DIFFER_FROM_COMMISSIONED_TOOL_SOURCE")
    for kind in ["probe", "cli", "builder"]:
        image_security(
            read(private(folder / (kind + "-scan.json"))),
            tool[kind + "_image"],
            "amd64" if kind == "builder" else "arm64",
        )


def trusted_toolchain(plan):
    store = private(Path(plan["verifier_store"]), directory=True)
    trust = read(store / "trust.json")
    require(
        sha(private(store / "policy.json")) == trust["policy_sha256"], "TOOL_POLICY_PIN"
    )
    return read(store / "policy.json")["toolchain"]


def record_failure(phase, request, error):
    """Persist only bounded redacted diagnostics; never reuse an operation."""
    code = (
        str(error)
        if isinstance(error, Refused) and re.fullmatch("[A-Z0-9_]{1,120}", str(error))
        else type(error).__name__
    )
    try:
        binding = request["binding"]
        folder = component_folder(binding)
        target = folder / "failures"
        target.mkdir(mode=0o700, exist_ok=True)
        private(target, directory=True)
        ids = {
            k: v
            for k, v in request["context"].items()
            if k
            in ["context_id", "operation_id", "authorization_id", "qualification_id"]
            and isinstance(v, str)
            and re.fullmatch("[a-f0-9-]{36}", v)
        }
        write(
            target / (phase + "-" + str(time.time_ns()) + ".json"),
            {
                "candidate_commit": binding["candidate_commit"],
                "component": binding["component"],
                "phase": phase,
                "record_ids": ids,
                "failure_code": code,
                "observed_at": now().isoformat(),
                "provider_retry_allowed": False,
            },
        )
    except (Refused, KeyError, ValueError, TypeError, OSError):
        pass
    return code


API_ORIGINS = {
    "staging": "https://portal-api-staging.onesa.eu",
    "production": "https://portal-api.onesa.eu",
}
RETAINED_NAMES = {
    *TARGET.values(),
    "onesa-portal-oracle-staging-worker-1",
    "onesa-portal-oracle-production-worker-1",
    "onesa-portal-oracle-staging-scanner-1",
}
PUBLIC_SERVER_KEYS = {
    "ENGINEERING_SIGNIN_ENABLED",
    "ENGINEERING_ACCESS_CALLBACK_URL",
    "ACCESS_REGISTRATION_ENABLED",
}


def component_folder(binding):
    require(
        binding["repository"] == "DruHustle/onesa-company-portal"
        and binding["component"] == "frontend"
        and re.fullmatch("[a-f0-9]{40}", binding["candidate_commit"]),
        "PORTAL_FRONTEND_COMPONENT_SCOPE",
    )
    return private(
        ROOT / "frontend" / "artifacts" / binding["candidate_commit"], directory=True
    )


def probe_source_files(files):
    names = {
        "scripts/release/oracle_portal.py",
        "scripts/release/oracle_portal_frontend.py",
        "scripts/release/oracle_portal_browser.mjs",
        "scripts/release/oracle_frontend_build.py",
        "scripts/release/oracle_vercel_transport_guard.cjs",
        "scripts/check_tls_bundle.mjs",
        "scripts/oracle_backup_store.mjs",
        "onesa-company-portal-frontend/package.json",
        "onesa-company-portal-frontend/package-lock.json",
    }
    require(names <= set(files), "COMPLETE_COMMISSIONED_PROBE_SOURCE_REQUIRED")
    return {name: files[name] for name in sorted(names)}


def configuration_value(binding, plan, env):
    require(env in ENV, "FRONTEND_CONFIGURATION_SCOPE")
    return {
        "schema_version": 1,
        "repository": binding["repository"],
        "component": "frontend",
        "candidate_commit": binding["candidate_commit"],
        "environment": env,
        "project_id": plan["project_id"],
        "team_id": plan["team_id"],
        "origin": plan["origins"][env],
        "api_origin": API_ORIGINS[env],
        "api_routing_variable_id": plan["vercel_api_url_variable_ids"][env],
        "server_public_configuration": plan["server_public_configuration"][env],
        "server_public_variable_ids": plan["server_public_variable_ids"][env],
        "staging_proxy_variable_id": plan["staging_proxy_variable_id"]
        if env == "staging"
        else None,
        "staging_proxy_key_sha256": plan["staging_proxy_key_sha256"]
        if env == "staging"
        else None,
        "protection_sha256": plan["vercel_protection_sha256"],
        "environment_metadata_sha256": plan["environment_metadata_sha256"],
        "retained_frontend": plan["retained_frontend"],
        "source_comparison_baseline": plan.get(
            "source_comparison_baseline", plan["retained_frontend"]
        ),
        "qualified_builds_sha256": hashlib.sha256(
            canonical(plan["builds"])
        ).hexdigest(),
        "processing_scope": plan["processing_scope"],
        "privacy_decision": plan["privacy_decision"],
        "publication_controls_unchanged": plan["publication_controls_unchanged"],
        "physical_hardware_authorized": plan["physical_hardware_authorized"],
        "rollback": plan["rollback"],
        "serverless_function_region": "fra1",
        "project_default_region": "iad1",
        "retained_services_sha256": hashlib.sha256(
            canonical(plan["retained_services"])
        ).hexdigest(),
    }


def configuration_path(binding, env):
    require(
        env in ENV and re.fullmatch("[a-f0-9]{40}", binding["candidate_commit"]),
        "CONFIGURATION_PATH_SCOPE",
    )
    return (
        Path("/etc/onesa/backends/candidates")
        / binding["candidate_commit"]
        / ("portal-frontend-" + env + ".json")
    )


def source_equivalence(folder, binding, plan):
    baseline = plan.get("source_comparison_baseline", plan["retained_frontend"])
    require(
        re.fullmatch("[a-f0-9]{40}", baseline["source"])
        and re.fullmatch("[a-f0-9]{40}", baseline["source_tree"]),
        "ACCEPTED_FRONTEND_SOURCE_REQUIRED",
    )
    archive = private(folder / "baseline-source.tar")
    require(
        sha(archive) == baseline["source_sha256"], "BASELINE_SOURCE_ARCHIVE_CHANGED"
    )
    _, old = source_inventory(archive, {"source_tree": baseline["source_tree"]})
    _, new = source_inventory(folder / "source.tar", binding)
    prefix = "onesa-company-portal-frontend/"
    changed = {
        name
        for name in old.keys() | new.keys()
        if name.startswith(prefix) and old.get(name) != new.get(name)
    }
    permitted = {
        prefix + name
        for name in [
            "Dockerfile",
            "src/components/home-products.tsx",
            "src/config/products.ts",
            "src/components/product-overview.tsx",
            "src/components/responsive-link.tsx",
            "package.json",
            "public/brand/sources.json",
            "public/images/drone-cargo-1280.webp",
            "public/images/drone-cargo-640.webp",
            "public/images/drone-flight-1280.webp",
            "public/images/drone-flight-640.webp",
            "public/media/onesa-drone-concept.mp4",
            "scripts/test-drone-product.mjs",
            "src/app/[locale]/products/onesa-ai-drone/page.tsx",
            "src/app/[locale]/products/onesa-drone/page.tsx",
            "src/components/drone-film.tsx",
            "src/components/drone-image.tsx",
            "src/components/drone-product.module.css",
            "src/components/drone-product.tsx",
            "src/components/drone-visual.tsx",
            "src/components/site-footer.tsx",
            "src/config/enquiry-topics.ts",
            "src/lib/company-sitemap.ts",
        ]
    }
    package = prefix + "package.json"
    if package in changed:
        with (
            tarfile.open(archive, "r:") as before,
            tarfile.open(folder / "source.tar", "r:") as after,
        ):
            previous = json.load(before.extractfile(package))
            current = json.load(after.extractfile(package))
        expected = json.loads(json.dumps(previous))
        expected["scripts"]["test:drone-product"] = (
            "node scripts/test-drone-product.mjs"
        )
        require(
            current == expected, "PRODUCT_TEST_SCRIPT_ONLY_NO_RUNTIME_PACKAGE_CHANGE"
        )
    with tarfile.open(folder / "source.tar", "r:") as source:
        for name in changed & permitted:
            limit = (
                2 * 1024 * 1024
                if name.endswith(".mp4")
                else 256 * 1024
                if name.endswith(".webp")
                else None
            )
            if limit:
                require(
                    name in new and source.getmember(name).size <= limit,
                    "BOUNDED_LOCAL_PRODUCT_MEDIA_REQUIRED",
                )
    navigation = prefix + "src/components/responsive-link.tsx"
    if navigation in changed:
        with tarfile.open(archive, "r:") as baseline_source:
            previous = baseline_source.extractfile(navigation).read()
        require(
            previous.count(b"<Link {...props}>") == 1
            and new.get(navigation)
            == hashlib.sha256(
                previous.replace(
                    b"<Link {...props}>", b"<Link prefetch={false} {...props}>"
                )
            ).hexdigest(),
            "NAVIGATION_PREFETCH_CHANGE_ONLY",
        )
    require(
        changed and changed <= permitted,
        "PUBLIC_COPY_SCOPE_CHANGED_REQUIRES_FULL_REQUALIFICATION",
    )
    return {
        "baseline_source": baseline["source"],
        "changed_frontend_paths": sorted(changed),
        "authentication_and_hero_source_unchanged": True,
        "navigation_change": "default_speculative_prefetch_disabled_only"
        if navigation in changed
        else "unchanged",
        "new_full_business_acceptance_claimed": False,
        "product_presentation_requires_current_hosted_acceptance": True,
    }


def verify_browser_receipt(browser, binding, env):
    expected = {
        (engine, locale, width, mode)
        for engine in ["chromium", "firefox", "webkit"]
        for locale in ["en", "de"]
        for width, mode in [(390, "dark"), (1440, "light"), (320, "light")]
    }
    for field in ["views", "drone_views"]:
        rows = browser.get(field, [])
        require(
            isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            "BROWSER_VIEW_SCHEMA",
        )
        observed = {
            tuple(row.get(key) for key in ["engine", "locale", "width", "mode"])
            for row in rows
        }
        require(
            len(rows) == len(expected) and observed == expected,
            "COMPLETE_UNIQUE_BROWSER_MATRIX_REQUIRED",
        )
    require(
        browser.get("status") == "PASS"
        and browser.get("binding") == binding
        and browser.get("environment") == env
        and browser.get("engines") == ["chromium", "firefox", "webkit"]
        and all(
            row.get("robot_copy") == row.get("product_navigation") == "PASS"
            and row.get("horizontal_overflow") is False
            for row in browser["views"]
        )
        and all(
            all(
                row.get(key) == "PASS"
                for key in [
                    "presentation",
                    "deferred_media",
                    "keyboard_playback",
                    "interactive_concept",
                    "platform_link",
                ]
            )
            and row.get("accessibility_violations") == 0
            and row.get("horizontal_overflow") is False
            for row in browser["drone_views"]
        )
        and all(
            browser.get(key) == 0
            for key in [
                "operational_mutations",
                "javascript_errors",
                "accessibility_violations",
                "speculative_prefetches",
            ]
        ),
        "GENUINE_HOSTED_BROWSER_RECEIPT_REQUIRED",
    )


def validate_plan(binding):
    plan = read(PLAN)
    require(
        plan["schema_version"] == 1
        and plan["binding"] == binding
        and plan["api_origins"] == API_ORIGINS
        and plan["origins"]["production"] == "https://onesa.eu"
        and re.fullmatch(
            r"https://onesa-company-portal-git-staging-[a-z0-9-]+\.vercel\.app",
            plan["origins"]["staging"],
        )
        and plan["serverless_function_region"] == "fra1"
        and plan["project_default_region"] == "iad1",
        "OWNER_PORTAL_PLAN_SCOPE",
    )
    verify_toolchain(plan, binding)
    folder = component_folder(binding)
    require(
        sha(private(folder / "source.tar")) == binding["source_sha256"],
        "SOURCE_ARCHIVE_DIGEST",
    )
    source_inventory(folder / "source.tar", binding)
    source_equivalence(folder, binding, plan)
    for env in ENV:
        config = private(configuration_path(binding, env))
        require(
            sha(config) == binding["configuration_sha256"][env]
            and read(config) == configuration_value(binding, plan, env),
            "FRONTEND_TARGET_CONFIGURATION_CHANGED",
        )
    validate_frontend_builds(folder, binding, plan)
    verify_probe_bytes(folder, binding, plan)
    return folder, plan


def retained_services(plan):
    require(
        set(plan["retained_services"]) == RETAINED_NAMES,
        "RETAINED_PORTAL_COMPONENT_SET",
    )
    current = inventory()
    for name, expected in plan["retained_services"].items():
        require(
            name in current
            and healthy(current[name])
            and summary(current[name]) == expected,
            "RETAINED_SERVICE_CHANGED_OR_UNHEALTHY",
        )
    for env in ENV:
        row = current[TARGET[env]]
        values = dict(item.split("=", 1) for item in row["Config"]["Env"])
        require(
            values.get("PUBLICATION_STAGE") == "prelaunch",
            "EXISTING_PUBLICATION_DEFERRAL_CHANGED",
        )
    return {name: summary(current[name]) for name in sorted(RETAINED_NAMES)}


def http_read(origin, path, expected, bypass=None, *, json_body=True):
    require(
        origin.startswith("https://") and path.startswith("/") and ".." not in path,
        "SCOPED_HTTPS_OBSERVATION_REQUIRED",
    )
    headers = {"User-Agent": "OnesaOwnerOracleRelease/1.0"}
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    request = urllib.request.Request(origin + path, headers=headers)
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        require(
            response.status == expected, "HOSTED_HTTP_STATUS_" + str(response.status)
        )
        raw = response.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, "HOSTED_RESPONSE_BOUND")
        if not json_body:
            return {
                "status": response.status,
                "location": response.headers.get("location"),
                "bytes": len(raw),
            }
        return json.loads(raw) if raw else None


def readiness_and_denials(plan, env, observation=None):
    origin = API_ORIGINS[env]
    require(
        http_read(origin, "/api/v1/health", 200) == {"status": "ok"},
        "RETAINED_API_LIVENESS",
    )
    require(
        http_read(origin, "/api/v1/ready", 200) == {"status": "ready"},
        "RETAINED_DATABASE_READINESS",
    )
    paths = [
        "/api/v1/auth/me",
        "/api/v1/admin/content",
        "/api/v1/admin/governance/records",
    ]
    for path in paths:
        http_read(origin, path, 401)
    company = http_read(origin, "/api/v1/public/company", 200)
    require(
        company["publication_stage"] == "prelaunch",
        "PUBLICATION_DECISION_NOT_PRESERVED",
    )
    if observation:
        frontend_origin = (
            "https://portal.onesa.eu" if env == "production" else observation["origin"]
        )
        require(
            http_read(frontend_origin, "/api/v1/ready", 200, observation["bypass"])
            == {"status": "ready"},
            "ACTUAL_FRONTEND_API_BINDING",
        )
        for path in paths:
            http_read(frontend_origin, path, 401, observation["bypass"])
        if env == "production":
            require(
                observation["origin"] == "https://onesa.eu",
                "EXACT_COMPANY_SURFACE_REQUIRED",
            )
            for path in ["/api/v1/health", "/api/v1/ready", *paths]:
                http_read(observation["origin"], path, 403)
    return {
        "database_readiness": "PASS",
        "private_anonymous_denials": len(paths) * (2 if observation else 1),
        "company_surface_denials": 5 if observation and env == "production" else 0,
        "publication_stage": company["publication_stage"],
        "production_mutations": 0,
    }


def preflight(binding):
    folder, plan = validate_plan(binding)
    retained_services(plan)
    import oracle_portal_frontend as frontend

    project = frontend.protection(plan)
    require(
        project["targets"]["production"]["id"]
        == plan["retained_frontend"]["deployment_id"],
        "CONCURRENT_FRONTEND_PUBLICATION_PRESERVED",
    )
    for env in ENV:
        readiness_and_denials(plan, env)
    probe_cpu_limit()
    require(shutil.disk_usage("/").free > 8 * 1024**3, "EXISTING_HOST_DISK_CAPACITY")
    return {
        "status": "PREFLIGHT_READY_NOT_QUALIFIED",
        "candidate_commit": binding["candidate_commit"],
        "component": "frontend",
        "source_scope": source_equivalence(folder, binding, plan),
        "provider_requests": 0,
        "accounts_changed": False,
    }


def probe(binding, env, operation, folder, plan):
    import oracle_portal_frontend as frontend

    output = folder / "observations" / operation
    output.mkdir(mode=0o700, exist_ok=False)
    before = inventory()
    retained = retained_services(plan)
    observation = frontend.observe_provider(binding, env, plan, operation)
    api = readiness_and_denials(plan, env, observation)
    request = output / "browser-request.json"
    write(
        request,
        {
            "binding": binding,
            "environment": env,
            "origin": observation["origin"],
            "bypass": observation["bypass"],
            "provider_token_included": False,
        },
    )
    try:
        with (
            (output / "browser.stdout").open("xb") as out,
            (output / "browser.stderr").open("xb") as err,
        ):
            os.chmod(out.name, 0o600)
            os.chmod(err.name, 0o600)
            result = subprocess.run(
                [
                    "/usr/bin/docker",
                    "run",
                    "--rm",
                    "--read-only",
                    "--tmpfs",
                    "/tmp:rw,size=512m",
                    "--tmpfs",
                    "/root:rw,mode=700,size=64m",
                    "--tmpfs",
                    "/var/tmp:rw,noexec,nosuid,nodev,mode=1777,size=32m",
                    "--memory",
                    "1400m",
                    "--cpus",
                    probe_cpu_limit(),
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges:true",
                    "-v",
                    str(request) + ":/private/request.json:ro",
                    "-v",
                    str(output) + ":/private/output:rw",
                    "--entrypoint",
                    "node",
                    plan["probe_image"],
                    "/opt/onesa-company-portal/scripts/release/oracle_portal_browser.mjs",
                    "/private/request.json",
                ],
                stdout=out,
                stderr=err,
                timeout=900,
                check=False,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
    finally:
        request.unlink(missing_ok=True)
    require(result.returncode == 0, "HOSTED_BROWSER_FAILED_INSPECT_PRIVATE_EVIDENCE")
    browser = read(output / "browser-receipt.json")
    verify_browser_receipt(browser, binding, env)
    retained_services(plan)
    unchanged(before, inventory())
    value = {
        "status": "PASS",
        "binding": binding,
        "environment": env,
        "operation_id": operation,
        "observed_at": now().isoformat(),
        "api": api,
        "browser": browser,
        "source_scope": source_equivalence(folder, binding, plan),
        "retained_services": retained,
        "physical_hardware_authorized": False,
        "production_mutations": 0,
        "schema_migrations": 0,
        "existing_data_components_unchanged": True,
    }
    write(output / "receipt.json", value)
    return value


def container_readable_transport(script, expected, folder):
    """Expose public source bytes to the unprivileged, read-only container only."""
    private(Path(folder), uid=os.geteuid(), directory=True)
    target = Path(folder) / "backup.mjs"
    write_raw(target, script.read_bytes())
    require(sha(target) == expected, "BACKUP_TRANSPORT_COPY_SOURCE_CHANGED")
    os.chmod(target, 0o444)
    return target


def inspect_database_backup(receipt, plan):
    profile = plan["legacy_backup"]
    require(
        profile["transport_path"]
        == str(Path(__file__).resolve().with_name("oracle_backup_store.mjs"))
        and profile["transport_sha256"]
        == trusted_toolchain(plan)["probe_files"]["scripts/oracle_backup_store.mjs"],
        "BACKUP_TRANSPORT_DIFFERS_FROM_COMMISSIONED_SOURCE",
    )
    script = pinned_public_file(
        Path(profile["transport_path"]), profile["transport_sha256"]
    )
    require(
        sha(script) == profile["transport_sha256"]
        and json.loads(docker("image", "inspect", profile["transport_image"]))[0]["Id"]
        == profile["transport_image"],
        "ESTABLISHED_BACKUP_TRANSPORT_CHANGED",
    )
    public = Path("/etc/onesa/recovery-public.pem")
    require(
        not public.is_symlink()
        and public.stat().st_uid == 0
        and not public.stat().st_mode & 0o022
        and sha(public) == profile["key_id"] == receipt["key_id"],
        "RECOVERY_PUBLIC_KEY_CHANGED",
    )
    require(
        receipt["passed"] is True
        and receipt["off_instance_storage_verified"] is True
        and re.fullmatch(
            r"\.onesa-portal-backups/v1/[a-f0-9]{32}\.json",
            receipt["object_key"],
        ),
        "PORTAL_BACKUP_IDENTITY",
    )
    values = runtime_values(Path(profile["transport_env"]))
    keys = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "S3_ENDPOINT",
        "S3_REGION",
        "S3_BUCKET",
    ]
    selected = {k: values[k] for k in keys if k in values}
    require(
        {
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "S3_ENDPOINT",
            "S3_REGION",
            "S3_BUCKET",
        }
        <= set(selected),
        "EXISTING_PORTAL_BACKUP_S3_CUSTODY",
    )
    with tempfile.TemporaryDirectory(prefix=".backup-readback-", dir=ROOT) as folder:
        transport = container_readable_transport(
            script, profile["transport_sha256"], folder
        )
        env = Path(folder) / "transport.env"
        with os.fdopen(
            os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600),
            "w",
        ) as f:
            f.write("".join(k + "=" + v + "\n" for k, v in selected.items()))
        objects = [
            (receipt["object_key"], receipt["ciphertext_sha256"]),
            (profile["escrow_object"], profile["escrow_ciphertext_sha256"]),
        ]
        for key, expected in objects:
            require(
                re.fullmatch(
                    r"\.onesa-portal-backups/v1/(?:[a-f0-9]{32}\.json|keys/[a-f0-9]{64}\.enc)",
                    key,
                ),
                "ESTABLISHED_BACKUP_OBJECT_SCOPE",
            )
            raw = docker(
                "run",
                "--rm",
                "-i",
                "--pull=never",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--memory",
                "256m",
                "--cpus",
                "0.1",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--env-file",
                str(env),
                "-v",
                str(transport) + ":/app/backup.mjs:ro",
                "--entrypoint",
                "node",
                profile["transport_image"],
                "/app/backup.mjs",
                data=canonical({"action": "read", "key": key}),
                timeout=90,
            )
            require(
                hashlib.sha256(raw).hexdigest() == expected,
                "BACKUP_OR_ESCROW_CIPHERTEXT_DIFFERS",
            )
    return {
        "database_ciphertext_sha256": receipt["ciphertext_sha256"],
        "key_id": receipt["key_id"],
        "escrow_ciphertext_sha256": profile["escrow_ciphertext_sha256"],
        "actual_off_instance_readback": "PASS",
        "key_custody_changed": False,
        "production_restore_performed": False,
    }


def verify_rollback_frontend(plan):
    import oracle_portal_frontend as frontend

    rollback = plan["rollback"].get("frontend", plan["retained_frontend"])
    old = frontend.provider("/v13/deployments/" + rollback["deployment_id"])
    require(
        old["id"] == rollback["deployment_id"]
        and old["projectId"] == plan["project_id"]
        and old["readyState"] == "READY"
        and old["meta"]["githubCommitSha"] == rollback["source"],
        "RETAINED_FRONTEND_ROLLBACK_ARTIFACT_REQUIRED",
    )
    return {"deployment_id": old["id"], "source": rollback["source"]}


def operational_observations(binding, plan, folder, context_id):
    metrics = read(Path("/var/lib/onesa/operations/metrics.json"))
    require(
        metrics["simulation"] is False
        and not metrics["alerts"]
        and not metrics.get("notification_pending")
        and not metrics.get("notification_reconciliation_required"),
        "UNRESOLVED_OPERATIONS_ALERT",
    )
    require(
        dt.timedelta(0)
        <= now() - dt.datetime.fromisoformat(metrics["checked_at"])
        < dt.timedelta(minutes=5),
        "OPERATIONS_SAMPLE_STALE",
    )
    values = metrics["metrics"]
    require(
        values["database_available"]
        and not values["database_backup_failed"]
        and values["memory_available_bytes"] > 2 * 1024**3
        and values["disk_used_percent"] < 80,
        "OPERATIONS_CAPACITY",
    )
    for timer in ["onesa-portal-backup.timer", "onesa-portal-monitor.timer"]:
        require(
            command(["/usr/bin/systemctl", "is-active", timer]).strip() == b"active",
            "EXISTING_TIMER_INACTIVE",
        )
    backup = read(Path("/var/lib/onesa/operations/backup-success.json"))
    require(
        backup["consistent_snapshot"] is True
        and backup["passed"] is True
        and dt.timedelta(0)
        <= now() - dt.datetime.fromisoformat(backup["verified_at"])
        < dt.timedelta(hours=36),
        "PORTAL_BACKUP_STALE_OR_FAILED",
    )
    readback = inspect_database_backup(backup, plan)
    stage = read(folder / "observations" / context_id / "receipt.json")
    require(
        stage["binding"] == binding
        and stage["status"] == "PASS"
        and stage["schema_migrations"] == 0
        and stage["existing_data_components_unchanged"] is True,
        "GENUINE_STAGING_PRESERVATION_REQUIRED",
    )
    retained_services(plan)
    rollback = verify_rollback_frontend(plan)
    require(
        plan["processing_scope"] == "existing-public-presentation-no-new-processing"
        and plan["privacy_decision"] == "G14_DEFERRED_BY_OWNER_PRELAUNCH"
        and plan["publication_controls_unchanged"] is True
        and plan["physical_hardware_authorized"] is False
        and plan["rollback"]["automatic"] is False
        and plan["rollback"]["mode"]
        == "restore-previous-frontend-retain-data-components",
        "OWNER_PUBLICATION_OR_RECOVERY_SCOPE",
    )
    return {
        "checks": {k: "PASS" for k in CHECKS["operations"]},
        "backup_readback": readback,
        "retained_rollback_frontend": rollback,
        "backup_verified_at": backup["verified_at"],
        "staging_receipt_sha256": sha(
            folder / "observations" / context_id / "receipt.json"
        ),
        "persistence_scope": "unchanged-accepted-api-worker-scanner-retained",
        "new_database_restore_performed": False,
        "schema_migrations": 0,
        "rollback_deployment_id": rollback["deployment_id"],
        "privacy_status": plan["privacy_decision"],
        "physical_hardware_authorized": False,
    }


def public_server_configuration(plan, env):
    values = plan["server_public_configuration"][env]
    require(
        set(values) == PUBLIC_SERVER_KEYS
        and all(
            isinstance(value, str) and len(value) <= 2048 for value in values.values()
        ),
        "PUBLIC_SERVER_CONFIGURATION_SHAPE",
    )
    require(
        values["ENGINEERING_SIGNIN_ENABLED"] in {"true", "false"}
        and values["ACCESS_REGISTRATION_ENABLED"] in {"true", "false"},
        "EXISTING_FEATURE_FLAG_VALUE_REQUIRED",
    )
    callback = values["ENGINEERING_ACCESS_CALLBACK_URL"]
    if callback:
        url = urllib.parse.urlsplit(callback)
        require(
            url.scheme == "https"
            and url.username is None
            and url.password is None
            and not url.query
            and not url.fragment
            and url.port is None
            and re.fullmatch(r"[-a-z0-9]+\.cloudflareaccess\.com", url.hostname or "")
            and url.path == "/cdn-cgi/access/callback",
            "EXISTING_CALLBACK_SCOPE_REQUIRED",
        )
    return values
