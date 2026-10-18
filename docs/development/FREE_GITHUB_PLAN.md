# GitHub Free, hosted validation and visibility transition

## Owner-managed visibility transition on permanent GitHub Free

This is a **prepared procedure**, not a performed visibility change. The owner alone
changes visibility. Public repositories currently use standard GitHub-hosted runners;
private repositories will also use hosted runners **only within the included allowance**.
The later request to remove local runners supersedes the earlier private-first plan.
No self-hosted workflow, registration, provisioning or local-result substitution remains.

1. Before changing visibility, record current refs, required check names and successful
   exact-source CI, runner inventory (must be zero), Actions permissions, collaborators,
   environment settings, provider integration access, existing security features and
   rollback receipts. Keep all three permanent branches and temporary security exceptions.
2. Inspect actual GitHub account Actions minutes/storage, artifact retention, caches and
   spending/budget controls. Keep paid usage/overages disabled. Standard public runners
   are free; private hosted use consumes the included allowance. Do not buy a plan.
   Current source gates **every hosted job** on public visibility or explicit
   `ONESA_PRIVATE_HOSTED_VALIDATION_ENABLED=true`. This variable is not a spending cap:
   enable it only after checking capacity and provider zero-paid-use controls, disable
   it when capacity is exhausted or the approved validation window ends. No variable
   is enabled by this documentation. Missing capacity blocks required validation.
3. The owner changes visibility. Then GET each repository's actual visibility/default
   branch, `branches/main`, `branches/main/protection`, `rulesets`, environments and
   Actions permissions. Save HTTP status/results. GitHub Free private branch protection,
   rulesets and environment protections must not be inferred from today's public state.
   Record unsupported/403/404 controls as unavailable, never implemented. Do not restore
   unavailable independent-review requirements or introduce a paid fallback.
4. Keep PRs and `dev → staging → main`. While public, actual main protection enforces
   required checks, no force push/deletion and zero unavailable approvals. If private
   Free cannot enforce these, PR discipline, no direct main push, no force push/deletion
   and owner review are **procedural**, backed by least write access. Keep exact-source
   external production qualification/authorization, image/schema binding, staging
   acceptance, rollback and owner release intact. A skipped/missing required CI job is
   never eligible release evidence, even if a fully skipped workflow displays success.
5. Verify source/dependency/container scans, Dependabot alerts/security-update PRs,
   dependency graph, notifications and secret-scanning/push-protection eligibility by
   actual feature/API readback. Preserve supported controls. Do not claim paid/private
   security features remain enabled. Retain scheduled vulnerability checks and existing
   independent runtime monitoring; account for the hosted allowance for scheduled jobs.
6. Recheck Vercel/Cloudflare/Oracle and any retained provider GitHub integrations for
   authorized private-checkout access. Verify pinned cross-product source fetches,
   clean builds, source/artifact identities and public/private documentation boundaries.
   Never make a repository public again, add deployment secrets to PR jobs, grant broad
   Apps permissions or change credentials to work around a denied private checkout.
7. Run a harmless normal PR and the full required final-source checks within allowance.
   Read back actual branch/environment enforcement and distinguish procedural controls.
   Verify each existing production component remains at its qualified revision; deploy
   only changed independently qualified artifacts through the external owner process.
   If checks or provider access are blocked, stop that release and report the exact gap.

Public protection is verified now; future private eligibility, included capacity and
provider access remain **NOT TESTED until the owner performs the transition**. No
visibility, billing, plan, paid usage or credential change is made by this procedure.

Official capability references checked 2026-10-18:
[branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches),
[environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage).
Account readback, not these references alone, establishes the effective configuration.

## Delivery invariants

Use lockfile-keyed dependency caches, bounded jobs, PR cancellation and conservative
change detection. Preserve full release-source checks and scheduled security coverage.
Keep PR jobs credential-free and retain exact artifact/source/schema/model binding,
source-qualified staging, rollback and explicit owner production authorization.
Local developer tests are supplementary evidence, never fabricated GitHub checks.
See [the external release procedure and limitations](PRIVATE_FREE_SAFEGUARDS.md)
and [current public protection readback](BRANCH_PROTECTION_REPORT.md).
