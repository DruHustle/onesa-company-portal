> Current configuration — verified 2026-10-18: this repository is **public** and
> `main` now enforces PRs, current-base GitHub Actions checks (including the
> unconditional fail-closed summary and hygiene), resolved conversations, and
> force-push/deletion prevention, including administrators. Zero unavailable
> independent approvals are required. See [actual protection readback](BRANCH_PROTECTION_REPORT.md).
> Earlier private-plan failures and provider snapshots below are historical;
> they do not describe current eligibility or current runtime. External owner-held
> production qualification and credential isolation remain required. No visibility,
> billing or production credential setting changed in this activation.

# GitHub Free operating policy

> Current pipeline: [automated review, staging qualification and owner activation](CI_CD_PIPELINE_REPORT.md). Prepared local changes are not live deployments; branch/PR optimization and automatic technical evidence supersede older manual-only details.

The requested operating model is private repositories on GitHub Free. GitHub cannot
enforce native branch protection, rulesets or production environment approvals for
that combination. The retained dev branch and PRs targeting main remain the development
policy. Credential-free hosted PR checks use the included private Actions quota;
quota exhaustion blocks qualification rather than authorizing paid execution.
Production credentials belong outside editable repository Actions.

Read-only verification on 2026-10-11 returned PUBLIC for all three repositories and
`plan: null` for the authenticated account. The actual subscription is unverified.
No visibility/settings changes were made. Current public main protection is also
not active. Resolve this discrepancy with the owner; do not assume paid capabilities.

See [the implementation report, enforcement boundaries and owner runbook](PRIVATE_FREE_SAFEGUARDS.md).
This policy supersedes earlier temporary-public and mandatory-local-runner guidance.
Keep the retained private-only local runner dormant unless independently verified and
authorized; never execute untrusted PRs on a persistent or production runner.
No purchases, billing changes, visibility changes or live deployment are authorized.
