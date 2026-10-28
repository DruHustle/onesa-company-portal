"""Install reviewed Oracle release code; this operation creates no release authority.

Invoke a hash-checked immutable copy through the existing owner SSH/sudo route.
The bundle manifest is a transport index. Every executable is compared with the
current owner-merged main source and fresh native CI before installation. Signing
and trust anchoring remain the separate bootstrap/commission commands.
"""

import argparse
import base64
import importlib.util
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_owner as verifier

INSTALL_PARENT = Path("/usr/local/lib/onesa-release")
ALLOWED = {
    "oracle_owner.py": "scripts/release/oracle_owner.py",
    "oracle_install.py": "scripts/release/oracle_install.py",
    "runners/oracle_portal.py": "scripts/release/oracle_portal.py",
    "runners/oracle_backup_store.mjs": "scripts/oracle_backup_store.mjs",
    "runners/oracle_portal_frontend.py": "scripts/release/oracle_portal_frontend.py",
    "runners/oracle_portal_browser.mjs": "scripts/release/oracle_portal_browser.mjs",
    "runners/oracle_frontend_build.py": "scripts/release/oracle_frontend_build.py",
    "runners/oracle_vercel_transport_guard.cjs": "scripts/release/oracle_vercel_transport_guard.cjs",
}
SCANNER_ALLOWED = {
    **ALLOWED,
    "runners/oracle_portal_scanner.py": "scripts/release/oracle_portal_scanner.py",
    **{
        "runners/" + name: "scripts/release/" + name
        for name in [
            "oracle_portal_scanner_workflow.py",
            "oracle_portal_scanner_workflows.mjs",
            "oracle_portal_worker_fixture.mjs",
            "oracle_portal_worker_probe.mjs",
            "oracle_portal_worker_smtp.mjs",
        ]
    },
}

MAX_BYTES = 2 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise verifier.Rejected(code)


def relative(value):
    p = PurePosixPath(value)
    require(
        not p.is_absolute() and str(p) == value and ".." not in p.parts,
        "Bundle path refused",
    )
    return p


def checked_file(path, checksum, uid=0, *, max_bytes=MAX_BYTES):
    verifier.private(path, uid=uid)
    require(
        path.stat().st_size <= max_bytes and verifier.file_digest(path) == checksum,
        "Bundle bytes differ",
    )
    return path.read_bytes()


def validate(bundle, manifest_pin, github, *, uid=0):
    bundle = Path(bundle)
    verifier.private(bundle, directory=True, uid=uid)
    raw = checked_file(bundle / "manifest.json", manifest_pin, uid)
    m = json.loads(raw)
    require(
        set(m)
        == {
            "schema_version",
            "repository",
            "candidate_commit",
            "source_tree",
            "files",
            "policy_sha256",
            "tool_source_sha256",
        },
        "Installation manifest schema",
    )
    require(
        m["schema_version"] == 1
        and m["repository"] == "DruHustle/onesa-company-portal",
        "Installation repository refused",
    )
    if set(m["files"]) == set(ALLOWED):
        allowed, component, script, prefix = (
            ALLOWED,
            "frontend",
            "oracle_portal_frontend.py",
            "portal-",
        )
    elif set(m["files"]) == set(SCANNER_ALLOWED):
        allowed, component, script, prefix = (
            SCANNER_ALLOWED,
            "scanner",
            "oracle_portal_scanner.py",
            "portal-scanner-",
        )
    else:
        raise verifier.Rejected(
            "Only complete reviewed component installation profiles are accepted"
        )
    github.owner()
    # Actual main, owner merge, first-attempt jobs, hygiene and artifacts are fetched
    # by the existing verifier. No supplied PASS receipt is accepted here.
    ci = github.qualify(
        {k: m[k] for k in ["repository", "candidate_commit", "source_tree"]}
    )
    require(ci, "Current exact-main checks missing")
    source = github.api(
        "repos/" + m["repository"] + "/git/trees/" + m["source_tree"] + "?recursive=1"
    )
    require(not source.get("truncated"), "Source tree incomplete")
    blobs = {r["path"]: r for r in source["tree"] if r["type"] == "blob"}
    payloads = {}
    for local, upstream in allowed.items():
        relative(local)
        checksum = m["files"][local]
        require(
            isinstance(checksum, str) and verifier.HEX.fullmatch(checksum),
            "Literal executable pin required",
        )
        data = checked_file(bundle / local, checksum, uid)
        blob = blobs.get(upstream)
        require(
            blob and blob["mode"] == "100644",
            "Reviewed source blob missing/type changed",
        )
        observed = github.api("repos/" + m["repository"] + "/git/blobs/" + blob["sha"])
        require(observed["encoding"] == "base64", "Source encoding refused")
        require(
            base64.b64decode(observed["content"], validate=False) == data,
            "Installation executable differs from current main",
        )
        payloads[local] = data
    policy_bytes = checked_file(bundle / "policy.json", m["policy_sha256"], uid)
    policy = json.loads(policy_bytes)
    require(
        set(policy) == {"schema_version", "components", "toolchain"}
        and policy["schema_version"] == 1,
        "Installation policy schema",
    )
    require(
        set(policy["components"]) == {"DruHustle/onesa-company-portal:" + component},
        "Only the selected independent Portal component profile is eligible",
    )
    # This source archive is data. Reconstruct its Git tree before using any
    # derived probe-code pins. All executable bootstrap modules were compared to
    # genuine current-main Git blobs above, before loading this stdlib parser.
    tool_bytes = checked_file(
        bundle / "tool-source.tar",
        m["tool_source_sha256"],
        uid,
        max_bytes=64 * 1024 * 1024,
    )
    spec = importlib.util.spec_from_file_location(
        "reviewed_oracle_source_parser", bundle / "runners/oracle_portal.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _app, files = module.source_inventory(
        bundle / "tool-source.tar", {"source_tree": m["source_tree"]}
    )
    tool = policy["toolchain"]
    tool_fields = {
        "source_commit",
        "source_tree",
        "source_sha256",
        "probe_files",
    }
    tool_fields |= (
        {
            "probe_image",
            "cli_image",
            "builder_image",
            "builder_sha256",
            "transport_guard_sha256",
        }
        if component == "frontend"
        else {"transport_image", "workflow_files"}
    )
    require(
        set(tool) == tool_fields
        and tool["source_commit"] == m["candidate_commit"]
        and tool["source_tree"] == m["source_tree"]
        and tool["source_sha256"] == m["tool_source_sha256"],
        "Commissioned tool source differs from reviewed main",
    )
    if component == "frontend":
        require(
            tool["probe_files"] == module.probe_source_files(files)
            and tool["builder_sha256"] == m["files"]["runners/oracle_frontend_build.py"]
            and tool["transport_guard_sha256"]
            == m["files"]["runners/oracle_vercel_transport_guard.cjs"],
            "Unreviewed probe or build code pins refused",
        )
        images = ["probe_image", "cli_image", "builder_image"]
    else:
        workflow_files = {
            upstream: files[upstream]
            for name, upstream in SCANNER_ALLOWED.items()
            if name not in ALLOWED and name != "runners/oracle_portal_scanner.py"
        }
        require(
            tool["workflow_files"] == workflow_files,
            "Scanner workflow tools differ from reviewed source",
        )
        require(
            tool["probe_files"]
            == {
                "scripts/oracle_backup_store.mjs": files[
                    "scripts/oracle_backup_store.mjs"
                ]
            },
            "Scanner backup transport differs from reviewed source",
        )
        images = ["transport_image"]
    require(
        all(
            isinstance(tool[k], str) and re.fullmatch("sha256:[a-f0-9]{64}", tool[k])
            for k in images
        ),
        "Literal immutable tool image pins required",
    )
    target = INSTALL_PARENT / (prefix + m["source_tree"])
    profile = policy["components"][m["repository"] + ":" + component]
    probe = {
        "repository": m["repository"],
        "component": component,
        "candidate_commit": m["candidate_commit"],
        "source_tree": m["source_tree"],
        "source_sha256": "0" * 64,
        "build_sha256": "0" * 64,
        "artifact_digest": "sha256:" + "0" * 64,
        "configuration_sha256": {"staging": "0" * 64, "production": "0" * 64},
        "target_environment": "production",
    }
    verifier.binding_valid(probe, policy)
    require(
        profile["qualification_attempt_limit"] == 1,
        "One initial context per component/source; no implicit renewal",
    )
    for runner in profile["runners"].values():
        require(
            runner["path"] == str(target / "runners" / script)
            and runner["sha256"] == m["files"]["runners/" + script],
            "Phase runner differs from reviewed installation",
        )
    payloads["tool-source.tar"] = tool_bytes
    payloads["policy.json"] = policy_bytes
    return m, target, payloads, ci


def install(bundle, manifest_pin, github, *, dry_run=False, uid=0):
    manifest, target, payloads, ci = validate(bundle, manifest_pin, github, uid=uid)
    require(
        not target.exists() and not target.is_symlink(),
        "Existing installation retained; inspect instead of overwriting",
    )
    if dry_run:
        return {
            "state": "INSTALLATION_READY",
            "provider_writes": False,
            "target": str(target),
            "source": manifest["candidate_commit"],
            "ci": ci,
        }
    require(
        uid == 0
        and os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS"),
        "Existing owner SSH/sudo installation required",
    )
    if not INSTALL_PARENT.exists():
        verifier.private(
            INSTALL_PARENT.parent, directory=True
        ) if INSTALL_PARENT.parent.stat().st_mode & 0o077 == 0 else require(
            all(
                p.stat().st_uid == 0
                and p.stat().st_mode & 0o022 == 0
                and not p.is_symlink()
                for p in [INSTALL_PARENT.parent, *INSTALL_PARENT.parent.parents]
            ),
            "Untrusted installation parent",
        )
        INSTALL_PARENT.mkdir(mode=0o700)
    verifier.private(INSTALL_PARENT, directory=True)
    target.mkdir(
        mode=0o700
    )  # Atomic no-replace reservation. Interrupted installs are retained.
    try:
        (target / "runners").mkdir(mode=0o700)
        for name, data in payloads.items():
            path = target / relative(name)
            with os.fdopen(
                os.open(
                    path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                ),
                "wb",
            ) as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        receipt = {
            "state": "INSTALLED_NOT_COMMISSIONED",
            "repository": manifest["repository"],
            "source": manifest["candidate_commit"],
            "source_tree": manifest["source_tree"],
            "files": manifest["files"],
            "policy_sha256": manifest["policy_sha256"],
            "ci": ci,
            "provider_requests": 0,
        }
        with os.fdopen(
            os.open(
                target / "installation.json",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            ),
            "wb",
        ) as f:
            f.write(verifier.canonical(receipt))
            f.flush()
            os.fsync(f.fileno())
        fd = os.open(target, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {**receipt, "target": str(target)}
    except BaseException:  # noqa: BLE001 -- Retain a partial immutable installation on interruption.
        # Never erase an uncertain installation to make retry appear clean.
        raise verifier.Rejected(
            "Installation interrupted; inspect retained version; no automatic retry"
        ) from None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bundle", type=Path, required=True)
    p.add_argument("--manifest-pin", required=True)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS"),
        "Existing owner SSH/sudo installation required",
    )
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384, "Private request bound")
    request = json.loads(raw)
    require(
        set(request) == {"owner_token"},
        "Only existing owner credential accepted in private stdin",
    )
    result = install(
        args.bundle,
        args.manifest_pin,
        verifier.GitHub(request["owner_token"]),
        dry_run=args.dry_run,
    )
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- CLI boundary redacts private input and provider diagnostics.
        raise SystemExit(
            "Oracle installation refused; inspect private prerequisites and retained state"
        ) from None
