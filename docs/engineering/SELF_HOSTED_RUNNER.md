# GitHub-hosted validation and retired local runner

Owner direction, 2026-10-18: the local/self-hosted runner implementation is removed.
The reusable workflow, provisioning scripts, hooks, leases, configuration, startup
helpers and custom runner labels are no longer shipped. Do not recreate, register
or reactivate a local runner when visibility changes. Historical receipts remain
restricted and Git history preserves the retired implementation for audit purposes.

All three repositories are currently public and use standard GitHub-hosted runners.
Current GitHub API inventories report zero repository runner registrations. The dedicated
Onesa CI VM and its disabled startup plist have been removed after verifying stopped
state, zero registrations, no host mounts and no additional disks. Application/Oracle
resources were excluded. There is no local executor to restart.

GitHub Free is the permanent budget. If the owner later makes repositories private,
use included GitHub-hosted capacity only. Check actual account allowances and the
zero-paid-usage spending controls before enabling jobs. Exhausted allowance is a
validation blocker; never skip required checks, enable paid overages or substitute
an unreported laptop run for a GitHub check. A local developer test remains useful
local evidence, not a provider status or production authorization.

Follow [the visibility-transition procedure](../development/FREE_GITHUB_PLAN.md).
Keep `dev → staging → main`, exact-source PR/CI evidence, synthetic test resources,
zero unavailable independent approvals and external owner-controlled production
qualification. Keep deployment credentials outside PR jobs and never use privileged
PR execution. Public protection and future private-Free procedural safeguards are
separate; private eligibility must be read back rather than assumed.
