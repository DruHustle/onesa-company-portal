"""Credential-free private-Free release handoff; never a Git push restriction.

Run the external verifier from an owner-reviewed, immutable copy on a trusted machine.
Repository writers can change this file and Actions; withholding production credentials
outside GitHub is the security boundary. No caller-supplied PASS document is accepted.
"""

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone

import evidence as e

WORKFLOW = "free-authorization.yml"
QUALIFICATION = "free-qualification.yml"


def current_main(github, sha):
    e.require(re.fullmatch(r"[a-f0-9]{40}", sha) is not None, "Exact commit required")
    branch = github.api(f"repos/{e.REPOSITORY}/branches/main")
    e.require(branch["commit"]["sha"] == sha, "Candidate is not current main")
    pages = github.api(
        f"repos/{e.REPOSITORY}/commits/{sha}/pulls?per_page=100", pages=True
    )
    details = [
        github.api(f"repos/{e.REPOSITORY}/pulls/{pr['number']}")
        for page in pages
        for pr in page
    ]
    matches = [
        pr
        for pr in details
        if pr.get("merged_at")
        and pr.get("merge_commit_sha") == sha
        and pr["base"]["ref"] == "main"
        and pr["base"]["repo"]["full_name"] == e.REPOSITORY
        and pr.get("merged_by", {}).get("login") == e.OWNER
        and pr["head"]["ref"] != "main"
    ]
    e.require(
        matches,
        "Main candidate needs an owner-merged feature PR; a direct push is deploy-ineligible",
    )
    return matches[0]["html_url"]


def qualification(github, sha, run, staging_run):
    e.require(
        run["event"] in {"workflow_dispatch", "workflow_run"},
        "Untrusted qualification event",
    )
    e.trusted_run(
        run, QUALIFICATION, sha, {"main"}, event=run["event"], completed=False
    )
    e.require(
        run["actor"]["login"] == e.OWNER
        and run["triggering_actor"]["login"] == e.OWNER,
        "Qualification requires owner provenance",
    )
    pr = current_main(github, sha)
    code, references = e.checked_ci(github, sha)
    e.require(
        code == "PASS",
        "Essential exact-commit CI failed or is incomplete: authorized deployment blocked",
    )
    # Do not permit staging-branch CI to substitute for main CI.
    for reference in references:
        e.require(
            github.run(reference["run_id"])["head_branch"] == "main",
            "Main CI is required",
        )
    builds = e.artifacts_for_ci(github, references)
    stage_run = github.run(staging_run)
    e.trusted_staging_run(github, stage_run, sha)
    stage, origin = github.artifact(stage_run, "staging-verification")
    fingerprint = e.source_hash()
    e.require(
        e.verify_stage(stage, sha, fingerprint, builds) == "PASS",
        "Staging qualification missing",
    )
    return {
        "schema_version": 1,
        "repository": e.REPOSITORY,
        "candidate_commit": sha,
        "source_sha256": fingerprint,
        "target_environment": "Production",
        "pull_request": pr,
        "ci": references,
        "builds": builds,
        "staging": {"record": stage, "artifact": origin},
        "verified_at": run["created_at"],
        "workflow_run_id": run["id"],
        "status": "AWAITING_OWNER_AUTHORIZATION",
        "CODE_VERIFIED": "PASS",
        "STAGING_VERIFIED": "PASS",
        "OPERATIONS_VERIFIED": "BLOCKED",
        "CONTENT_LEGAL_APPROVED": "BLOCKED",
        "operations_evidence": {
            "scope": "technical staging readiness only",
            "checks": stage["checks"],
            "missing": [
                "verified alert delivery",
                "off-host restore and rollback approval",
                "operating limits review",
            ],
        },
        "security_status": "PASS",
        "approval_provenance": None,
        "scope": "cloud-software-only",
        "physical_hardware_authorized": False,
    }


def live_qualification(github, sha, identifier):
    run = github.run(identifier)
    e.trusted_run(run, QUALIFICATION, sha, {"main"}, event=run["event"])
    record, origin = github.artifact(run, "free-release-qualification")
    e.require(
        record.get("workflow_run_id") == run["id"], "Qualification origin mismatch"
    )
    e.require(
        e.fresh(record["verified_at"], datetime.now(timezone.utc)),
        "Qualification expired",
    )
    refreshed = qualification(github, sha, run, record["staging"]["artifact"]["run_id"])
    e.require(
        refreshed == record, "Qualification changed: fresh CI/staging review required"
    )
    return record, origin


def owner_issue(github, number, sha, fingerprint):
    e.require(str(number).isdigit(), "Owner review issue number required")
    issue = github.api(f"repos/{e.REPOSITORY}/issues/{number}")
    e.require(
        issue["state"] == "open" and issue["user"]["login"] == e.OWNER,
        "An open owner-authored review record is required",
    )
    body = issue.get("body") or ""
    required = (
        sha,
        fingerprint,
        "OPERATIONS_APPROVED",
        "CONTENT_LEGAL_APPROVED",
        "EXTERNAL_PRODUCTION_CONTROLS_VERIFIED",
    )
    e.require(
        all(text in body for text in required),
        "Owner record must bind SHA, evidence digest and explicit reviews",
    )
    return {
        "url": issue["html_url"],
        "number": int(number),
        "body_sha256": e.digest(body),
    }


def authorize(github, sha, run, qualification_run, fingerprint, review_issue, decision):
    e.trusted_run(run, WORKFLOW, sha, {"main"}, completed=False)
    current_main(github, sha)
    e.require(decision in {"approve", "revoke"}, "Explicit decision required")
    record = {
        "repository": e.REPOSITORY,
        "candidate_commit": sha,
        "workflow_run_id": run["id"],
        "approved_at": run["created_at"],
        "approver": e.OWNER,
        "decision": decision,
        "target_environment": "Production",
        "physical_hardware_authorized": False,
    }
    if decision == "approve":
        qualified, origin = live_qualification(github, sha, qualification_run)
        e.require(
            e.digest(qualified) == fingerprint,
            "Owner must review the exact derived evidence digest",
        )
        record.update(
            qualification=origin,
            evidence_sha256=fingerprint,
            source_sha256=qualified["source_sha256"],
            owner_review=(
                owner_issue(github, review_issue, sha, fingerprint)
                if review_issue
                else {
                    "source": "owner-workflow-dispatch",
                    "workflow_run_id": run["id"],
                    "candidate_commit": sha,
                    "evidence_sha256": fingerprint,
                    "approver": e.OWNER,
                }
            ),
        )
    return record


def verify(github, sha, identifier):
    # Latest revocation/failure/pending dispatch invalidates any older approval.
    runs = github.runs(WORKFLOW, sha)
    e.require(
        runs and str(runs[0]["id"]) == str(identifier),
        "Only the latest owner authorization is usable",
    )
    run = github.run(identifier)
    e.trusted_run(run, WORKFLOW, sha, {"main"})
    approval, origin = github.artifact(run, "free-production-authorization")
    e.require(approval.get("decision") == "approve", "Production authorization revoked")
    e.require(
        e.fresh(approval["approved_at"], datetime.now(timezone.utc)),
        "Authorization expired",
    )
    refreshed = authorize(
        github,
        sha,
        run,
        approval["qualification"]["run_id"],
        approval["evidence_sha256"],
        approval["owner_review"].get("number"),
        "approve",
    )
    e.require(approval == refreshed, "Approval or owner review changed")
    return {
        "status": "AUTHORIZED_EXTERNAL_HANDOFF",
        "approval": approval,
        "artifact": origin,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "deployment_triggered": False,
        "git_push_prevented": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["qualify", "authorize", "verify"])
    parser.add_argument("--sha", default=os.getenv("GITHUB_SHA"))
    parser.add_argument("--staging-run", default=os.getenv("STAGING_RUN"))
    parser.add_argument("--qualification-run", default=os.getenv("QUALIFICATION_RUN"))
    parser.add_argument("--evidence-digest", default=os.getenv("EVIDENCE_DIGEST"))
    parser.add_argument("--review-issue", default=os.getenv("REVIEW_ISSUE"))
    parser.add_argument("--decision", default=os.getenv("REVIEW_DECISION", "revoke"))
    parser.add_argument("--authorization-run")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    github = e.GitHub()
    sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=e.ROOT, text=True
    ).strip()
    e.require(sha == args.sha, "Checkout differs from candidate")
    e.require(
        not subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=normal"], cwd=e.ROOT
        ),
        "Clean reviewed checkout required",
    )
    if args.mode == "verify":
        e.require(
            not os.getenv("GITHUB_ACTIONS"),
            "Private production handoff must run outside repository Actions",
        )
        actor = json.loads(subprocess.check_output(["gh", "api", "user"], text=True))[
            "login"
        ]
        e.require(
            actor == e.OWNER, "External production verifier requires owner identity"
        )
        record = verify(github, sha, args.authorization_run)
    else:
        e.require(
            os.getenv("GITHUB_REF") == "refs/heads/main",
            "Owner dispatch on main required",
        )
        run = github.run(os.environ["GITHUB_RUN_ID"])
        record = (
            qualification(github, sha, run, args.staging_run)
            if args.mode == "qualify"
            else authorize(
                github,
                sha,
                run,
                args.qualification_run,
                args.evidence_digest,
                args.review_issue,
                args.decision,
            )
        )
    e.save(record, args.output)
    print("Evidence SHA256:", e.digest(record))


if __name__ == "__main__":
    try:
        main()
    except (e.Rejected, KeyError, TypeError, ValueError) as error:
        raise SystemExit("BLOCKED: " + str(error)) from None
