#!/usr/bin/env python3
"""Root-owned pre-job gate: query actual visibility before any repository code."""

import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen


def verify(config):
    repository = config["repository"]
    if os.environ.get("GITHUB_REPOSITORY") != repository:
        raise SystemExit("Runner repository mismatch; execution denied")
    token = os.environ.get("ONESA_CI_TOKEN", "")
    if not token:
        raise SystemExit("Scoped job token missing; visibility cannot be verified")
    request = Request(
        "https://api.github.com/repos/" + repository,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "onesa-runner-visibility-policy",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.load(response)
    except (OSError, ValueError):
        raise SystemExit("Visibility API unavailable; execution denied") from None
    if result.get("full_name") != repository or result.get("private") is not True:
        raise SystemExit(
            "Repository is public or identity changed; local execution denied"
        )
    print("Actual repository visibility verified private", flush=True)


if __name__ == "__main__":
    verify(json.loads(Path(sys.argv[1]).read_text()))
