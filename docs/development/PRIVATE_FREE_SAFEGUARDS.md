# Private GitHub Free safeguards and implementation report

> Current pipeline: [automated review, staging qualification and owner activation](CI_CD_PIPELINE_REPORT.md). Prepared local changes are not live deployments; branch/PR optimization and automatic technical evidence supersede older manual-only details.


## Current single-owner release decision

The owner explicitly authorized the release on 2026-10-12 and waived additional
discretionary internal signatures. The credential-free authorization workflow now
accepts one owner dispatch bound to the exact qualified commit and evidence digest;
an existing review issue is optional. Actor and triggering-actor identity, exact main
CI and staging artifacts, source/image integrity, freshness and revocation checks
remain mandatory. This supersedes the historical mandatory-issue procedure below.
Authorization does not turn unexecuted operations or legal checks into PASS. Actual
provider controls, backup/restore, monitoring, privacy and material publication checks
must still be verified before deployment. Keep production credentials outside editable
repository workflows. Cloud approval never enables physical actuation.

## Verified state — 2026-10-11

This report supersedes earlier temporary-public runner guidance for the requested
private-Free operating model. No visibility, billing, ownership, remote settings,
collaborators, secrets or provider settings were changed. Nothing was pushed and no
live deployment was triggered. Changes remain on `security/private-free-safeguards`,
preserving the previous release implementation and all application features.

Read-only GitHub inspection returned **PUBLIC for all three repositories**, owned
personally by `DruHustle`, default branch `main`, owner effective permission ADMIN.
Only `DruHustle` appeared in collaborators. All returned branches were unprotected;
`main/protection` returned HTTP 404 and repository rulesets were empty. Actions were
enabled with all actions allowed and no server SHA-pinning requirement. Remote default
workflow permission is WRITE and Actions may approve PR reviews; the checked-in CI
explicitly narrows its own job token, but owner must also set the repository default
to read-only and disable Actions PR approval. No repository webhooks were returned;
that does not exclude installed GitHub App/provider integrations. Remote workflow
listings still contain the old workflows; the new release gates are local only. Portal and
Platform have Production environments with no review rules. Platform Staging has
custom branch restrictions. Robot Preview and Production have no protection rules.
Production provider secret names remain in repository secrets in each repository;
values were neither retrieved nor printed. Portal also has database credential names.
The account `GET /user` returned `plan: null`: **actual subscription is unverified**.
An owner must verify the subscription in Settings → Billing and licensing. Do not
interpret the missing API field as proof of Free. Current public eligibility also does
not demonstrate private-Free branch or environment enforcement.

Remotes remain `https://github.com/DruHustle/<repository>.git`. Feature, audit,
staging and earlier release/security branches coexist with main. Development uses
feature branches and PRs **targeting main**. There is no enforced private-Free ban
on direct pushes, merges without checks, force pushes or workflow modifications.

[GitHub branch protection availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
and [environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
confirm that these protections are unavailable for private repositories on Free.
No paid-only capability is assumed or purchased.

## Implemented behavior

Existing lint, types, test, contract, dependency audit, container vulnerability/secret
scan and production build commands are preserved. Portal runs `verify` and both
`image-security` jobs; Platform runs backend, frontend, browser, documentation,
containers, TLS acceptance and both image-security jobs; Robot runs independent
backend, frontend, both container jobs and ROS contracts. Publication hygiene is
required separately. Robot continues its existing path-aware PR checks and full
main checks. PR validation now targets main and uses disposable GitHub-hosted
runners with read-only permissions, no provider credentials and no mandatory local
runner dependency. Private Free hosted usage consumes the included quota; if it is
exhausted, incomplete checks block the release. Do not provision paid overage.
The retained private-only reusable runner is not called by these workflows; never
attach an untrusted PR to a persistent local runner or production machine.
Official Actions are pinned to API-resolved commit digests for reproducibility.

Portal and Platform's legacy `RELEASE_QUALIFICATION_JSON` approval fallback is
removed. Their native production workflows require the immutable owner review
run; missing input cannot skip verification. Production deployment/build/provider
inspection/repair jobs explicitly skip private repositories. The native protected-main
path is retained for a future **verified supported** configuration; its protection
check remains mandatory. A private-Free environment label is never treated as an
approval barrier. Public documentation hosting also skips private repositories rather
than receiving legacy production credentials.

Private-Free releases use two **credential-free manual workflows**:

1. `free-qualification.yml`: owner dispatch on current main; fetch actual GitHub
   workflow/job and immutable artifact evidence. Require latest successful **main**
   CI and hygiene, all essential jobs, both tested image digests, fresh exact-source
   staging receipt, source hash and an owner-merged feature PR whose merge commit
   equals the candidate. A newer successful staging run cannot hide failing main CI.
   Direct pushes are accepted by Git but deployment-ineligible through this gate.
2. `free-authorization.yml`: owner and triggering owner, first attempt, current main;
   re-fetch qualification and staging, require the exact evidence SHA256 reviewed by
   the owner, and an open owner-authored issue binding that SHA/digest to explicit
   operations, content/legal and external-control reviews. Decision defaults to
   **revoke**. It emits an immutable auditable authorization artifact. There is no
   input for arbitrary PASS JSON and no provider deployment step.
3. Before an externally controlled production deployment, run `free_gate.py verify`
   on an owner-reviewed clean exact-SHA checkout, outside repository Actions. It
   verifies the owner account, latest authorization run, run origin, artifact digest,
   owner issue content, current main, latest essential CI and fresh staging again.
   A later pending/failed/revoked authorization invalidates an earlier approval.
   Changed issue text, closed issue, expired artifacts/evidence, source/build changes
   or a moved main fail closed. Evidence and approval expire after 24 hours.

These workflows produce an **authorization handoff**, not proof that production was
deployed or that hosted acceptance succeeded. Source/build provenance is based on
GitHub run/artifact metadata; it is not a guarantee against a malicious repository
writer. Owners must review changes to workflows, scripts, dependencies and application
code before allowing credentialed production builds. Use an immutable owner-reviewed
verifier copy: running an altered verifier from an unreviewed checkout can bypass its
checks. The external machine and credential custody form the actual boundary.

## Staging and provider controls

`release-staging.yml` uses separate `STAGING_RENDER_API_KEY`,
`STAGING_RENDER_SERVICE_ID`, `STAGING_VERCEL_TOKEN`, `STAGING_VERCEL_ORG_ID`,
`STAGING_VERCEL_PROJECT_ID` and `STAGING_VERCEL_AUTOMATION_BYPASS_SECRET` as
needed. Existing synthetic fixtures and scoped staging database credentials stay
separate. Runtime environment variable names expected by existing provider scripts
are preserved. Production keys must not be aliases of these credentials. A separate
project/service ID alone does **not** restrict an account-wide token: use a separate
staging-only provider identity/workspace/team; verify available token scopes, and
withhold automation if that identity can access production. No token fallback occurs.

Prepared Render Blueprints set `autoDeployTrigger: off`; Vercel application and docs
configs disable Git deployments. These files do not prove settings on an existing
provider project. A writer can also change a Vercel configuration in Git. Owner must
independently disconnect production Git automation/disable auto-deploys in provider
settings, restrict provider membership, and revoke shared deployment hooks. Render
“After CI Checks Pass” alone is insufficient: it lacks the manual owner qualification
step. Exact-commit API deploys do not automatically disable Render auto-deploys.
See [Render deployment controls](https://render.com/docs/deploys) and
[Vercel Git deployment behavior](https://vercel.com/docs/git).

No isolated automatic staging integration was freshly verified, so no new automatic
provider trigger was enabled. Existing staged/manual acceptance is retained with
scoped credentials. Existing provider staging automation may remain only after the
owner confirms separate synthetic data, database, storage, domain, identity and secrets.
If automatic previews require production-capable credentials, keep them disabled.
The repository's production Git-disable setting stays in place; a separate staging-only
project can use provider-managed automation after owner isolation verification.

Robot frontend is `onesa-ai-robot-frontend` (the interface), independently built for
Vercel; cloud FastAPI backend is independently built for Render. Existing container,
ROS, API/browser and synthetic safety acceptance remain required. All new handoffs
explicitly authorize cloud software only and mark physical hardware authorization
false. No hardware install, actuator control, model download or edge physical rollout
is performed. Durable Robot Render production remains BLOCKED: the current SQLite
architecture requires persistent storage that the free Render service cannot supply.
Owner must choose and qualify a free-compatible architecture before promotion; a cloud
handoff does not resolve that blocker or authorize paid disks.

## Owner runbook and remaining actions

1. Confirm billing/subscription and intended visibility; resolve the public/private
   discrepancy. Visibility changes require separate explicit authorization. Re-read
   effective controls afterward; do not activate prepared native policies on assumption.
2. Review the local feature branch, push it when separately authorized and open PRs
   targeting main. Run existing checks, inspect workflow/security diffs and merge via
   PR. Owner-only write access is currently observed: keep it restricted; give others
   read/triage or reviewed fork-based contributions until a reviewer is authorized.
   Set default Actions token permissions to read-only, disable Actions approving PRs,
   restrict allowed actions and require immutable pins where available. Enable
   two-factor authentication and review installed apps, deploy keys, hooks and
   provider memberships. Do not give routine contributors provider production access.
3. **Before relying on private-Free isolation**, remove/rotate production provider keys,
   database credentials and production bypass/build keys from repository/organization
   secrets accessible to these repositories. Store production credentials only in the
   owner's external secret store/machine/provider account. Naming a secret PRODUCTION
   or adding a workflow `if` does not prevent another workflow reading it. Current
   remote secret names demonstrate that this migration is still required.
4. In each production provider, disable independent Git pushes/hooks as deployment
   triggers. Capture readback/screenshots of provider settings without credentials.
   These changes were intentionally not performed because remote settings were excluded
   from authorization. Configure staging-only identities/secrets and verify isolation.
5. Obtain exact-SHA staging acceptance. Portal/Platform can advance their authorized
   staging branch to the merged main SHA through the normal review process; never
   invent staging PASS. Robot stages current main. All staging/provider prerequisites
   in `docs/engineering/AUTOMATED_QUALIFICATION.md` still apply.
6. Dispatch Free release qualification on main with the successful staging run ID.
   Read its artifact and printed evidence digest. Create an owner-authored repository
   issue recording the candidate SHA, digest, reviewed operations/rollback/backup,
   content/legal version and provider/credential readback. Include the literal review
   markers `OPERATIONS_APPROVED`, `CONTENT_LEGAL_APPROVED` and
   `EXTERNAL_PRODUCTION_CONTROLS_VERIFIED` only after doing those reviews. These are
   human acknowledgments attached to owner provenance, not an automated certification.
7. Dispatch Free release authorization with qualification run ID, digest, issue number
   and explicit approve. Audit the run and immutable artifact; revoke via a new
   authorization dispatch or close the review issue when approval should be withdrawn.
8. On the trusted external machine, with only read GitHub credentials initially, review
   and check out that exact commit. Keep the verifier itself pinned/reviewed and run:

   ```sh
   python3 scripts/release/free_gate.py verify --sha <40-character-SHA> \
     --authorization-run <run-ID> --output /private/tmp/onesa-production-handoff.json
   ```

   The command performs read-only validation and triggers no deployment. Re-run
   immediately before each independently authorized provider operation. Only then
   load the separate production credential in the external deployment process. Build
   the Vercel output from the reviewed source using production configuration; keep its
   digest/private build outside CI artifacts, review it and deploy prebuilt output.
   Render must deploy the exact approved SHA, not latest main. Use the existing
   `scripts/deploy_render.py` exact-commit helper only after explicit production
   authorization, with externally supplied service/token and `GITHUB_SHA`. Verify
   provider commit/deployment IDs and run existing hosted acceptance; record private
   deployment receipts, rollback and any partial deployment. Stop if main/approval
   changes; this is a manual external procedure, not an installed deployment service.
9. Perform the authorized remote negative demonstration after installation: open a
   synthetic feature PR with a failing test, observe failed CI, and attempt qualification
   without a live deployment. It must fail. Repair through the PR flow and requalify.
   This demonstrates workflow denial, **never rejection of the underlying Git push**.
   No failing branch, remote workflow run or live deployment was created in this task.

## Enforcement boundaries

| Control | Enforced by | Practical limit |
| --- | --- | --- |
| Repository identity/access, read-only job token, fork secret restrictions, immutable artifact metadata | GitHub | Writers/admins can change workflows and permissions; repository secret masking is not isolation |
| PR CI job failure and exact-SHA gate denial | Checked-in Actions and external verifier | Stops this authorized path; does not block Git push/merge or arbitrary replacement workflows |
| Production credentials absent from editable repository CI | External owner custody after migration | **Not yet active remotely**; current repository keys must be removed/rotated by owner |
| Production Git/deploy-hook automation disabled | Provider account settings after verified owner action | Local configs are prepared; existing service settings not freshly verified |
| Manual owner issue/dispatch/digest, revocation, freshness | Workflow/API provenance and trusted external verifier | Owner must review source; writable repository cannot police a malicious workflow author by itself |
| Feature branches, PR targeting main, solo-owner merge review | Team discipline plus release eligibility check | Direct pushes and unchecked merges remain possible on private Free |
| Hardware/robot physical authorization | Separate owner/hardware safety process | Cloud approval never grants physical authority; current software cannot actuate hardware |

[GitHub's security guidance](https://docs.github.com/en/actions/reference/security/secure-use)
explicitly states that repository writers can access repository secrets. Therefore
neither CI, owner-actor checks, CODEOWNERS nor environment labels are claimed to
provide native private-Free server enforcement or tamper-proof credential protection.

## Local verification and prepared demonstration

Run the local demonstration with `python3 scripts/release/demo_free_gate.py`. It
prints a passing handoff followed by BLOCKED, zero provider calls and
`git_push_blocked: false`. Then run `python3 -m unittest discover -s scripts/release -p 'test_*.py'` and
`actionlint .github/workflows/*.yml`, then publication hygiene and `git diff --check`.
The shared fixture uses synthetic GitHub API responses but the real gate functions,
CI job validation and stage/source/build checks. It first produces a valid external
handoff, then changes an essential CI job to failure: verification raises BLOCKED
before a provider can be called. The gate contains no provider API invocation.
Additional negative tests cover skipped/missing/cancelled jobs, wrong commit/fork,
unauthorized actors, re-runs, arbitrary PASS JSON, stale staging, moved main, owner
issue changes/closure, unreviewed digest and later revocation/pending approval.
Workflow boundary tests check private production job exclusion, credential-free
manual authorization, separate staging keys and PR isolation. Results are local;
remote installation and provider controls remain owner actions, not verified claims.
Application runtime source, contracts, data and dependencies are unchanged by this task.

Verified local result: 39 release tests passed; Actions syntax, synthetic failure demonstration, publication/history hygiene and whitespace checks passed. Existing CI application run commands were compared against HEAD and preserved (apart from expanding the release test discovery and removing retired legacy deployment steps). Full application/browser/container suites were not rerun for this workflow/documentation-only change.
