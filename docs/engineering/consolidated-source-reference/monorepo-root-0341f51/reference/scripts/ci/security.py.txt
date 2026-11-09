"""Check active root workflows and all publishable source without uploading code."""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from config import PRODUCTS, ROOT


def workflow_security_status(returncode, findings):
    blocking = [
        row
        for row in findings
        if row["determinations"]["severity"] in {"Medium", "High", "Critical"}
    ]
    allowed_exit = returncode == 0 or (
        returncode in {11, 12} and bool(findings) and not blocking
    )
    return (0 if allowed_exit and not blocking else 1), blocking


def export_source(destination):
    names = (
        subprocess.check_output(
            ["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    for name in sorted(set(names) - {""}):
        source = ROOT / name
        if source.is_symlink() or any(
            parent.is_symlink() for parent in source.parents if parent != ROOT
        ):
            raise ValueError("Secret scan refuses source aliases")
        if source.is_file():
            first, separator, relative = name.partition("/")
            scope = first if separator and first in PRODUCTS.values() else "root"
            target = destination / scope / (relative if scope != "root" else name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    checks = {}
    workflows = sorted(
        path
        for suffix in ("*.yml", "*.yaml")
        for path in (ROOT / ".github/workflows").glob(suffix)
    )
    checks["actionlint"] = subprocess.run(
        ["actionlint", "-shellcheck=", *map(str, workflows)],
        cwd=ROOT,
        check=False,
    ).returncode
    result = subprocess.run(
        [
            "zizmor",
            "--offline",
            "--strict-collection",
            "--format",
            "json",
            "--no-progress",
            str(ROOT / ".github"),
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )
    findings = json.loads(result.stdout) if result.stdout.strip() else []
    checks["zizmor"], blocking = workflow_security_status(result.returncode, findings)
    for finding in blocking:
        print(
            "Workflow security:",
            finding["ident"],
            finding["determinations"]["severity"],
        )
    count = 0
    with tempfile.TemporaryDirectory(prefix="onesa-root-security-") as folder:
        exported = Path(folder) / "source"
        export_source(exported)
        for scope in ["root", *PRODUCTS.values()]:
            target = exported / scope
            if not target.is_dir():
                raise ValueError("Source scope missing from secret scan")
            report = Path(folder) / (scope + ".json")
            config = (
                ROOT / scope / ".gitleaks.toml"
                if scope != "root"
                else ROOT / ".gitleaks.toml"
            )
            arguments = ["--config", str(config)] if config.is_file() else []
            scan = subprocess.run(
                [
                    "gitleaks",
                    "dir",
                    str(target),
                    "--redact=100",
                    "--no-banner",
                    "--log-level=error",
                    "--report-format=json",
                    "--report-path",
                    str(report),
                    *arguments,
                ],
                capture_output=True,
                text=True,
                cwd=ROOT,
                check=False,
            )
            leaks = json.loads(report.read_text()) if report.is_file() else []
            count += len(leaks)
            checks["gitleaks-" + scope] = scan.returncode or int(bool(leaks))
            for finding in leaks:
                file = Path(finding["File"])
                print(
                    "Secret finding:",
                    scope,
                    finding["RuleID"],
                    file.relative_to(target) if file.is_absolute() else file,
                    finding["StartLine"],
                )
    status = "PASS" if all(code == 0 for code in checks.values()) else "FAIL"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "checks": checks,
                "status": status,
                "zizmor_advisory_count": len(findings) - len(blocking),
                "secret_finding_count": count,
                "private_source_uploaded": False,
            },
            indent=2,
        )
        + "\n"
    )
    print("Root workflow and source security:", status)
    return int(status != "PASS")


if __name__ == "__main__":
    raise SystemExit(main())
