"""Run an existing analyzer once, annotate its results, retain its failing exit code."""

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def diagnostic(path, message, line=1, column=1, severity="ERROR"):
    absolute = Path(path).resolve()
    try:
        name = str(absolute.relative_to(ROOT))
    except ValueError:
        name = str(path)
    return {
        "message": message,
        "severity": severity,
        "location": {
            "path": name,
            "range": {
                "start": {"line": max(1, int(line)), "column": max(1, int(column))}
            },
        },
    }


def parse(kind, text):
    if kind == "eslint":
        return [
            diagnostic(
                item["filePath"],
                message["message"],
                message.get("line", 1),
                message.get("column", 1),
                "ERROR" if message["severity"] == 2 else "WARNING",
            )
            for item in json.loads(text or "[]")
            for message in item["messages"]
        ]
    if kind == "ruff":
        return [
            diagnostic(
                item["filename"],
                item["code"] + ": " + item["message"],
                item["location"]["row"],
                item["location"]["column"],
            )
            for item in json.loads(text or "[]")
        ]
    findings = []
    # tsc and mypy diagnostics; never convert a nonzero process into success.
    for line in text.splitlines():
        match = (
            re.match(r"(.+?)\((\d+),(\d+)\): error (.+)", line)
            if kind == "tsc"
            else re.match(r"(.+?):(\d+)(?::(\d+))?: error: (.+)", line)
        )
        if match:
            path, row, column, message = match.groups()
            findings.append(diagnostic(path, message, row, column or 1))
    return findings


def annotate(findings, tool, binary=None):
    reviewdog = binary or shutil.which("reviewdog")
    if not reviewdog:
        raise ValueError("Install pinned reviewdog with scripts/ci/install_tools.py")
    args = [
        reviewdog,
        "-f=rdjson",
        "-reporter=github-annotations"
        if os.getenv("GITHUB_ACTIONS")
        else "-reporter=local",
        "-filter-mode=nofilter",
        "-fail-level=none",
        "-name=" + tool,
    ]
    base = os.getenv("REVIEW_BASE_SHA", "")
    if (
        re.fullmatch("[a-f0-9]{40}", base)
        and subprocess.run(
            ["git", "cat-file", "-e", base], cwd=ROOT, capture_output=True, check=False
        ).returncode
        == 0
    ):
        args += [
            "-filter-mode=diff_context",
            "-diff=git diff --no-ext-diff --unified=3 " + base + " HEAD",
        ]
    else:
        args += ["-diff=git diff --no-ext-diff HEAD"]
    report = {"source": {"name": tool}, "diagnostics": findings}
    result = subprocess.run(
        args, input=json.dumps(report), text=True, cwd=ROOT, check=False
    )
    if result.returncode:
        raise ValueError(
            "Reviewdog could not produce annotations; analyzer result remains blocking"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["eslint", "ruff", "tsc", "mypy"])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("An analyzer command is required")
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    findings = []
    try:
        findings = parse(args.kind, result.stdout)
        if findings:
            annotate(findings, args.kind)
    except (ValueError, KeyError, TypeError) as error:
        print("Annotation failure:", str(error))
        if result.returncode == 0:
            return 1
    if args.kind in {"mypy", "tsc"} or not findings:
        print(result.stdout, end="")
    print(result.stderr, end="")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                f"\n{args.kind}: {len(findings)} finding(s); analyzer exit {result.returncode}. Findings are automated CI evidence, not independent review.\n"
            )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
