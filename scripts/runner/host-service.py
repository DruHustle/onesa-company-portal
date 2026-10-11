#!/usr/bin/env python3
"""Install the per-login VM LaunchAgent; stop the VM first when it is idle."""

# Refuse login startup when no private repository needs this VM.
import json
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

repositories = ["onesa-company-portal", "onesa-ai-platform", "onesa-ai-robot"]
private = any(
    json.loads(
        subprocess.run(
            ["gh", "api", "repos/DruHustle/" + repository],
            check=True,
            text=True,
            capture_output=True,
        ).stdout
    )["private"]
    for repository in repositories
)
if not private:
    raise SystemExit("All repositories are public; local VM startup must stay disabled")

label = "eu.onesa.portal-ci-vm"
vm = "onesa-portal-ci"
root = Path.home()
plist = root / "Library/LaunchAgents" / f"{label}.plist"
if plist.exists():
    raise SystemExit(
        f"{plist} already exists; inspect it rather than replacing a service."
    )
logdir = root / ".lima" / vm
limactl = shutil.which("limactl")
if not limactl or not logdir.is_dir():
    raise SystemExit("Install Lima and run setup.py first.")
plist.parent.mkdir(parents=True, exist_ok=True)
config = {
    "Label": label,
    "ProgramArguments": [limactl, "start", "--tty=false", "--foreground", vm],
    "EnvironmentVariables": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    },
    "RunAtLoad": True,
    "KeepAlive": {"SuccessfulExit": False},
    "ThrottleInterval": 30,
    "StandardOutPath": str(logdir / "launchd.stdout.log"),
    "StandardErrorPath": str(logdir / "launchd.stderr.log"),
}
with plist.open("wb") as stream:
    plistlib.dump(config, stream)
plist.chmod(0o600)
subprocess.run(["plutil", "-lint", str(plist)], check=True)
subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)], check=True)
print(f"Installed {plist}; VM starts after this account logs in, not before login.")
