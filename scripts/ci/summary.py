"""Fail CI visibly for an expected job that failed, was cancelled or unexpectedly skipped."""

import json
import os
import sys


def check(selection, results, product):
    mapping = (
        {"verify": "verify", "image-security": "containers"}
        if product == "onesa-company-portal"
        else {
            "backend": "backend",
            "frontend": "frontend",
            "browser": "browser",
            "documentation": "documentation",
            "containers": "containers",
            "tls-acceptance": "tls",
            "image-security": "containers",
        }
        if product == "onesa-ai-platform"
        else {
            "backend": "backend",
            "frontend": "frontend",
            "containers": "containers",
            "ros-contracts": "edge",
        }
    )
    failures = []
    if results.get("changes", {}).get("result") != "success":
        failures.append("CI path classification failed")
    if results.get("pipeline-security", {}).get("result") != "success":
        failures.append("Static workflow/secret security did not pass")
    for job, flag in mapping.items():
        if selection.get(flag) not in {"true", "false"}:
            failures.append("Missing/invalid CI selection: " + flag)
        state = results.get(job, {}).get("result", "missing")
        if state in {"failure", "cancelled"} or (
            selection.get(flag) == "true" and state != "success"
        ):
            failures.append(job + ": " + state)
    return failures


def main():
    from pathlib import Path

    product = Path(__file__).resolve().parents[2].name
    failures = check(
        json.loads(os.environ["CI_SELECTION"]),
        json.loads(os.environ["CI_RESULTS"]),
        product,
    )
    print(
        "CI checks failed: " + ", ".join(failures)
        if failures
        else "All checks required for this change passed"
    )
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(
                "\nCI result: "
                + (
                    "FAIL\n\n" + "\n".join("- " + item for item in failures)
                    if failures
                    else "PASS; all expected checks succeeded"
                )
                + "\n"
            )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
