#!/usr/bin/env python3
"""Provision this repository in the existing isolated VM, only while all jobs idle."""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "config.json").read_text())
VM = "onesa-portal-ci"
REPOSITORIES = ["onesa-company-portal", "onesa-ai-platform", "onesa-ai-robot"]


def run(*args, capture=False, data=None):
    return subprocess.run(
        args,
        input=data,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else None,
    ).stdout


def api(path, *args):
    return json.loads(run("gh", "api", path, *args, capture=True))


def guest(*args, **kwargs):
    return run("limactl", "shell", VM, "--", *args, **kwargs)


def main():
    repo = api("repos/" + CONFIG["repository"])
    if not repo["private"] or not repo["permissions"].get("admin"):
        sys.exit("Private repository with admin permission required")
    matches = []
    for repository in REPOSITORIES:
        runners = api(f"repos/DruHustle/{repository}/actions/runners")["runners"]
        if any(r["busy"] for r in runners):
            sys.exit(
                "A shared VM runner is busy; retry maintenance after all jobs finish"
            )
        if repository == CONFIG["repository"].split("/")[1]:
            matches = [r for r in runners if r["name"] == CONFIG["name"]]
    if len(matches) > 1:
        sys.exit("Duplicate registration; refusing replacement")
    instance = next(
        json.loads(line)
        for line in run("limactl", "list", "--json", capture=True).splitlines()
        if json.loads(line)["name"] == VM
    )
    config = instance["config"]
    if (
        instance["status"] != "Running"
        or config.get("mounts")
        or config["ssh"].get("forwardAgent")
    ):
        sys.exit(
            "Existing isolated VM must be running without host mounts or agent forwarding"
        )
    if (
        config["arch"] != "aarch64"
        or config["cpus"] != 4
        or config["memory"] not in ["6GiB", 6442450944]
    ):
        sys.exit("Unexpected shared VM architecture/resources")
    if not any(
        p.get("ignore")
        and p.get("proto") == "any"
        and p.get("guestIP") == "0.0.0.0"
        and p.get("guestPortRange") == [1, 65535]
        for p in config["portForwards"]
    ):
        sys.exit("Application port forwarding must be disabled")
    release = api("repos/actions/runner/releases/latest")
    asset = next(
        a
        for a in release["assets"]
        if a["name"].startswith("actions-runner-linux-arm64-")
    )
    digest = asset.get("digest", "")
    if not digest.startswith("sha256:") or len(digest) != 71:
        sys.exit("Official runner asset SHA-256 required")
    guest(
        "sudo",
        "bash",
        "-c",
        "if pgrep -f '^/opt/onesa-.*/bin/Runner.Worker ' >/dev/null; then echo 'Worker still active; refusing maintenance'; exit 1; fi",
    )
    # Stop the existing idle listeners to eliminate the check/start maintenance race.
    guest(
        "sudo",
        "bash",
        "-c",
        'for d in /opt/onesa-actions-runner /opt/onesa-platform-runner /opt/onesa-robot-runner; do if test -f "$d/.service"; then systemctl stop "$(cat "$d/.service")"; fi; done',
    )
    try:
        for filename in [
            "config.json",
            "lease.py",
            "cleanup.py",
            "job-started.sh",
            "job-completed.sh",
            "shared-guest.sh",
            "visibility.py",
            "test_lease.py",
        ]:
            run(
                "limactl",
                "copy",
                str(HERE / filename),
                f"{VM}:/tmp/onesa-shared-{filename}",
            )
        guest(
            "sudo",
            "bash",
            "/tmp/onesa-shared-shared-guest.sh",
            CONFIG["user"],
            CONFIG["directory"],
        )
        token = (
            ""
            if matches
            else api(
                f"repos/{CONFIG['repository']}/actions/runners/registration-token",
                "-X",
                "POST",
            )["token"]
        )
        guest(
            "sudo",
            "-u",
            CONFIG["user"],
            "-H",
            "bash",
            "-c",
            """
set -euo pipefail
umask 077
cd "$1"
if ! test -f .runner; then
  curl -fsSL --retry 3 "$2" -o runner.tar.gz
  printf '%s  runner.tar.gz\n' "$3" | sha256sum --check --strict
  tar xzf runner.tar.gz
  rm runner.tar.gz
  IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
  export ACTIONS_RUNNER_INPUT_TOKEN
  ./config.sh --unattended --url "https://github.com/$4" --name "$5" --labels "$6" --work _work
  unset ACTIONS_RUNNER_INPUT_TOKEN
fi
python3 - "$4" "$5" <<'PY'
import json, sys
from pathlib import Path
c=json.loads(Path('.runner').read_text(encoding='utf-8-sig'))
assert c['gitHubUrl'].rstrip('/') == 'https://github.com/'+sys.argv[1]
assert c['agentName'] == sys.argv[2]
PY
sed -i '/^ACTIONS_RUNNER_HOOK_JOB_/d; /^RUNNER_TOOL_CACHE=/d; /^AGENT_TOOLSDIRECTORY=/d' .env
printf '%s\n' "RUNNER_TOOL_CACHE=$1/toolcache" "AGENT_TOOLSDIRECTORY=$1/toolcache" "ACTIONS_RUNNER_HOOK_JOB_STARTED=$1/job-started.sh" "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$1/job-completed.sh" >> .env
""",
            "setup",
            CONFIG["directory"],
            asset["browser_download_url"],
            digest[7:],
            CONFIG["repository"],
            CONFIG["name"],
            CONFIG["label"],
            data=token + "\n",
        )
        token = None
        guest(
            "sudo",
            "bash",
            "-c",
            'cd "$1"; ./bin/installdependencies.sh; if ! test -f .service; then ./svc.sh install "$2"; fi; systemctl enable "$(cat .service)"',
            "setup",
            CONFIG["directory"],
            CONFIG["user"],
        )
    finally:
        if "--keep-stopped" not in sys.argv:
            guest(
                "sudo",
                "bash",
                "-c",
                'for d in /opt/onesa-actions-runner /opt/onesa-platform-runner /opt/onesa-robot-runner; do if test -f "$d/.service"; then systemctl start "$(cat "$d/.service")"; fi; done',
            )
    print(
        f"Reconciled {CONFIG['repository']}: {CONFIG['name']}; runner {release['tag_name']}, {digest}"
    )


if __name__ == "__main__":
    main()
