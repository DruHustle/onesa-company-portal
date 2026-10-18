# Main branch protection — current public repository state

Verified 2026-10-18: **ENFORCED** for `DruHustle/onesa-company-portal`. Repository visibility
is public, default branch is `main`, and owner administrative access was verified.
Classic branch protection is active; no ruleset or paid plan was added.

- Require a PR, with **zero required independent approvals** for the solo owner.
- Require current-base checks from GitHub Actions (App `15368`), including the
  unconditional fail-closed `ci-summary`, publication hygiene and workflow security.
- Enforce for administrators; prohibit force pushes and branch deletion; require
  resolved review conversations. No permanent bypass allowance is configured.
- Required checks: `changes`, `ci-summary`, `image-security (clamav)`, `image-security (onesa-company-portal-backend)`, `image-security (onesa-company-portal-frontend)`, `pipeline-security / workflow-security`, `publication-hygiene`, `verify`.

Path-selected jobs can legitimately be skipped on unrelated PRs. The unconditional
summary verifies the selection and requires every selected job to succeed, including
aggregate matrix results. A cancelled, failed or unexpectedly skipped selected job
fails the summary. Release-source pushes run full coverage. Portal includes its
ClamAV runtime image scan. Do not require a workflow that can disappear via top-level
path filtering. A pending/failed required check must block the normal PR path.

Normal promotion remains `dev → staging → main`; temporary security-fix branches
remain permitted. Production credentials and the qualified external release verifier
remain outside PR execution. Branch protection is not production authorization.
An administrator can still edit repository settings; this is not immutable governance.

Prepared payloads use verified successful PR check names and the personal-repository
schema. An initial HTTP 422 rejected an empty organization-only bypass field; it
changed no protection. The corrected PUT and GET succeeded on all three repositories.
Restricted before/after receipts and harmless PR enforcement observations are retained
in the existing remediation evidence index. PR merge-behaviour acceptance is pending
until the current normally promoted candidate supplies those observations.

## Historical inspection — superseded, not current configuration

The following original report describes the earlier private-repository inspection.
Its plan failures, provider observations and pending settings are historical only.
Current public-state enforcement above supersedes those claims; no visibility or
billing change was made by this remediation.

<details><summary>Preserved historical report</summary>

# Branch protection report

Inspected 2026-10-10T21:30:44+02:00 (Europe/Berlin). **BLOCKED — NOT ENFORCED.**

## Repository and eligibility

- Repository: [onesa-company-portal](https://github.com/DruHustle/onesa-company-portal).
- Authenticated owner: `DruHustle`, a personal User account; administrative permission verified.
- Default/intended branch: `main`; remote revision `db505c89131788c05809ab240f3617ff1a99137f`.
- Visibility: private. Only collaborator returned: `DruHustle` with admin access.
- The user API did not expose a plan name. Actual feature eligibility is conclusively blocked by GitHub's plan-specific HTTP 403 response; do not infer a billing plan from a missing field.
- Personal private repositories need GitHub Pro eligibility for these protections. No organization ruleset applies to these personally owned repositories. A future approved organization policy would require suitable organization plan eligibility.

## Actual GitHub state and application attempts

`GET branches/main` reports `protected: false`, protection disabled and no required checks. Ruleset listing, branch-protection inspection and effective-rule APIs return HTTP 403; their full configurations cannot be inventoried, so no claim is made that no inactive rules exist.

Attempted `POST /repos/DruHustle/onesa-company-portal/rulesets`, then the supported fallback `PUT /repos/DruHustle/onesa-company-portal/branches/main/protection`. Both returned HTTP 403:

> Upgrade to GitHub Pro or make this repository public to enable this feature.

Subsequent branch readback still reports `protected: false`; effective rules and branch-protection readback remain HTTP 403. **No new rules were applied.** Force-push prevention, deletion prevention, mandatory PRs, CI enforcement and review-conversation enforcement remain unavailable. No billing, visibility, credentials, provider settings or branches were deleted/rewritten. No blanket bypass was granted.

## GitHub Free operating policy

The owner selected GitHub Free. Follow [the Free operating plan](FREE_GITHUB_PLAN.md): private repositories, voluntary PR/check/review discipline, least practical write access and separately authorized production promotion. No upgrade or visibility change is proposed. Main protection remains BLOCKED, NOT ENFORCED; prepared API payloads are reference only.

## Prepared configuration — not active

[Ruleset payload](branch-protection/main.ruleset.json) targets exactly `refs/heads/main`, requests active enforcement, prevents deletion and non-fast-forward pushes, requires PRs and resolved conversations, and requires the checks below from GitHub Actions (observed app ID `15368`). [Fallback branch protection](branch-protection/main.branch-protection.json) applies the equivalent policy, including administrator enforcement. Apply one mechanism only after rechecking existing protections.

Solo-developer review count is zero; no independent authorized reviewer was discovered. CODEOWNERS is intentionally absent to avoid inventing an unavailable owner/reviewer. Stale approvals are dismissed; code-owner approval and last-pusher independent approval remain off. Once an authorized independent reviewer is available, require at least one approval and last-push approval; add verified CODEOWNERS for security/workflows/infrastructure. Seek two independent reviews for sensitive changes when the team can supply them. GitHub does not permit authors to approve their own PRs; no solo self-approval workaround is proposed.

The ruleset bypass list is empty. No admin, deploy key or App receives permanent bypass. Emergency recovery uses an authorized, documented temporary policy edit rather than ordinary development bypass.

## Actual CI names and coverage

| Check | Successful pull-request evidence |
| --- | --- |
| `verify` | [Job 114233624224](https://github.com/DruHustle/onesa-company-portal/actions/runs/38059134798/job/114233624224) |
| `publication-hygiene` | [Job 114233623921](https://github.com/DruHustle/onesa-company-portal/actions/runs/38059134767/job/114233623921) |
| `image-security (onesa-company-portal-backend)` | [Job 114233624272](https://github.com/DruHustle/onesa-company-portal/actions/runs/38059134798/job/114233624272) |
| `image-security (onesa-company-portal-frontend)` | [Job 114233624146](https://github.com/DruHustle/onesa-company-portal/actions/runs/38059134798/job/114233624146) |


These checks were observed on successful PR jobs and on main checks. PR workflows have no path filters, conditional required jobs or real-model/GPU/production/hardware dependency. Matrix security checks scan both runtime images where implemented; failing scans remain required. The platform TLS check uses isolated local containers, not a public production deployment. Robot checks now cover authenticated software simulation, proxy/browser behavior and both runtime image security gates; physical actuation remains outside their scope.

Local `deploy.yml` display names now use `deploy-qualification`, `deploy-frontend` and `deploy-backend` plus `deploy-worker`. Job IDs, dependency expressions and deployment behavior are preserved. This removes collisions with required CI checks. These edits are included in the reviewed candidate; verify the resulting names after an authorized PR merge before activating the payload.

Strict up-to-date checks are prepared because one active contributor limits update churn. Existing `pull_request` triggers run without path filters on PR synchronization. Updating a PR against changed main and enforcement of pending/failing checks were not tested under active protection because eligibility is blocked. No merge queue is enabled. Skip-CI commit directives can leave required checks pending and must not be used.

## Deployment and integration review

Manual `deploy.yml` requires the current main revision, successful push CI/hygiene and a matching reviewed release qualification. It does not deploy on a PR. `release.yml` packages one application and references lowercase `production`, whereas the inspected provider environment is `Production`; environment approval enforcement must be checked before release.

The existing read-only hosting inspection reports Render API auto-deploy disabled, but the configured worker target has auto-deploy enabled and is a web service rather than a background worker. The API's last deployment failed and its direct health request returned no response. Vercel production is READY at an older revision, with required BACKEND_URL and PROXY_SHARED_KEY absent according to that inspection. The inspector does not verify Vercel's production branch or preview-secret isolation. These findings block a claim of secure/functional production deployment; review the provider setup before promotion. No provider changes or deployments were made.

GitHub environments have no required-reviewer rules on Production. No production approval or branch restriction is claimed. Inspected environments have no deployment branch restrictions. Manual deployment jobs expose repository secrets without protected-environment binding; PR CI itself does not reference production secrets. Restrict production secrets to appropriate protected environments after eligibility and reviewer availability are confirmed; existing credentials were not moved or changed. Native provider integrations must independently target approved main for production, isolate preview secrets and respect review/CI promotion gates.

Repository webhook listing returned empty. Vercel bot deployment evidence is present. Complete GitHub App installation inventory failed with HTTP 403 because the available token is not a GitHub App user access token; installation permission scope and all app grants remain unverified. No App bypass exists in the prepared policy, and no bypass was applied remotely.

## Verification and next activation

[Sanitized API evidence](branch-protection/verification-evidence.json) records application rejection, protected=false readback, effective-rule rejection, actual checks, PR jobs, collaborators and deployment metadata. The hosting inspection source is [38077726204](https://github.com/DruHustle/onesa-company-portal/actions/runs/38077726204).

No destructive main test was performed. No test PR was created because it cannot demonstrate protection enforcement under this plan. Existing passing PR CI demonstrates runnable checks, not enforced merge blocking. Pending/failing checks and successful authorized merging remain unverified until activation.

Use [the GitHub Free operating plan](FREE_GITHUB_PLAN.md) now. The [activation/recovery procedure](branch-protection/ACTIVATION.md) is retained only for a future separately authorized change in eligibility; no paid activation is part of the selected plan. The repository-level settings task is blocked by GitHub eligibility; local governance changes are prepared on `security/main-branch-governance`, with earlier uncommitted work preserved. These changes are being published on the reviewed candidate branch. This does not activate server protection or authorize automatic merging/production releases.

## Local validation

All 4 selected contexts match observed successful PR jobs and resolve uniquely in local workflows. YAML/configuration checks confirmed unfiltered PR triggers, unconditional required jobs, strict synchronization, empty bypass, solo review settings and equivalent ruleset/fallback checks. Edited workflow display names preserve the executable job structure compared with remote main. Relative report/policy links, `git diff --check` and publication hygiene passed (zero heuristic findings; manual data review remains necessary). Portal required-document validation also passed. No application code changed for this task; full application tests were not rerun. These local checks do not establish remote enforcement or hosted readiness.

## Workspace summary

| Repository | Owner | Default | Visibility | Enforcement |
| --- | --- | --- | --- | --- |
| [onesa-company-portal](https://github.com/DruHustle/onesa-company-portal) | DruHustle (personal) | main | private | **BLOCKED — NOT ENFORCED** |
| [onesa-ai-platform](https://github.com/DruHustle/onesa-ai-platform) | DruHustle (personal) | main | private | **BLOCKED — NOT ENFORCED** |
| [onesa-ai-robot](https://github.com/DruHustle/onesa-ai-robot) | DruHustle (personal) | main | private | **BLOCKED — NOT ENFORCED** |


## Sources

[GitHub ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) · [Ruleset REST API](https://docs.github.com/en/rest/repos/rules) · [Branch-protection REST API](https://docs.github.com/en/rest/branches/branch-protection).

</details>
