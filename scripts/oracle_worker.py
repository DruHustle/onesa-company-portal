"""Owner-operated exact-staging deployment; secrets stay in the VM's private file."""

import argparse
import hashlib
import io
import json
import re
import shlex
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/release"))
import evidence  # noqa: E402

INSTANCE = "ocid1.instance.oc1.eu-frankfurt-1.antheljsdhe5tbaceekd4uxnzp5trhvl5miigwg3gk2kyyayue7jp54co6jq"
HOST = "92.5.170.138"
PRIVATE = ROOT / "private/oracle/worker"
PATHS = ["compose.oracle-staging.yaml", "infra/oracle/clamav", "onesa-company-portal-backend", "scripts/release/image_gate.py"]
TRIVY = "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"


def require(value, message):
    if not value:
        raise ValueError(message)


def ssh():
    receipt = json.loads((PRIVATE / "instance.json").read_text())
    require(receipt.get("instance_ocid") == INSTANCE and receipt.get("public_ip") == HOST
            and receipt.get("region") == "eu-frankfurt-1" and receipt.get("ssh_verified") is True,
            "Verified existing staging instance receipt required")
    key = PRIVATE / "onesa-portal-worker.pem"
    known = ROOT / "private/oracle/known_hosts"
    require(key.is_file() and not key.is_symlink() and key.stat().st_mode & 0o077 == 0,
            "Existing private SSH key must have owner-only permissions")
    require(known.is_file() and not known.is_symlink(), "Existing pinned SSH host record required")
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-o", "StrictHostKeyChecking=yes",
            "-o", "UserKnownHostsFile=" + json.dumps(str(known)), "-i", str(key), "ubuntu@" + HOST]


def qualified_source(sha, github):
    require(bool(re.fullmatch(r"[a-f0-9]{40}", sha or "")), "Exact staging commit required")
    stage = github.api("repos/DruHustle/onesa-company-portal/branches/staging")
    require(stage["commit"]["sha"] == sha, "Candidate must equal current remote staging")
    status, references = evidence.checked_ci(github, sha)
    require(status == "PASS", "Full exact-source staging CI and hygiene must pass before VM writes")
    return references


def archive(sha):
    raw = subprocess.check_output(["git", "archive", "--format=tar.gz", sha, "--", *PATHS], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as bundle:
        names = []
        for member in bundle.getmembers():
            path = Path(member.name)
            require(not path.is_absolute() and ".." not in path.parts and (member.isfile() or member.isdir()),
                    "Archive must contain only relative regular source files/directories")
            name = path.as_posix().rstrip("/")
            require(any(name == p or name.startswith(p + "/")
                        or (member.isdir() and p.startswith(name + "/")) for p in PATHS),
                    "Archive escaped the staging runtime allowlist")
            names.append(member.name)
        require("compose.oracle-staging.yaml" in names and "infra/oracle/clamav/Dockerfile" in names,
                "Current source does not contain the prepared Oracle runtime")
    return raw


def remote(command, *, data=None, timeout=120):
    PRIVATE.mkdir(parents=True, exist_ok=True)
    log = PRIVATE / "deployment.log"
    with log.open("ab") as output:
        log.chmod(0o600)
        result = subprocess.run(ssh() + [command], input=data, stdout=output,
                                stderr=subprocess.STDOUT, timeout=timeout)
    require(result.returncode == 0, "VM operation failed; inspect the private deployment log without publishing its contents")


def deploy(action, sha, *, synthetic=False, github=None):
    if action == "verify":
        remote("uname -m\nlsb_release -ds\nsudo docker info --format 'CPUs={{.NCPU}} Memory={{.MemTotal}}'\n"
               "sudo systemctl is-active docker.service onesa-worker-firewall.service\n"
               "sudo ss -lntp")
        return {"ssh_verified": True, "deployment_requested": False, "hosted_worker_verified": False}
    require(action in {"prepare", "scanner", "worker"}, "Unsupported staging operation")
    require(action != "worker" or synthetic, "Owner-approved synthetic staging data required before enabling jobs")
    refs = qualified_source(sha, github or evidence.GitHub())
    raw = archive(sha)
    checksum = hashlib.sha256(raw).hexdigest()
    upload = "/tmp/onesa-portal-" + sha + ".tar.gz"
    release = "/opt/onesa/portal-staging/releases/" + sha
    remote("umask 077\ncat > " + upload, data=raw)
    remote("set -eu\nprintf '%s  %s\\n' " + shlex.quote(checksum) + " " + upload + " | sha256sum -c -\n"
           "sudo install -d -m 700 " + release + "\n"
           "sudo tar --no-same-owner -xzf " + upload + " -C " + release + "\nrm -- " + upload)
    environment = "PORTAL_WORKER_IMAGE=onesa-portal-worker:" + sha + " PORTAL_SCANNER_IMAGE=onesa-portal-clamav:" + sha
    prefix = "sudo env " + environment + " docker compose -f " + release + "/compose.oracle-staging.yaml"
    # Build and scan both native ARM64 runtime images before starting any service.
    remote("set -eu\n" + prefix + " --profile jobs build\n"
           "sudo install -d -m 700 " + release + "/security\n"
           "for image in worker scanner; do\n"
           "  case $image in worker) tag=onesa-portal-worker:" + sha + ";; scanner) tag=onesa-portal-clamav:" + sha + ";; esac\n"
           "  sudo docker save \"$tag\" -o " + release + "/security/runtime.tar\n"
           "  sudo docker run --rm -e TRIVY_CACHE_DIR=/tmp/trivy-cache -v " + release + "/security:/reports " + TRIVY +
           " image --scanners vuln,secret --format json --output /reports/runtime.json --input /reports/runtime.tar\n"
           "  sudo python3 " + release + "/scripts/release/image_gate.py " + release + "/security/runtime.json\n"
           "  sudo mv " + release + "/security/runtime.json " + release + "/security/\"$image\".json\n"
           "  sudo rm -- " + release + "/security/runtime.tar\ndone", timeout=1800)
    if action in {"scanner", "worker"}:
        remote(prefix + " up -d --wait --wait-timeout 480 scanner", timeout=510)
    if action == "worker":
        # Never create a blank credential file or infer approval from its presence.
        remote("set -eu\nsudo test ! -L /etc/onesa/portal-staging.env\nsudo test -f /etc/onesa/portal-staging.env\n"
               "test \"$(sudo stat -c '%a:%U' /etc/onesa/portal-staging.env)\" = '600:root'\n"
               + prefix + " --profile jobs up -d --wait --wait-timeout 180 worker", timeout=210)
    receipt = {"instance_ocid": INSTANCE, "public_ip": HOST, "scope": "staging", "commit": sha,
               "archive_sha256": checksum, "source_checks": refs, "action": action,
               "worker_enabled": action == "worker", "synthetic_data_approved": synthetic,
               "hosted_scan_verified": False, "production_qualified": False}
    output = PRIVATE / "deployment.json"
    output.write_text(json.dumps(receipt, indent=2) + "\n")
    output.chmod(0o600)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=["verify", "prepare", "scanner", "worker"], default="verify")
    parser.add_argument("--commit")
    parser.add_argument("--synthetic-data-approved", action="store_true")
    args = parser.parse_args()
    try:
        receipt = deploy(args.action, args.commit, synthetic=args.synthetic_data_approved)
        print(json.dumps({k: receipt[k] for k in ("action", "scope", "commit", "worker_enabled", "production_qualified", "deployment_requested", "hosted_worker_verified") if k in receipt}))
    except (ValueError, subprocess.SubprocessError, OSError) as error:
        print("Oracle staging deployment blocked: " + str(error), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
