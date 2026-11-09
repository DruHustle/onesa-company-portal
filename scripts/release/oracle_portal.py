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
INSTALL_PARENT = Path("/usr/local/lib/onesa-release")
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


CANONICAL_REPOSITORY = "DruHustle/onesa-ug"
PORTAL_SOURCE_FIELDS = {
    "schema_version", "repository", "repository_id", "product", "source_path",
    "candidate_commit", "source_tree", "product_source_tree", "branch",
}
PORTAL_COMPONENTS = {"frontend", "api", "worker", "scanner", "identity", "identity-acceptance"}
SOURCE_ARCHIVES = {
    "portal-runtime-onesa-company-portal-backend",
    "portal-runtime-onesa-company-portal-frontend", "portal-runtime-clamav",
}


def portal_source_binding(binding):
    # The credential-free tar reader never loads an owner module or private Store.
    require(isinstance(binding, dict) and PORTAL_SOURCE_FIELDS <= set(binding),
            "COMPLETE_CANONICAL_PORTAL_SOURCE_REQUIRED")
    source = {key: binding[key] for key in PORTAL_SOURCE_FIELDS}
    require(type(source["schema_version"]) is int and source["schema_version"] == 2
            and source["repository"] == CANONICAL_REPOSITORY
            and type(source["repository_id"]) is int and source["repository_id"] == 1444746154
            and source["product"] == "portal" and source["source_path"] == "onesa-company-portal"
            and source["branch"] == "main" and binding.get("component", "frontend") in PORTAL_COMPONENTS
            and all(isinstance(source[key], str) and re.fullmatch(r"[a-f0-9]{40}", source[key])
                    for key in ("candidate_commit", "source_tree", "product_source_tree")),
            "CANONICAL_PORTAL_COMPONENT_SOURCE_SCOPE")
    return source


def portal_component_scope(binding, component=None):
    selected = binding.get("component")
    require(selected in PORTAL_COMPONENTS and (component is None or selected == component),
            "PORTAL_COMPONENT_SCOPE")
    if binding.get("repository") == CANONICAL_REPOSITORY:
        portal_source_binding(binding)
        return CANONICAL_REPOSITORY + ":portal:" + selected
    require(binding.get("repository") == "DruHustle/onesa-company-portal",
            "PORTAL_COMPONENT_REPOSITORY")
    return binding["repository"] + ":" + selected


def component_plan_path(binding, legacy_path):
    portal_component_scope(binding)
    if binding["repository"] == CANONICAL_REPOSITORY:
        return legacy_path.with_name(legacy_path.stem + "-canonical.json")
    return legacy_path


def component_plan_fields(binding, fields):
    return [*fields, *(["source_binding"] if binding.get("repository") == CANONICAL_REPOSITORY else [])]


def component_plan_source(binding, plan, component):
    portal_component_scope(binding, component)
    consolidated = binding["repository"] == CANONICAL_REPOSITORY
    require(type(plan.get("schema_version")) is int
            and plan["schema_version"] == (2 if consolidated else 1), "PORTAL_COMPONENT_PLAN_VERSION")
    if consolidated:
        require(plan.get("source_binding") == portal_source_binding(binding),
                "CANONICAL_COMPONENT_PLAN_SOURCE")
    return True


def component_artifact_folder(root, binding):
    portal_component_scope(binding)
    if binding["repository"] == CANONICAL_REPOSITORY:
        root /= "canonical-portal"
    return root / "artifacts" / binding["source_tree"]


def build_source_fields(binding):
    fields = {"repository", "component", "candidate_commit", "source_tree", "source_sha256", "artifact_digest"}
    if binding.get("repository") == CANONICAL_REPOSITORY:
        portal_source_binding(binding)
        fields |= PORTAL_SOURCE_FIELDS
    return fields


def canonical_install_files(component):
    """Fixed backend closures mirror the independently source-checked installer."""
    require(component in PORTAL_COMPONENTS - {"frontend"}, "CANONICAL_BACKEND_COMPONENT_SCOPE")
    names = {"oracle_portal.py", "oracle_backup_store.mjs", "oracle_portal_frontend.py",
             "oracle_portal_browser.mjs", "oracle_portal_browser_session.mjs",
             "oracle_frontend_build.py", "oracle_vercel_transport_guard.cjs",
             "oracle_portal_scanner.py", "oracle_portal_scanner_workflow.py",
             "oracle_portal_scanner_workflows.mjs", "oracle_portal_worker_fixture.mjs",
             "oracle_portal_worker_probe.mjs", "oracle_portal_worker_smtp.mjs"}
    if component in {"worker", "identity", "identity-acceptance"}:
        names |= {"oracle_portal_worker.py", "oracle_portal_worker_production.mjs"}
    if component in {"api", "identity", "identity-acceptance"}:
        names |= {"oracle_portal_api.py", "oracle_portal_api_production.mjs",
                  "oracle_portal_api_recovery.py", "oracle_portal_worker_production.mjs"}
    if component in {"identity", "identity-acceptance"}:
        names |= {"oracle_portal_identity.py", "oracle_portal_identity_migrate.mjs",
                  "oracle_portal_identity_restore.py", "oracle_portal_identity_acceptance.py",
                  "oracle_portal_identity_browser.mjs", "oracle_portal_identity_mail.mjs",
                  "restore_lockdown.py", "restore_replay.py", "oracle_backup_open.mjs"}
    result = {name: "scripts/release/" + name for name in
              ("oracle_owner.py", "runtime_lifecycle.py", "oracle_install.py")}
    result.update({"runners/" + name:
                   ("scripts/" if name in {"oracle_backup_store.mjs", "oracle_backup_open.mjs"}
                    else "scripts/release/") + name for name in names})
    return result


def verify_canonical_component_custody(binding, plan, checks):
    """A new source identity cannot inherit a legacy installation or its runners."""
    if binding.get("repository") != CANONICAL_REPOSITORY:
        return
    source = portal_source_binding(binding)
    scope = portal_component_scope(binding)
    component = binding["component"]
    files = canonical_install_files(component)
    directory = VERIFIER.parent
    require(directory == INSTALL_PARENT /
            ("portal-" + component + "-canonical-" + source["source_tree"]),
            "CANONICAL_COMPONENT_INSTALLATION_PATH")
    store = private(Path(plan["verifier_store"]), directory=True)
    trust = read(store / "trust.json")
    require(sha(private(store / "policy.json")) == trust["policy_sha256"], "CANONICAL_POLICY_CHANGED")
    policy = read(store / "policy.json")
    tool = policy["toolchain"]
    receipt = read(private(directory / "installation.json"))
    require(type(policy.get("schema_version")) is int and policy["schema_version"] == 2
            and set(policy["components"]) == {scope}
            and tool.get("source_binding") == source
            and tool.get("source_commit") == source["candidate_commit"]
            and tool.get("source_tree") == source["source_tree"]
            and tool.get("source_sha256") == binding["source_sha256"]
            and receipt.get("source_binding") == source
            and receipt.get("state") == "INSTALLED_NOT_COMMISSIONED"
            and receipt.get("source") == source["candidate_commit"]
            and receipt.get("source_tree") == source["source_tree"]
            and receipt.get("policy_sha256") == trust["policy_sha256"]
            and set(receipt.get("files", {})) == set(files),
            "CANONICAL_COMPONENT_INSTALLATION_CUSTODY")
    profile = policy["components"][scope]
    require(type(profile.get("qualification_attempt_limit")) is int
            and profile["qualification_attempt_limit"] == 1
            and set(profile["runners"]) == set(checks)
            and all(set(required) <= set(profile["required_checks"][phase])
                    for phase, required in checks.items()), "CANONICAL_COMPONENT_CHECKS_REQUIRED")
    script = "oracle_portal_" + component.replace("-", "_") + ".py"
    path = directory / "runners" / script
    require(all(item["path"] == str(path) and item["sha256"] == receipt["files"]["runners/" + script]
                for item in profile["runners"].values()), "CANONICAL_COMPONENT_RUNNER_PIN")
    archive = private(directory / "tool-source.tar")
    require(sha(archive) == tool["source_sha256"], "CANONICAL_TOOL_SOURCE_CHANGED")
    _, upstream = source_inventory(archive, source)
    for local, original in files.items():
        require(receipt["files"][local] == upstream[original]
                and sha(private(directory / local)) == upstream[original],
                "CANONICAL_COMPONENT_HELPER_CHANGED")
    pins = tool.get("source_archives")
    require(isinstance(pins, dict) and set(pins) == SOURCE_ARCHIVES,
            "CANONICAL_COMPONENT_CI_ARCHIVES_REQUIRED")
    for name, pin in pins.items():
        artifact = private(directory / "source-artifacts" / (name + ".zip"))
        require(0 < artifact.stat().st_size <= 24 * 1024
                and isinstance(pin, str) and re.fullmatch(r"[a-f0-9]{64}", pin)
                and sha(artifact) == pin, "CANONICAL_COMPONENT_CI_ARCHIVE_CHANGED")


def frontend_component_scope(binding):
    require(binding.get("component") == "frontend"
            and binding.get("repository") in {CANONICAL_REPOSITORY, "DruHustle/onesa-company-portal"},
            "PORTAL_FRONTEND_COMPONENT_SCOPE")
    return portal_component_scope(binding, "frontend")


def frontend_provider_root(binding=None):
    if binding and binding.get("repository") == CANONICAL_REPOSITORY:
        frontend_component_scope(binding)
        return "onesa-company-portal/onesa-company-portal-frontend"
    return "onesa-company-portal-frontend"


def frontend_source_identity(binding):
    fields = {"repository", "candidate_commit", "source_tree", "source_sha256"}
    if binding.get("repository") == CANONICAL_REPOSITORY:
        frontend_component_scope(binding)
        fields |= PORTAL_SOURCE_FIELDS | {"component", "target_environment"}
    return {key: binding[key] for key in fields}


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


def historical_verifier(binding, store, trust):
    """Read the original installation; never load its code or open its Store."""
    scope = portal_component_scope(binding)
    component = binding["component"]
    require(component in {"api", "worker", "scanner"}
            and binding.get("target_environment") == "production",
            "HISTORICAL_PORTAL_JOURNAL_SCOPE")
    policy = read(store / "policy.json")
    tool = policy.get("toolchain")
    require(isinstance(tool, dict) and isinstance(policy.get("components"), dict),
            "HISTORICAL_COMPONENT_POLICY_REQUIRED")
    consolidated = binding["repository"] == CANONICAL_REPOSITORY
    require(type(policy.get("schema_version")) is int
            and policy["schema_version"] == (2 if consolidated else 1)
            and set(policy["components"]) == {scope}
            and all(isinstance(tool.get(key), str)
                    and re.fullmatch(r"[a-f0-9]{40}", tool[key])
                    for key in ("source_commit", "source_tree"))
            and isinstance(tool.get("source_sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", tool["source_sha256"]),
            "HISTORICAL_COMPONENT_POLICY_SCOPE")
    source = {"repository": binding["repository"],
              "candidate_commit": tool["source_commit"], "source_tree": tool["source_tree"]}
    if consolidated:
        source = portal_source_binding(binding)
        require(tool.get("source_binding") == source
                and tool["source_commit"] == source["candidate_commit"]
                and tool["source_tree"] == source["source_tree"]
                and tool["source_sha256"] == binding["source_sha256"],
                "HISTORICAL_CANONICAL_SOURCE_CHANGED")
    directory = private(INSTALL_PARENT / ("portal-" + component
                        + ("-canonical-" if consolidated else "-")
                        + tool["source_tree"]), directory=True)
    require(trust.get("runner_root") == str(directory / "runners")
            and sha(private(directory / "policy.json")) == trust["policy_sha256"],
            "HISTORICAL_INSTALLATION_POLICY_CHANGED")
    receipt = read(directory / "installation.json")
    mapping = canonical_install_files(component)
    files = receipt.get("files")
    required = {"oracle_owner.py", "oracle_install.py", "runners/oracle_portal.py",
                "runners/oracle_portal_" + component + ".py"}
    require(receipt.get("state") == "INSTALLED_NOT_COMMISSIONED"
            and receipt.get("repository") == binding["repository"]
            and receipt.get("source") == tool["source_commit"]
            and receipt.get("source_tree") == tool["source_tree"]
            and receipt.get("policy_sha256") == trust["policy_sha256"]
            and type(receipt.get("provider_requests")) is int
            and receipt["provider_requests"] == 0
            and (not consolidated or receipt.get("source_binding") == source)
            and isinstance(files, dict) and required <= set(files) <= set(mapping),
            "HISTORICAL_INSTALLATION_RECEIPT_CHANGED")
    profile = policy["components"][scope]
    script = "runners/oracle_portal_" + component + ".py"
    require(set(profile["runners"]) == set(CHECKS)
            and all(item["path"] == str(directory / script)
                    and item["sha256"] == files[script]
                    for item in profile["runners"].values()),
            "HISTORICAL_COMPONENT_RUNNER_CHANGED")
    archive = private(directory / "tool-source.tar")
    require(sha(archive) == tool["source_sha256"], "HISTORICAL_TOOL_SOURCE_CHANGED")
    _, upstream = source_inventory(archive, source)
    # Older installations retain their own closure. They need not contain
    # helpers added later, and no retained helper is imported or executed here.
    for local, pin in files.items():
        require(isinstance(pin, str) and re.fullmatch(r"[a-f0-9]{64}", pin)
                and pin == upstream.get(mapping[local])
                and sha(private(directory / local)) == pin,
                "HISTORICAL_INSTALLED_HELPER_CHANGED")
    verifier = private(directory / "oracle_owner.py")
    require(files["oracle_owner.py"] == trust["verifier_sha256"],
            "HISTORICAL_VERIFIER_CUSTODY_CHANGED")
    return verifier


def verify_historical_operation(binding, operation_id, store, *, require_accepted=True):
    """Only inspect retained shared journals; this entry point issues no authority.

    The scanner alone may inspect a completed, explicitly revoked request before
    its separate exact provider-result and signed-revocation checks. Current
    staging/deployment invocations always retain the current verifier pin.
    """
    require(type(require_accepted) is bool
            and (require_accepted or binding.get("component") == "scanner"),
            "HISTORICAL_ACCEPTANCE_SCOPE")
    return _verify_invocation(
        binding, {"operation_id": operation_id, "read_only": True}, "production",
        {"verifier_store": store}, dependency=require_accepted, historical_custody=True,
    )


def verify_invocation(binding, context, phase, plan, *, dependency=False):
    return _verify_invocation(binding, context, phase, plan, dependency=dependency)


def _verify_invocation(binding, context, phase, plan, *, dependency=False,
                       historical_custody=False):
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
        and sha(store / "policy.json") == trust["policy_sha256"],
        "ISSUER_CUSTODY_PIN_CHANGED",
    )
    verifier = historical_verifier(binding, store, trust) if historical_custody else VERIFIER
    require(sha(verifier) == trust["verifier_sha256"], "ISSUER_CUSTODY_PIN_CHANGED")
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

    expected_tree = binding["source_tree"]
    if binding.get("repository") == CANONICAL_REPOSITORY:
        expected_tree = portal_source_binding(binding)["product_source_tree"]
    require(
        git_tree(tree).hex() == expected_tree,
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
    scope = frontend_component_scope(binding)
    require(
        binding["target_environment"] == "production",
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
    profile = policy["components"].get(scope)
    require(
        profile and profile["qualification_attempt_limit"] == 1,
        "COMPONENT_NOT_COMMISSIONED_WITH_ONE_CONTEXT",
    )
    require(
        qualification_profile(plan) == qualification_profile(profile),
        "COMMISSIONED_FRONTEND_PROFILE_CHANGED",
    )
    require(
        all(
            profile_checks(plan, phase) <= set(profile["required_checks"][phase])
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
    if binding["repository"] == CANONICAL_REPOSITORY:
        source = portal_source_binding(binding)
        require(policy.get("schema_version") == 2
                and policy["toolchain"].get("source_binding") == source
                and installation.get("source_binding") == source
                and policy["toolchain"]["source_tree"] == binding["source_tree"]
                and policy["toolchain"]["source_sha256"] == binding["source_sha256"],
                "CANONICAL_COMPONENT_SOURCE_NOT_COMMISSIONED")
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
        if binding.get("repository") == CANONICAL_REPOSITORY:
            require(frontend_source_identity(receipt["binding"]) == frontend_source_identity(binding),
                    "CANONICAL_BUILD_SOURCE_IDENTITY")
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
        set(expected)
        == set(
            probe_source_files(
                {k: "" for k in expected}, qualification_profile(plan)
            )
        ),
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
    frontend_component_scope(binding)
    require(
        re.fullmatch("[a-f0-9]{40}", binding["candidate_commit"]),
        "PORTAL_FRONTEND_COMPONENT_SCOPE",
    )
    directory = ROOT / "frontend"
    if binding["repository"] == CANONICAL_REPOSITORY:
        directory /= "canonical-portal"
    return private(directory / "artifacts" / binding["candidate_commit"], directory=True)


PRESENTATION_PROFILE = "presentation-v1"
NVIDIA_PROFILE = "frontend-nvidia-v1"
IDENTITY_PROFILE = "frontend-identity-v1"
NVIDIA_PREFIX = "onesa-company-portal-frontend/"
NVIDIA_CATALOG = NVIDIA_PREFIX + "public/models/nvidia/manifest.json"
NVIDIA_LICENSE = NVIDIA_PREFIX + "public/licenses/three.txt"
NVIDIA_PROXY_CHANGES = (
    (
        b'import {surface,routeDestination,applicationOrigin} from "./lib/domains";\n',
        b'import {surface,routeDestination,applicationOrigin} from "./lib/domains";\n'
        b'import nvidiaCatalog from "./config/nvidia-reference-assets.json";\n'
        b'const nvidiaModelPaths = new Set(nvidiaCatalog.assets.map(asset => `/models/nvidia/${asset.glb.path}`));\n',
    ),
    (
        b'  response.headers.set("Cache-Control", "private, no-store");\n',
        b'  const revalidateNvidiaModel = ["GET", "HEAD"].includes(request.method) && request.nextUrl.search === "" && !request.url.includes("?") && nvidiaModelPaths.has(request.nextUrl.pathname);\n'
        b'  response.headers.set("Cache-Control", revalidateNvidiaModel ? "private, no-cache" : "private, no-store");\n',
    ),
)
NVIDIA_DEPENDENCY_PINS = {
    NVIDIA_PREFIX + "package-lock.json": "a14df9606964f633c89d4237cb99b182767f6dbd47adfde92835f2b0d96bd4f1",
    NVIDIA_PREFIX + "vendor/onesa-portal-minimatch-callable-1.0.0.tgz": "c532a6f7105c1934d4b0852881a59b981dd68217663debdee1a919a9a9de493c",
}
NVIDIA_DRONE_LAYOUT = NVIDIA_PREFIX + "src/components/drone-product.module.css"
# Close the measured DE/320px/200%-text correction over the exact reviewed
# stylesheet; this profile cannot accept another display change under its name.
NVIDIA_DRONE_LAYOUT_SHA256 = "4bac1e38ccf8f481005de7143f1c1a89f21b0a5b49c34c192a348e6cb912beb7"
NVIDIA_DRONE_DIAGNOSTIC_TEST = NVIDIA_PREFIX + "scripts/test-drone-product.mjs"
NVIDIA_DRONE_DIAGNOSTIC_TEST_SHA256 = "3bea2bb2b51e6747df223101970218c080b10fcc3c4d1ac719a61cc164a40d3f"
NVIDIA_DRONE_DIAGNOSTIC_HELPER = NVIDIA_PREFIX + "scripts/drone-product-diagnostics.mjs"
NVIDIA_DRONE_DIAGNOSTIC_UNIT = NVIDIA_PREFIX + "unit/drone-product-diagnostics.test.mjs"
# Two complete reviewed variants, not independent per-file alternatives. Keep
# these local: NVIDIA installations do not import the identity-profile helper.
NVIDIA_DRONE_DIAGNOSTIC_VARIANTS = (
    (
        "node scripts/test-drone-product.mjs",
        ((NVIDIA_DRONE_DIAGNOSTIC_TEST, NVIDIA_DRONE_DIAGNOSTIC_TEST_SHA256),
         (NVIDIA_DRONE_DIAGNOSTIC_HELPER, None), (NVIDIA_DRONE_DIAGNOSTIC_UNIT, None)),
    ),
    (
        "node --test unit/drone-product-diagnostics.test.mjs && node scripts/test-drone-product.mjs",
        ((NVIDIA_DRONE_DIAGNOSTIC_TEST, "6533b4c8dc26f76bb92848476394a07ccabcca9d78e3935295f2dfbd80cd6d98"),
         (NVIDIA_DRONE_DIAGNOSTIC_HELPER, "0b3227e7cff9fd89c47cfa69903dcd9ddeac13660b1c04de0533e3d1d9ce96e5"),
         (NVIDIA_DRONE_DIAGNOSTIC_UNIT, "d275551e151b636a0342f4a2d0264afb4456a587ccf917717388f30c73a38eaf")),
    ),
)
NVIDIA_ASSET_IDS = [
    "nvidia-transfer-conveyor",
    "nvidia-mobile-cart",
    "nvidia-storage-rack",
]
NVIDIA_CHECKS = {
    "nvidia_asset_delivery",
    "nvidia_renderer",
    "nvidia_fallback_accessibility",
}
NVIDIA_CONTRACT = {
    "version": 1,
    "engines": ["chromium", "firefox", "webkit"],
    "locales": ["en", "de"],
    "widths": [320, 1440],
    "modes": ["light", "dark"],
    "asset_ids": NVIDIA_ASSET_IDS,
    "public_renderer_only": True,
    "business_workflow_acceptance": False,
}


def qualification_profile(value):
    selected = value.get("qualification_profile", PRESENTATION_PROFILE)
    require(
        selected in {PRESENTATION_PROFILE, NVIDIA_PROFILE, IDENTITY_PROFILE},
        "UNKNOWN_FRONTEND_QUALIFICATION_PROFILE",
    )
    return selected


def profile_checks(plan, phase):
    extra = (
        NVIDIA_CHECKS
        if qualification_profile(plan) in {NVIDIA_PROFILE, IDENTITY_PROFILE}
        and phase in {"staging", "production"}
        else set()
    )
    return CHECKS[phase] | extra


def probe_source_files(files, selected=PRESENTATION_PROFILE):
    qualification_profile({"qualification_profile": selected})
    names = {
        "scripts/release/oracle_portal.py",
        "scripts/release/oracle_portal_frontend.py",
        "scripts/release/oracle_portal_browser.mjs",
        "scripts/release/oracle_portal_browser_session.mjs",
        "scripts/release/oracle_frontend_build.py",
        "scripts/release/oracle_vercel_transport_guard.cjs",
        "scripts/check_tls_bundle.mjs",
        "scripts/oracle_backup_store.mjs",
        "onesa-company-portal-frontend/package.json",
        "onesa-company-portal-frontend/package-lock.json",
        "onesa-company-portal-frontend/vendor/onesa-portal-minimatch-callable-1.0.0.tgz",
    }
    if selected in {NVIDIA_PROFILE, IDENTITY_PROFILE}:
        names |= {
            "scripts/release/oracle_portal_nvidia.mjs",
            "scripts/release/oracle_portal_nvidia_contract.mjs",
            NVIDIA_CATALOG,
            NVIDIA_LICENSE,
            NVIDIA_PREFIX + "src/config/nvidia-reference-assets.json",
        }
    if selected == IDENTITY_PROFILE:
        names.add("scripts/release/oracle_portal_identity_scope.py")
    require(names <= set(files), "COMPLETE_COMMISSIONED_PROBE_SOURCE_REQUIRED")
    return {name: files[name] for name in sorted(names)}


def configuration_value(binding, plan, env):
    require(env in ENV, "FRONTEND_CONFIGURATION_SCOPE")
    return {
        **({"source_binding": portal_source_binding(binding)}
           if binding.get("repository") == CANONICAL_REPOSITORY else {}),
        **(
            {
                "qualification_profile": qualification_profile(plan),
                "nvidia_observation_contract": NVIDIA_CONTRACT,
            }
            if qualification_profile(plan) in {NVIDIA_PROFILE, IDENTITY_PROFILE}
            else {}
        ),
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


def nvidia_source_metadata(archive, files):
    """Read bounded public data after source_inventory verified the entire Git tree."""
    with tarfile.open(archive, "r:") as source:
        for name in [NVIDIA_CATALOG, NVIDIA_LICENSE, NVIDIA_PREFIX + "src/config/nvidia-reference-assets.json"]:
            require(
                name in files and 0 < source.getmember(name).size < 32 * 1024,
                "BOUNDED_NVIDIA_PUBLIC_METADATA_REQUIRED",
            )
        catalog = json.load(source.extractfile(NVIDIA_CATALOG))
        compiled = json.load(
            source.extractfile(NVIDIA_PREFIX + "src/config/nvidia-reference-assets.json")
        )
        require(
            catalog == compiled
            and catalog.get("schemaVersion") == 1
            and catalog.get("catalogId") == "onesa-nvidia-simready-reference-v1"
            and [asset.get("id") for asset in catalog.get("assets", [])]
            == NVIDIA_ASSET_IDS,
            "PINNED_NVIDIA_CATALOG_REQUIRED",
        )
        public = {
            "/models/nvidia/manifest.json": {
                "sha256": files[NVIDIA_CATALOG],
                "byte_length": source.getmember(NVIDIA_CATALOG).size,
            },
            "/licenses/three.txt": {
                "sha256": files[NVIDIA_LICENSE],
                "byte_length": source.getmember(NVIDIA_LICENSE).size,
            },
        }
        for asset in catalog["assets"]:
            require(
                asset["author"] == "NVIDIA"
                and asset["sourceRevision"]
                == "4763fbfaa4f8e97658e68b57d01b4c86659e08b5"
                and asset["license"] == "CC-BY-4.0"
                and asset["visualOnly"] is True
                and asset["unit"] == "m"
                and asset["upAxis"] == "Y",
                "NVIDIA_VISUAL_REFERENCE_SCOPE",
            )
            for key in ["glb", "thumbnail", "licenseFile", "sourceFile"]:
                ref = asset[key]
                require(
                    re.fullmatch(
                        re.escape(asset["id"]) + r"/[A-Za-z0-9_-][A-Za-z0-9_.-]*",
                        ref["path"],
                    )
                    and type(ref["byteLength"]) is int
                    and 0 < ref["byteLength"] <= 2_000_000
                    and re.fullmatch("[a-f0-9]{64}", ref["sha256"]),
                    "BOUNDED_PINNED_NVIDIA_ASSET_REQUIRED",
                )
                name = NVIDIA_PREFIX + "public/models/nvidia/" + ref["path"]
                require(
                    files.get(name) == ref["sha256"]
                    and source.getmember(name).size == ref["byteLength"],
                    "NVIDIA_SOURCE_ASSET_BYTES_CHANGED",
                )
                public["/models/nvidia/" + ref["path"]] = {
                    "sha256": ref["sha256"],
                    "byte_length": ref["byteLength"],
                }
        require(
            0 < public["/licenses/three.txt"]["byte_length"] < 32 * 1024
            and 0 < public["/models/nvidia/manifest.json"]["byte_length"] < 32 * 1024,
            "BOUNDED_NVIDIA_PUBLIC_METADATA_REQUIRED",
        )
    return {"catalog": catalog, "public_files": public}


def nvidia_dependency_pins(files):
    # v1 qualifies this reviewed lock closure. A later transitive dependency
    # change needs an explicit source/profile review, even if package.json's
    # direct dependency ranges happen to remain the same.
    require(
        all(files.get(name) == digest for name, digest in NVIDIA_DEPENDENCY_PINS.items()),
        "NVIDIA_REVIEWED_DEPENDENCY_CLOSURE_ONLY",
    )


def nvidia_drone_diagnostic_command(files):
    for command, pins in NVIDIA_DRONE_DIAGNOSTIC_VARIANTS:
        if all(name not in files if digest is None else files.get(name) == digest
               for name, digest in pins):
            return command
    require(False, "NVIDIA_REVIEWED_DRONE_DIAGNOSTICS_ONLY")


def source_scope(folder, binding, plan):
    # No fallback: absence of an explicitly commissioned new profile keeps the
    # original presentation dependency/build/auth/hero gate exactly as before.
    if qualification_profile(plan) == PRESENTATION_PROFILE:
        return source_equivalence(folder, binding, plan)
    tool = trusted_toolchain(plan)
    require(
        all(
            binding[binding_key] == tool[tool_key]
            for binding_key, tool_key in [
                ("candidate_commit", "source_commit"),
                ("source_tree", "source_tree"),
                ("source_sha256", "source_sha256"),
            ]
        ),
        "NVIDIA_PROFILE_REQUIRES_EXACT_INSTALLED_MAIN_SOURCE",
    )
    baseline = plan.get("source_comparison_baseline", plan["retained_frontend"])
    retained = plan["retained_frontend"]
    require(
        {key: baseline[key] for key in ["source", "source_tree", "source_sha256"]}
        == tool["frontend_baseline"]
        == {key: retained[key] for key in ["source", "source_tree", "source_sha256"]},
        "COMMISSIONED_FRONTEND_BASELINE_CHANGED",
    )
    archive = private(folder / "baseline-source.tar")
    require(sha(archive) == baseline["source_sha256"], "BASELINE_SOURCE_ARCHIVE_CHANGED")
    require(sha(private(folder / "source.tar")) == binding["source_sha256"], "SOURCE_ARCHIVE_DIGEST")
    _, old = source_inventory(archive, {"source_tree": baseline["source_tree"]})
    _, new = source_inventory(folder / "source.tar", binding)
    if qualification_profile(plan) == IDENTITY_PROFILE:
        from oracle_portal_identity_scope import reviewed_delta

        changed = reviewed_delta(old, new)
        require(
            all(new.get(name) == digest for name, digest in tool["probe_files"].items()),
            "IDENTITY_FRONTEND_DIFFERS_FROM_INSTALLED_PROBE_SOURCE",
        )
        metadata = nvidia_source_metadata(folder / "source.tar", new)
        return {
            "qualification_profile": IDENTITY_PROFILE,
            "baseline_source": baseline["source"],
            "changed_frontend_paths": changed,
            "authentication_source_explicitly_reviewed": True,
            "new_full_business_acceptance_claimed": False,
            "product_presentation_requires_current_hosted_acceptance": True,
            "nvidia": metadata,
        }
    nvidia_dependency_pins(new)
    require(
        new.get(NVIDIA_DRONE_LAYOUT) == NVIDIA_DRONE_LAYOUT_SHA256,
        "NVIDIA_REVIEWED_DRONE_REFLOW_ONLY",
    )
    diagnostic_command = nvidia_drone_diagnostic_command(new)
    metadata = nvidia_source_metadata(folder / "source.tar", new)
    require(
        all(new.get(name) == digest for name, digest in tool["probe_files"].items()),
        "NVIDIA_CANDIDATE_DIFFERS_FROM_INSTALLED_PROBE_SOURCE",
    )
    changed = {
        name for name in old.keys() | new.keys()
        if name.startswith(NVIDIA_PREFIX) and old.get(name) != new.get(name)
    }
    # This is the reviewed renderer and its existing presentation integrations,
    # not a general frontend or dependency-change allowlist. Every new source
    # also requires fresh main CI, an immutable install and owner commissioning.
    permitted = {
        NVIDIA_PREFIX + name for name in [
            "Dockerfile", "package.json", "package-lock.json",
            "src/components/home-products.tsx", "src/config/products.ts",
            "src/components/product-overview.tsx", "src/components/responsive-link.tsx",
            "public/brand/sources.json", "public/images/drone-cargo-1280.webp",
            "public/images/drone-cargo-640.webp", "public/images/drone-flight-1280.webp",
            "public/images/drone-flight-640.webp", "public/media/onesa-drone-concept.mp4",
            "scripts/test-drone-product.mjs", "scripts/drone-product-diagnostics.mjs",
            "unit/drone-product-diagnostics.test.mjs", "src/app/[locale]/products/onesa-ai-drone/page.tsx",
            "src/app/[locale]/products/onesa-drone/page.tsx", "src/components/drone-film.tsx",
            "src/components/drone-image.tsx", "src/components/drone-product.module.css",
            "src/components/drone-product.tsx", "src/components/drone-visual.tsx",
            "src/components/site-footer.tsx", "src/config/enquiry-topics.ts",
            "src/lib/company-sitemap.ts", "public/licenses/three.txt",
            "public/models/nvidia/manifest.json", "scripts/test-nvidia-library.mjs",
            "scripts/validate-nvidia-assets.mjs", "src/components/nvidia-reference-library.module.css",
            "src/components/nvidia-reference-library.tsx", "src/components/nvidia-reference-viewer.ts",
            "src/config/nvidia-reference-assets.json", "tests/product-evidence.spec.ts",
            "unit/dependency-security.test.mjs", "unit/nvidia-assets.test.mjs",
            "security/minimatch-callable/README.md", "security/minimatch-callable/UPSTREAM.json",
            "security/minimatch-callable/UPSTREAM_LICENSE.md", "security/minimatch-callable/index.cjs",
            "security/minimatch-callable/package.json", "vendor/onesa-portal-minimatch-callable-1.0.0.tgz",
            "src/components/company-story.tsx", "src/components/product-illustration.tsx",
            "src/config/onesa-applications.json", "src/proxy.ts",
            "scripts/public-shell-ready.mjs", "scripts/test-public-loading.mjs",
            "public/brand/icons/v1/onesa-robot.svg", "public/brand/icons/v1/sources.json",
        ]
    } | {NVIDIA_PREFIX + "public" + path for path in metadata["public_files"]}
    require(
        changed and changed <= permitted and changed <= new.keys(),
        "NVIDIA_PROFILE_CHANGED_SCOPE_REQUIRES_SEPARATE_QUALIFICATION",
    )
    with tarfile.open(archive, "r:") as before, tarfile.open(folder / "source.tar", "r:") as after:
        previous = json.load(before.extractfile(NVIDIA_PREFIX + "package.json"))
        current = json.load(after.extractfile(NVIDIA_PREFIX + "package.json"))
        expected = json.loads(json.dumps(previous))
        expected["scripts"].update({
            "build": "node scripts/validate-nvidia-assets.mjs && next build --webpack",
            "test:drone-product": diagnostic_command,
            "test:nvidia-assets": "node scripts/validate-nvidia-assets.mjs && node --test unit/nvidia-assets.test.mjs",
            "test:nvidia-browser": "node scripts/test-nvidia-library.mjs",
            "test:dependency-security": "node --test unit/dependency-security.test.mjs",
        })
        expected["dependencies"]["three"] = "0.186.1"
        expected["devDependencies"].update({
            "@types/three": "0.186.0", "eslint": "9.39.5",
            "minimatch": "file:vendor/onesa-portal-minimatch-callable-1.0.0.tgz",
        })
        expected["overrides"] = {
            "eslint@9.39.5": {"minimatch": "$minimatch"},
            "@eslint/config-array@0.21.2": {"minimatch": "$minimatch"},
            "@eslint/eslintrc@3.3.7": {"minimatch": "$minimatch"},
            "@redocly/openapi-core@1.34.20": {"minimatch": "$minimatch"},
            "@typescript-eslint/typescript-estree@8.71.1": {"minimatch": "11.0.1"},
        }
        require(current == expected, "NVIDIA_REVIEWED_DEPENDENCY_BUILD_DELTA_ONLY")
        lock = json.load(after.extractfile(NVIDIA_PREFIX + "package-lock.json"))
        require(
            lock["lockfileVersion"] == 3
            and all(lock["packages"][""][key] == current[key] for key in ["dependencies", "devDependencies"]),
            "NVIDIA_LOCKED_DEPENDENCY_ROOT_CHANGED",
        )
        navigation = NVIDIA_PREFIX + "src/components/responsive-link.tsx"
        if navigation in changed:
            previous_link = before.extractfile(navigation).read()
            require(
                previous_link.count(b"<Link {...props}>") == 1
                and after.extractfile(navigation).read()
                == previous_link.replace(b"<Link {...props}>", b"<Link prefetch={false} {...props}>"),
                "NAVIGATION_PREFETCH_CHANGE_ONLY",
            )
        proxy = NVIDIA_PREFIX + "src/proxy.ts"
        if proxy in changed:
            require(proxy in old, "NVIDIA_PUBLIC_MODEL_CACHE_CHANGE_ONLY")
            expected_proxy = before.extractfile(proxy).read()
            for original, replacement in NVIDIA_PROXY_CHANGES:
                require(expected_proxy.count(original) == 1, "NVIDIA_PUBLIC_MODEL_CACHE_CHANGE_ONLY")
                expected_proxy = expected_proxy.replace(original, replacement)
            require(
                after.extractfile(proxy).read() == expected_proxy,
                "NVIDIA_PUBLIC_MODEL_CACHE_CHANGE_ONLY",
            )
        for name in ["src/components/company-story.tsx", "src/components/product-illustration.tsx", "src/config/onesa-applications.json", "scripts/public-shell-ready.mjs", "scripts/test-public-loading.mjs", "public/brand/icons/v1/onesa-robot.svg"]:
            branded = NVIDIA_PREFIX + name
            if branded in changed:
                previous_brand = before.extractfile(branded).read()
                renamed = previous_brand.replace(b"Onesa AI Robot", b"Onesa Robot").replace(b"ONESA AI ROBOT", b"ONESA ROBOT")
                if name == "src/config/onesa-applications.json":
                    renamed = renamed.replace(b'"version": "1.0.0"', b'"version": "1.0.1"')
                    require(
                        hashlib.sha256(renamed).hexdigest() == "0eeccc055f8d6df8662f0763453932e5d55dd5be9530a45a4cd863962f01e635",
                        "PINNED_ROBOT_APPLICATION_ARTIFACT_REQUIRED",
                    )
                require(
                    after.extractfile(branded).read()
                    == renamed,
                    "ROBOT_BRAND_TEXT_SUBSTITUTION_ONLY",
                )
        icon = NVIDIA_PREFIX + "public/brand/icons/v1/onesa-robot.svg"
        provenance = NVIDIA_PREFIX + "public/brand/icons/v1/sources.json"
        if {icon, provenance} & changed:
            original_icon = before.extractfile(icon).read()
            renamed_icon = original_icon.replace(b"<title>Onesa AI Robot</title>", b"<title>Onesa Robot</title>")
            expected_icons = json.load(before.extractfile(provenance))
            robot = [row for row in expected_icons["products"] if row["id"] == "robot"]
            require(len(robot) == 1 and robot[0]["title"] == "Onesa AI Robot", "RETAINED_ROBOT_ICON_IDENTITY_REQUIRED")
            robot[0]["title"] = "Onesa Robot"
            svg = [row for row in robot[0]["files"] if row["name"] == "onesa-robot.svg"]
            require(
                len(svg) == 1 and svg[0]["sha256"] == hashlib.sha256(original_icon).hexdigest()
                and svg[0]["bytes"] == len(original_icon),
                "RETAINED_ROBOT_ICON_BYTES_REQUIRED",
            )
            svg[0].update({"sha256": hashlib.sha256(renamed_icon).hexdigest(), "bytes": len(renamed_icon)})
            require(
                after.extractfile(icon).read() == renamed_icon
                and json.load(after.extractfile(provenance)) == expected_icons,
                "ROBOT_ICON_TITLE_AND_MATCHING_PROVENANCE_ONLY",
            )
        for name in changed:
            limit = 2 * 1024 * 1024 if name.endswith(".mp4") else 256 * 1024 if name.endswith(".webp") else None
            if limit:
                require(after.getmember(name).size <= limit, "BOUNDED_LOCAL_PRODUCT_MEDIA_REQUIRED")
    return {
        "qualification_profile": NVIDIA_PROFILE,
        "baseline_source": baseline["source"],
        "changed_frontend_paths": sorted(changed),
        "authentication_and_hero_source_unchanged": True,
        "new_full_business_acceptance_claimed": False,
        "product_presentation_requires_current_hosted_acceptance": True,
        "nvidia": metadata,
    }


def verify_nvidia_receipt(browser, metadata):
    require(browser.get("qualification_profile") == NVIDIA_PROFILE, "EXPLICIT_NVIDIA_OBSERVATION_REQUIRED")
    value = browser.get("nvidia", {})
    require(
        value.get("contract") == NVIDIA_CONTRACT
        and value.get("catalog_sha256") == metadata["public_files"]["/models/nvidia/manifest.json"]["sha256"]
        and value.get("renderer_license_sha256") == metadata["public_files"]["/licenses/three.txt"]["sha256"]
        and value.get("network_interceptions") == 0
        and value.get("synthetic_successes") == 0,
        "PINNED_REAL_NVIDIA_OBSERVATION_REQUIRED",
    )
    launches = value.get("launches", [])
    require(
        len(launches) == 3
        and {row.get("engine") for row in launches} == set(NVIDIA_CONTRACT["engines"])
        and all(
            isinstance(row.get("version"), str) and re.fullmatch(r"[0-9][0-9.A-Za-z_-]{0,79}", row["version"])
            and row.get("headless") is (row["engine"] != "firefox")
            and row.get("bundled_engine") is True
            for row in launches
        ),
        "THREE_PINNED_REAL_GRAPHICS_ENGINES_REQUIRED",
    )
    deliveries = value.get("asset_deliveries", [])
    expected_deliveries = {(engine, path) for engine in NVIDIA_CONTRACT["engines"] for path in metadata["public_files"]}
    require(
        len(deliveries) == len(expected_deliveries)
        and {(row.get("engine"), row.get("path")) for row in deliveries} == expected_deliveries
        and all(
            row.get("sha256") == metadata["public_files"][row["path"]]["sha256"]
            and row.get("byte_length") == metadata["public_files"][row["path"]]["byte_length"]
            and row.get("status") == 200 and row.get("redirects") == 0
            for row in deliveries
        ),
        "EXACT_NVIDIA_HOSTED_ASSET_BYTES_REQUIRED",
    )
    rows = value.get("views", [])
    expected = {(engine, locale, width, mode) for engine in NVIDIA_CONTRACT["engines"] for locale in ["en", "de"] for width in [320, 1440] for mode in ["light", "dark"]}
    require(
        len(rows) == len(expected)
        and {tuple(row.get(key) for key in ["engine", "locale", "width", "mode"]) for row in rows} == expected,
        "COMPLETE_UNIQUE_NVIDIA_BROWSER_MATRIX_REQUIRED",
    )
    for row in rows:
        assets = row.get("assets", [])
        require(
            len(assets) == 3 and [asset.get("id") for asset in assets] == NVIDIA_ASSET_IDS
            and all(
                asset.get("path") == "/models/nvidia/" + expected_asset["glb"]["path"]
                and asset.get("sha256") == expected_asset["glb"]["sha256"]
                and asset.get("byte_length") == expected_asset["glb"]["byteLength"]
                and asset.get("render_state") == "ready"
                and asset.get("canvas_count") == 1
                and asset.get("graphics_api") == "WebGL2"
                and asset.get("context_lost") is False
                and asset.get("keyboard_rotation") == 1
                and asset.get("fit_rotation") == 0
                for asset, expected_asset in zip(assets, metadata["catalog"]["assets"])
            )
            and row.get("theme_model_reload_count") == 0
            and row.get("accessibility_violations") == 0
            and row.get("horizontal_overflow") is False
            and row.get("enlarged_text_overflow") is False,
            "ALL_THREE_REAL_NVIDIA_RENDERS_AND_ACCESSIBILITY_REQUIRED",
        )
    cases = value.get("fallbacks", [])
    expected_cases = {(engine, locale) for engine in NVIDIA_CONTRACT["engines"] for locale in ["en", "de"]}
    require(
        len(cases) == len(expected_cases)
        and {(row.get("engine"), row.get("locale")) for row in cases} == expected_cases
        and all(
            row.get("product_index_state") == "ready"
            and row.get("context_loss_state") == "failed"
            and row.get("context_recovery_state") == "ready"
            and row.get("no_graphics_state") == "unavailable"
            and row.get("no_graphics_preview_loaded") is True
            and row.get("no_script_preview_loaded") is True
            and row.get("product_index_asset_ids") == NVIDIA_ASSET_IDS
            for row in cases
        ),
        "COMPLETE_NVIDIA_FALLBACK_AND_RECOVERY_MATRIX_REQUIRED",
    )


def verify_browser_receipt(browser, binding, env, *, nvidia=None):
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
    if nvidia is not None:
        verify_nvidia_receipt(browser, nvidia)


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
    source_scope(folder, binding, plan)
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

    project = frontend.protection(plan, binding)
    require(
        project["targets"]["production"]["id"]
        == plan["retained_frontend"]["deployment_id"],
        "CONCURRENT_FRONTEND_PUBLICATION_PRESERVED",
    )
    if qualification_profile(plan) in {NVIDIA_PROFILE, IDENTITY_PROFILE}:
        retained = plan["retained_frontend"]
        actual = frontend.provider("/v13/deployments/" + retained["deployment_id"])
        require(
            actual["id"] == retained["deployment_id"]
            and actual["projectId"] == plan["project_id"]
            and actual.get("readyState") == "READY"
            and actual.get("target") == "production"
            and (actual.get("meta", {}).get("githubCommitSha") or actual.get("gitSource", {}).get("sha")) == retained["source"],
            "NVIDIA_BASELINE_MUST_MATCH_ACTUAL_RETAINED_FRONTEND",
        )
    for env in ENV:
        readiness_and_denials(plan, env)
    probe_cpu_limit()
    require(shutil.disk_usage("/").free > 8 * 1024**3, "EXISTING_HOST_DISK_CAPACITY")
    return {
        "status": "PREFLIGHT_READY_NOT_QUALIFIED",
        "candidate_commit": binding["candidate_commit"],
        "component": "frontend",
        "source_scope": source_scope(folder, binding, plan),
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
    scope = (
        source_scope(folder, binding, plan)
        if qualification_profile(plan) in {NVIDIA_PROFILE, IDENTITY_PROFILE} else None
    )
    nvidia = scope["nvidia"] if scope is not None else None
    request = output / "browser-request.json"
    write(
        request,
        {
            "binding": binding,
            "environment": env,
            "origin": observation["origin"],
            "bypass": observation["bypass"],
            "provider_token_included": False,
            **(
                {
                    "qualification_profile": NVIDIA_PROFILE,
                    "nvidia": {
                        "contract": NVIDIA_CONTRACT,
                        "catalog_sha256": nvidia["public_files"]["/models/nvidia/manifest.json"]["sha256"],
                        "renderer_license_sha256": nvidia["public_files"]["/licenses/three.txt"]["sha256"],
                    },
                }
                if nvidia is not None else {}
            ),
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
                    "xvfb-run" if nvidia is not None else "node",
                    plan["probe_image"],
                    *(
                        ["-a", "--server-args=-screen 0 1920x1080x24", "node"]
                        if nvidia is not None else []
                    ),
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
    verify_browser_receipt(browser, binding, env, nvidia=nvidia)
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
        "source_scope": scope if scope is not None else source_scope(folder, binding, plan),
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
