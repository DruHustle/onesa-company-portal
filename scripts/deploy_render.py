"""Deploy an exact Git commit to Render and wait for its result; never log secrets."""

import json
import os
import re
import time
import urllib.error
import urllib.request


def request(path, token, payload=None):
    req = urllib.request.Request(
        "https://api.render.com/v1/" + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(
            f"Render API returned HTTP {error.code}; inspect provider settings"
        ) from None
    except (urllib.error.URLError, TimeoutError):
        raise SystemExit(
            "Render API connection failed; check deployment status before retrying"
        ) from None


def main():
    token = os.environ.get("RENDER_API_KEY", "")
    service = os.environ.get("RENDER_SERVICE_ID", "")
    sha = os.environ.get("GITHUB_SHA", "")
    if not token or not re.fullmatch(r"srv-[a-zA-Z0-9]+", service):
        raise SystemExit(
            "Configure RENDER_API_KEY and the requested Render service ID in GitHub secrets"
        )
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise SystemExit("Deployment requires an exact GitHub commit SHA")
    deployment = request(
        f"services/{service}/deploys",
        token,
        {"commitId": sha, "clearCache": "do_not_clear"},
    )
    identifier = deployment.get("id", "")
    if not re.fullmatch(r"dep-[a-zA-Z0-9]+", identifier):
        raise SystemExit("Render did not return a deployment ID")
    print(f"Render deployment {identifier} requested for {sha}")
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        deployment = request(f"services/{service}/deploys/{identifier}", token)
        status = deployment.get("status", "unknown")
        print(f"Render status: {status}", flush=True)
        if status == "live":
            if deployment.get("commit", {}).get("id") != sha:
                raise SystemExit(
                    "Render deployed a different commit; deployment verification failed"
                )
            print("Exact-commit Render deployment is live")
            return
        if status in {
            "build_failed",
            "update_failed",
            "pre_deploy_failed",
            "canceled",
            "deactivated",
        }:
            raise SystemExit(
                f"Render deployment ended with {status}; inspect provider logs"
            )
        time.sleep(15)
    raise SystemExit(
        "Render deployment timed out; check provider state before retrying"
    )


if __name__ == "__main__":
    main()
