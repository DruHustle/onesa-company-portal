#!/usr/bin/env python3
"""Inspect visibility/access, or revoke public repositories' local registrations.

Run on the Mac: gh credentials never enter the guest. --enforce is appropriate
after a visibility change and before re-enabling any private runner service.
"""

import argparse
import json
import subprocess

REPOSITORIES = ["onesa-company-portal", "onesa-ai-platform", "onesa-ai-robot"]
LOCAL_NAMES = [
    "onesa-portal-local-arm64",
    "onesa-platform-local-arm64",
    "onesa-robot-local-arm64",
]


def api(path, *args):
    result = subprocess.run(
        ["gh", "api", path, *args], check=True, text=True, capture_output=True
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()
    invalid = False
    for repository in REPOSITORIES:
        full = "DruHustle/" + repository
        info = api("repos/" + full)
        runners = api("repos/" + full + "/actions/runners")["runners"]
        if not info["private"]:
            for runner in runners:
                if args.enforce and runner["name"] in LOCAL_NAMES:
                    # Remove dispatch access first; a stopped/offline VM need not be started.
                    api(f"repos/{full}/actions/runners/{runner['id']}", "-X", "DELETE")
                    print(f"Revoked public repository registration: {runner['name']}")
                else:
                    invalid = True
                    print(
                        f"BLOCKED: public repository has runner access: {full} / {runner['name']}"
                    )
        print(f"{full}: visibility={info['visibility']}; registrations={len(runners)}")
    if invalid:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
