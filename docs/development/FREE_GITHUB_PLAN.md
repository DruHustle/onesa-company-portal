# GitHub Free operating plan

## Current owner-selected policy — 2026-10-11

The owner has made all three `DruHustle/onesa-*` repositories public temporarily
and selected standard GitHub-hosted Actions. Use `ubuntu-latest` for current public
verification, builds, security scans and authorized hosting workflows. No paid runner,
billing upgrade, visibility change or repository transfer is authorized by this policy.

[GitHub documents standard hosted runners as free for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Artifact storage and provider resources are separate; retain short artifact retention
and existing secret/data exclusion. Public source does not authorize public secrets,
internal records, model weights, uploads or confidential CI evidence.

Local runners may be used only when the repository is private and their isolation,
registration and capacity have been verified. The Portal selects its existing ARM64
labels only for private repository events; its manual local smoke is private-only.
AI Platform and Robot currently retain their existing hosted configuration: do not
invent or register local runners. Any future private migration needs a separately
verified compatible runner. Keep native x86 jobs hosted until a compatible private
runner is qualified; never substitute an unverified architecture.

## Required workflow

1. Preserve existing Git state and data. Work on a focused feature, fix, security or
   existing authorized audit/staging branch; commit only reviewed files.
2. Run affected local checks and publication hygiene. Push only with authorization,
   after checking whether the branch triggers a production deployment.
3. Inspect CI on the exact source revision. All required test, contract, hygiene and
   image-security jobs must pass; do not remove or skip failing checks.
4. Use pull requests and resolve review conversations. With one developer, require
   zero independent approvals; add independent review when a real reviewer joins.
5. Do not force-push, rewrite history, delete main or bypass checks. Main merges and
   production promotion require the corresponding authorization and release gates.
6. Keep staging databases, credentials, storage and previews isolated. Passing CI
   does not certify a hosted service or permit an unqualified production deployment.
7. Keep paid Actions spending disabled. Do not select larger paid runners or change
   budgets if an account/provider restriction prevents execution.

## Protection status

The recorded HTTP 403 responses for rulesets and classic protection occurred while
these repositories were private on GitHub Free. Those historical results do not
establish current public-repository eligibility or enforcement. See the existing
[protection report](BRANCH_PROTECTION_REPORT.md) and
[prepared activation instructions](branch-protection/ACTIVATION.md).

No branch-protection settings are changed by the runner switch. Verify actual remote
rules separately before claiming that GitHub enforces mandatory PRs, checks or
force-push/deletion restrictions. Local JSON, hooks and contributor policy do not
establish remote enforcement. Keep least-privilege write access, private security
reporting and existing production-environment safeguards.
