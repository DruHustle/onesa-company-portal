# GitHub Actions visibility and runner policy

Verified 2026-10-11: `DruHustle/onesa-company-portal` is **public**. All three Onesa repositories are
currently public; no visibility changes were made by this migration. Public repositories
use **GitHub-hosted `ubuntu-latest` exclusively**. Their private `local-validation` call
is skipped intentionally, never reported as a successful local test. Each cloud job verifies
`RUNNER_ENVIRONMENT=github-hosted` and current GitHub API visibility before checkout.
Existing cloud check names, matrices, environment approvals and release gates are retained.

## Public repository access

All three repository runner inventories have zero registrations. The former
`onesa-portal-local-arm64` service was stopped while idle, uninstalled through `svc.sh`,
and unregistered through the official removal flow; its registration credentials were
removed. AI/robot runners were not installed because visibility changed before setup.
The shared `onesa-portal-ci` VM is stopped. The Mac login plist is preserved as
`~/Library/LaunchAgents/eu.onesa.portal-ci-vm.plist.disabled`, so it cannot start the VM
at the next login. VM disks/configuration/tool caches are retained, not erased.
No shared runner serving another private repository was removed; none existed.

An `if` expression alone does not protect a registered public runner: fork code may edit
workflows. Removing the GitHub registration removes that repository's dispatch access,
including old audit branches and queued workflows that still select local labels. Public
PRs and forks use hosted execution. Never restore a local registration for a public repo.

On a visibility change, run on the Mac:

```sh
python3 scripts/runner/policy.py
python3 scripts/runner/policy.py --enforce
```

Inspection reads actual visibility and registrations through host `gh`. Enforcement
revokes known public local registrations via GitHub first; unfamiliar registrations fail
closed for manual review. Stop/uninstall the corresponding guest service and remove its
configuration with the official runner removal token flow. Do not start a stopped VM
solely to perform hosted validation. These commands never change visibility or remove
another private repository's access. Recheck policy before any runner service reactivation.

## Private repository ordering

If an owner separately makes this repository private, each workflow first invokes the
same `_local-validation.yml` reusable workflow at the caller's exact revision. It contains
all implemented checks from `verify.yml` plus publication hygiene, including existing
matrices. A final `local-complete` job requires every local job to succeed. The reusable
call must return success before any existing cloud job may start. A local failure, missing
runner or cancelled check blocks cloud stages; there is no paid hosted fallback. Each
checkout pins `github.sha`; a new commit requires new local and cloud validation.
Manual deployment workflows also require their existing exact-commit cloud CI and
production qualification/approvals. Local CI alone does not authorize deployment.

Planned private registration: `onesa-portal-local-arm64`, labels `self-hosted`, `Linux`, `ARM64`,
`onesa-portal-local`, user `portalci`, directory `/opt/onesa-actions-runner`. Repository scope is
mandatory: these are personally owned repositories, not an organization runner group.
The existing isolated Ubuntu 24.04 ARM64 Lima VZ VM has **4 CPUs, 6 GiB RAM, 60 GiB
in total**, shared by any future private registrations. Inspect host resources before
adding capacity. Root-owned worker leases serialize builds before service containers;
90-minute waits and 120-minute local timeouts bound the queue. Dedicated users/workspaces,
services and tool caches prevent accidental data/port conflicts. Docker membership is
root-equivalent inside this VM: the three trusted repositories are not security boundaries
against one another. Never register untrusted writers. Owner guards restrict private PRs.

Before any private job's code runs, a root-owned started hook calls `visibility.py` using
a short-lived, repository-scoped `ONESA_CI_TOKEN` supplied by the workflow's read-only
`github.token`; no personal credential is shared. It verifies actual API visibility and
repository identity both before and after waiting for the lease. Public repositories,
missing tokens and API failures deny execution before checkout/service containers.
This independently protects against a visibility change while registration revocation is
pending. Registration removal is still required; do not rely only on workflow conditions
or allow long-lived public access. Re-run the policy reconciler whenever visibility changes.

## Private provisioning, services and logs

Private setup is intentionally not active/tested end-to-end under current public visibility:

```sh
# Only after actual private visibility, idle checks and policy reconciliation:
limactl start --tty=false onesa-portal-ci
python3 scripts/runner/shared-setup.py
bash scripts/runner/status.sh
```

Setup verifies privacy/admin access, isolated VM configuration, aggregate resources,
all registrations/workers idle, official ARM64 runner archive SHA-256 and identity.
The registration token goes through stdin, never argv/source/logs. GitHub host `gh`
credentials remain on the Mac. Automatic runner updates remain enabled. Ubuntu provides
Docker/Compose V2, compiler/venv tools and browser OS libraries; actions provision Node24
and Python3.11, with locked Playwright1.64.0 browser binaries installed per job without sudo.
The existing Node archive's official checksum was verified during initial portal setup.
If recreating the VM, use the reviewed `lima.yaml` and original dependency bootstrap,
then the shared reconciler; do not reinstall or replace registrations automatically.

Service name if privately activated:
`actions.runner.DruHustle-onesa-company-portal.onesa-portal-local-arm64.service`.
Use supported `svc.sh` installation and systemd enable/start/restart only while all VM
jobs are idle. Startup requires macOS login/FileVault unlock, host awake/network available;
restore a reviewed LaunchAgent only when at least one private registration needs it.
Check `_diag` in the runner directory and `journalctl -u SERVICE`, and host
`~/.lima/onesa-portal-ci/launchd.stdout.log` / `launchd.stderr.log`. Keep raw logs private.

Completed hooks remove only the account's fixed checkout through an argument-free,
root-owned sudo helper and release only that worker's PID/start-time lease. Logs retain
14 days; CI artifacts retain3days. Inspect guest `df -h /` and `docker system df` before
large builds. While idle remove reviewed candidate tags individually and prune old build
cache with `docker builder prune --filter until=168h`. Never blindly prune volumes or touch
the host's Docker Desktop apps. VM mounts expose no home/project/credential directories,
no host Docker socket and no SSH agent. Application forwarding is disabled; only loopback
SSH management remains. Outgoing networking is not a LAN firewall. Rosetta was enabled
for investigation and remains in preserved VM configuration: its vendor runtime mount
reported `rw`, not a verified read-only host mount. No x86 frontend build under Rosetta
was completed before the public-only policy superseded local execution. Public hosted
x86 builds need no translation; private ARM scans never prove x86 runtime compatibility.

## Releases and unverified scope

Task pushes trigger CI, not production deployment. Production remains separately gated;
no release qualification is fabricated. Secret names only: `RELEASE_QUALIFICATION_JSON`,
`RENDER_API_KEY`, `RENDER_BACKEND_SERVICE_ID`, optional `RENDER_WORKER_SERVICE_ID`,
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`; retain each existing staging/docs
workflow's additional environment secrets. Never publish values or raw private evidence.
If hosted execution hits a minutes/spending/storage restriction, report cloud validation
blocked; do not buy capacity, enable fallback or bypass checks. A passing local stage
with a blocked cloud stage is not production qualification.

AI software fixtures use mock inference/lexical retrieval where specified and disposable
real PostgreSQL/pgvector; real model/semantic-host/GPU/training acceptance is separate.
Robot main remains scaffold-only; audit snapshots have software simulation. ROS2
compilation/messaging, real sensors/actuators, GPU and physical movement are unverified;
no physical operation is allowed by this task. Mac native Firefox failed profile creation
in the isolated simulator check; Linux hosted browser results must be reported separately.
The older portal private service/VM restart recovered without a Mac reboot. No AI/robot
private service restart or actual host reboot/login recovery was tested; current services
are deliberately absent. For a future privately activated setup, restart each idle unit,
verify online/idle metadata, then dispatch fresh validation. Actual reboot/login remains
manual after separate authorization; no host reboot occurred here.

## Audit handoff and rollback

Existing audit branches do not inherit workflow edits from `main`. In the audit session's
own worktree, merge the reviewed policy revision or cherry-pick its CI-only commit(s).
Preserve all implemented audit check names/tests and production guards. Update both the
cloud workflow and `_local-validation.yml` with any newly implemented checks; robot must
retain backend/frontend/container/browser coverage rather than replace it with scaffold
checks. Keep every cloud job hosted; its `needs: local-validation`/visibility gate controls
private ordering. Public local calls stay skipped and registrations stay absent.
Push the latest audit commit and monitor fresh runs with `gh run list/view --repo
DruHustle/onesa-company-portal`; inspect `/actions/runs/RUN_ID/jobs` for runner names/labels and
candidate SHA. Older local-selected runs are not evidence for the current public policy.
Rollback via a reviewed PR, preserving required checks/approvals; never restore public
self-hosted access. Runner policy removal is independent of application rollback/state.
