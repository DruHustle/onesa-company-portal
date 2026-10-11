"""Local workflow/secret security checks; no analysis service or source upload."""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def exported_source(destination):
    names = (
        subprocess.check_output(
            ["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"], cwd=ROOT
        )
        .decode()
        .split("\0")
    )
    for name in sorted(set(names) - {""}):
        source = ROOT / name
        if source.is_symlink():
            raise ValueError(
                "Secret scan refuses source symlinks; review required: " + name
            )
        if source.is_file():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def workflow_security_status(returncode, findings):
    blocking = [
        x
        for x in findings
        if x["determinations"]["severity"] in ("Medium", "High", "Critical")
    ]
    allowed_exit = returncode == 0 or (
        returncode in (11, 12) and bool(findings) and not blocking
    )
    return (0 if allowed_exit and not blocking else 1), blocking


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    workflows = sorted((ROOT / ".github/workflows").glob("*.yml"))
    checks = {}
    if ROOT.name == "onesa-company-portal":
        checks["documentation"] = subprocess.run(
            ["python3", "scripts/validate-docs.py"], cwd=ROOT, check=False
        ).returncode
    # No shell interpolation, online zizmor APIs or remote SARIF upload.
    checks["actionlint"] = subprocess.run(
        ["actionlint", "-shellcheck=", *map(str, workflows)], cwd=ROOT, check=False
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
    print(
        "Zizmor:",
        len(blocking),
        "blocking and",
        len(findings) - len(blocking),
        "advisory findings",
    )
    for finding in blocking:
        print(
            "Workflow security:",
            finding["ident"],
            finding["determinations"]["severity"],
        )
    with tempfile.TemporaryDirectory(prefix="onesa-secret-scan-") as folder:
        target = Path(folder) / "source"
        target.mkdir()
        exported_source(target)
        report = Path(folder) / "gitleaks.json"
        config = ROOT / ".gitleaks.toml"
        config_args = ["--config", str(config)] if config.exists() else []
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
                *config_args,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        leaks = json.loads(report.read_text()) if report.exists() else []
        checks["gitleaks"] = scan.returncode or int(bool(leaks))
        # Never print matched credential/source values or upload the raw scanner report.
        print("Gitleaks:", len(leaks), "finding(s)")
        for finding in leaks:
            print(
                "Secret finding:",
                finding["RuleID"],
                Path(finding["File"]).relative_to(target)
                if Path(finding["File"]).is_absolute()
                else finding["File"],
                finding["StartLine"],
            )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "checks": checks,
                "status": "PASS" if all(v == 0 for v in checks.values()) else "FAIL",
                "zizmor_advisory_count": len(findings) - len(blocking),
                "secret_finding_count": len(leaks),
                "private_source_uploaded": False,
            },
            indent=2,
        )
        + "\n"
    )
    return 0 if all(v == 0 for v in checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
