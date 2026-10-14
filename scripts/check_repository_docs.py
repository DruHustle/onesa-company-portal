"""Offline first-party documentation policy and local-link gate."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check(root=ROOT):
    findings = []
    for name in ("AGENTS.md", "README.md", "CHANGELOG.md"):
        if not (root / name).is_file():
            findings.append(f"missing canonical file: {name}")
    for name in ("CONTRIBUTING.md", "SECURITY.md"):
        if (root / name).exists() or (root / name).is_symlink():
            findings.append(f"obsolete first-party policy recreated: {name}")
    agents = root / "AGENTS.md"
    if agents.is_file() and agents.stat().st_size > 12 * 1024:
        findings.append("AGENTS.md exceeds the repository 12 KiB guard")
    changelog = root / "CHANGELOG.md"
    if changelog.is_file():
        text = changelog.read_text()
        setup = "undergoing initial setup and production qualification" in text
        baseline = "First verified protected governance deployment" in text
        if not setup and not baseline:
            findings.append("changelog lacks an explicit setup or verified baseline")
        if baseline and not all(
            (
                re.search(r"`[a-f0-9]{40}`", text),
                "hosted acceptance" in text.lower(),
                "UTC" in text,
                "Policies remain drafts" in text,
                "restricted" in text and "evidence store" in text,
            )
        ):
            findings.append("production baseline lacks source/scope/acceptance provenance")
    active = [root / name for name in ("README.md", "AGENTS.md")]
    active += [root / "docs/engineering/ENGINEERING_ONBOARDING.md"]
    for path in active:
        if not path.is_file():
            continue
        text = path.read_text()
        if re.search(r"\]\([^)]*(?:CONTRIBUTING|SECURITY)\.md", text):
            findings.append(f"active reference to removed policy: {path.relative_to(root)}")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if re.match(r"[a-z]+:", target) or target.startswith("#"):
                continue
            target = target.split("#", 1)[0]
            if target and not (path.parent / target).exists():
                findings.append(f"broken local link: {path.relative_to(root)} -> {target}")
    public = root / "docs/public"
    if public.is_dir():
        for page in public.glob("*.md"):
            if not re.search(r"(?m)^classification:\s*public\s*$", page.read_text()):
                findings.append(f"missing public classification: {page.relative_to(root)}")
    return findings


if __name__ == "__main__":
    issues = check()
    for issue in issues:
        print(issue)
    print(f"Repository documentation: {len(issues)} finding(s).")
    raise SystemExit(bool(issues))
