# GitHub Free operating plan

Policy selected: GitHub Free, private repositories, no paid provisioning or visibility changes. The repositories remain under the verified personal account `DruHustle`; no transfer or new repository is required.

## What Free can support here

- Keep repository access limited to explicitly authorized collaborators. Only DruHustle was returned by the authenticated collaborator inventory; add independent reviewers only when real people are available.
- Use `feature/`, `fix/` and `security/` branches, pull requests, existing GitHub Actions, issue templates and private security reporting through an existing private owner channel. Do not assume GitHub private vulnerability reporting is enabled.
- Keep the existing unfiltered PR test/build/security workflows. Use the exact successful check names listed in [the protection report](BRANCH_PROTECTION_REPORT.md), including image-security checks. Inspect all checks before manually merging; failures, missing checks and unresolved discussions block merges by policy.
- Use zero independent approvals while there is one developer. Add independent review when an authorized reviewer joins. Never substitute the author's own approval for independent review.
- Keep Actions spending disabled through the account's authorized billing controls and monitor included usage. This task did not change billing or spending settings. If quota is exhausted, wait for its reset or resolve the capacity constraint; do not bypass tests, deploy unverified revisions or silently enable paid usage.

## Required day-to-day workflow

1. Inspect Git state and preserve existing work. Create a feature/fix/security branch from current reviewed main; use an isolated checkout when unrelated changes would enter the PR.
2. Implement the change and run relevant local tests and publication hygiene. Commit only reviewed files. Push the feature branch when authorized and open a PR.
3. Inspect GitHub checks on the latest revision. All applicable checks in the report must pass; resolve review conversations. Keep CI/security gates intact and avoid skip-CI directives.
4. When main changes, merge current main into the feature branch without rewriting main and wait for fresh checks. Review the diff, source revision and target branch immediately before merging.
5. Merge through the GitHub PR interface only with corresponding authorization. Do not use direct main pushes, force pushes, deletion or administrator bypass in ordinary work. This is a contributor policy under Free, not server-enforced protection.
6. Keep deployment separate: PR/feature previews use isolated settings; staging uses its explicit branch and resources; production requires separately authorized promotion of a verified main revision. Check provider branch, native auto-deploy and preview-secret isolation before promotion. Existing provider gaps are documented in the report; this plan does not repair or certify them.

## Limits that cannot be removed on the current plan

GitHub rejected repository ruleset creation and classic main protection with HTTP 403. Main remains unprotected: Free cannot currently enforce mandatory PRs, checks, conversation resolution, independent approvals, force-push blocking or deletion blocking on these private repositories. A contributor or integration with write access can still bypass the voluntary workflow. PR templates, local hooks, scripts, Actions and local ruleset JSON do not replace GitHub enforcement. Do not claim accidental or unauthorized main changes are technically prevented.

Keep the least practical repository write access and no new App privileges. Do not grant broad bypass permissions or use credentials in PR CI. Account-wide App installation permissions could not be fully inventoried with the available token; verify them in authorized account settings before extending access. Production environment reviewer enforcement and secret isolation are not verified; manual authorization and existing exact-revision workflow qualification remain required where implemented.

[Prepared ruleset and fallback payloads](branch-protection/ACTIVATION.md) are retained as reference only. They are not part of the GitHub Free operating procedure and must not be applied repeatedly while eligibility is blocked. No paid upgrade, public-repository workaround or owner transfer is proposed by this plan. If strict server enforcement becomes mandatory, the owner must revisit the hosting/eligibility constraint in a separate decision.

## Acceptance on GitHub Free

- Actual repository protections are reported as **BLOCKED — NOT ENFORCED**.
- PR check names and successful historical runs are verified, and local workflow names are unambiguous.
- Governance, security reporting, issue/PR templates and administrator recovery instructions are available.
- Work proceeds through authorized feature-branch PRs with manual check/review/merge discipline.
- Main enforcement and secure production acceptance remain explicit limitations; no merge or deployment was performed to demonstrate them.
