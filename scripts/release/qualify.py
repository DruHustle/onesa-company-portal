"""Fail-closed qualification. No deploy, Git mutation, purchase or production probing."""
import argparse
import hashlib
import urllib.error
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT.name
GATES = ("CODE_VERIFIED", "STAGING_VERIFIED", "OPERATIONS_VERIFIED", "CONTENT_LEGAL_APPROVED")

def run(command, cwd=ROOT):
    return subprocess.run(command, cwd=cwd, check=False).returncode

def source_hash():
    paths = subprocess.check_output(["git", "ls-files", "-c", "-o", "--exclude-standard"], cwd=ROOT, text=True).splitlines()
    digest = hashlib.sha256()
    for name in sorted(set(paths)):
        file = ROOT / name
        if file.is_file():
            digest.update(name.encode() + b"\0" + hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["contracts", "verify", "smoke", "decision"])
    parser.add_argument("--target")
    parser.add_argument("--allowlist", type=Path, default=ROOT / "scripts/release/targets.example.json")
    args = parser.parse_args()
    if args.mode == "decision":
        # A locally editable PASS string and source hash are not release authority.
        # This compatibility command must never promote retired JSON approvals.
        for gate in GATES:
            print(gate + ": BLOCKED")
        print("NO-GO: legacy JSON approvals are retired; use the trusted release qualification workflow")
        raise SystemExit(1)
    if args.mode == "smoke":
        allowed = json.loads(args.allowlist.read_text())["allowed_origins"]
        if args.target not in allowed:
            raise SystemExit("Target must exactly match the explicit allowlist")
        parsed = urlsplit(args.target)
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise SystemExit("Only exact origins without credentials are accepted")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
            raise SystemExit("Remote smoke requires HTTPS")
        request = urllib.request.Request(args.target + "/api/v1/auth/me", headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10):
                raise SystemExit("Anonymous /auth/me unexpectedly succeeded")
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise SystemExit("Unexpected auth smoke status: " + str(error.code))
        print("Anonymous authentication denied; additional staging gates remain mandatory")
        return
    ai = PRODUCT == "onesa-ai-platform"
    commands = ([["make", "contract-check"]] if ai else [["npm", "run", "api:check"], ["npm", "run", "test:contracts"]])
    results = [run(command, ROOT if ai else ROOT / "onesa-company-portal-frontend") for command in commands]
    results.append(run(["python3", "scripts/release/contract_compatibility.py", "--self-test"]))
    results.append(run(["python3", "scripts/release/contract_compatibility.py"]))
    if args.mode == "verify":
        variable = "ONESA_TEST_DATABASE_URL" if ai else "TEST_DATABASE_URL"
        database = os.getenv(variable, "")
        if not database or not urlsplit(database).path.endswith("_test"):
            raise SystemExit("Verify requires an explicitly isolated database ending _test")
        results.append(run(["make", "check"] if ai else ["npm", "test"], ROOT if ai else ROOT / "onesa-company-portal-backend"))
        results.append(run(["npm", "run", "typecheck"], ROOT / ("onesa-ai-platform-frontend/apps/chat" if ai else "onesa-company-portal-frontend")))
    raise SystemExit(1 if any(results) else 0)

if __name__ == "__main__":
    main()
