"""Conservative PR classification; all release-source pushes and dispatches run fully."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT.name
FIELDS = (
    "backend",
    "frontend",
    "browser",
    "documentation",
    "containers",
    "tls",
    "edge",
)


def classify(product, changed, full=False):
    result = {name: False for name in FIELDS}
    if full or changed is None:
        result = {name: True for name in FIELDS}
    else:
        for name in changed:
            shared = name.startswith(("scripts/", "infra/", "contracts/", ".github/"))
            critical = any(
                part in name.lower()
                for part in (
                    "/api/",
                    "auth",
                    "middleware",
                    "proxy",
                    "security",
                    "migration",
                    "/contracts/",
                    "config",
                    "dockerfile",
                )
            )
            configuration = name.endswith(
                (".lock", "package.json", "package-lock.json", ".toml", ".yaml", ".yml")
            )
            if shared or critical or configuration:
                result = {key: True for key in FIELDS}
                continue
            if product == "onesa-ai-robot":
                if name.startswith("docs/") and not name.startswith("docs/api/"):
                    result["documentation"] = True
                elif name.startswith("onesa-ai-robot-frontend/"):
                    for key in ("frontend", "browser", "containers"):
                        result[key] = True
                else:
                    result = {key: True for key in FIELDS}
            elif product == "onesa-company-portal":
                if name.startswith("docs/") and not name.startswith("docs/api/"):
                    result["documentation"] = True
                else:
                    result = {key: True for key in FIELDS}
            else:
                if name.startswith(
                    ("docs/", "scripts/docs/", "onesa-ai-platform-frontend/apps/docs/")
                ) and not name.startswith("docs/api/"):
                    for key in ("documentation", "browser"):
                        result[key] = True
                elif name.startswith(
                    "onesa-ai-platform-frontend/apps/chat/"
                ) and not any(
                    part in name.lower()
                    for part in ("/api/", "auth", "middleware", "proxy", "security")
                ):
                    for key in ("frontend", "browser", "containers", "tls"):
                        result[key] = True
                else:
                    # Backend, contracts/client, auth/migrations, infra, CI, unknown paths.
                    result = {key: True for key in FIELDS}
    # Images are always independently produced on full release-source runs.
    applications = (
        ["frontend", "backend"]
        if result["backend"]
        else ["frontend"]
        if result["frontend"]
        else []
    )
    result["applications"] = applications
    result["verify"] = result["backend"] or result["frontend"]
    return result


def changed_files(base):
    if not re.fullmatch(r"[a-f0-9]{40}", base) or set(base) == {"0"}:
        return None
    process = subprocess.run(
        ["git", "diff", "--name-only", base, "HEAD", "--"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return process.stdout.splitlines() if process.returncode == 0 else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=os.getenv("GITHUB_OUTPUT"))
    args = parser.parse_args()
    result = classify(
        PRODUCT,
        changed_files(os.getenv("BASE_SHA", "")),
        full=os.getenv("GITHUB_EVENT_NAME") != "pull_request",
    )
    lines = [
        key + "=" + json.dumps(value, separators=(",", ":"))
        for key, value in result.items()
    ]
    if args.output:
        with open(args.output, "a") as output:
            output.write("\n".join(lines) + "\n")
    print("CI selection:", json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
