# Local GitHub Actions runner

This private repository uses the repository-scoped `onesa-portal-local-arm64`
runner with labels `self-hosted`, `Linux`, `ARM64`, `onesa-portal-local`.
It runs as `portalci` in Lima VM `onesa-portal-ci`: Ubuntu 24.04 ARM64,
4 CPUs, 6 GiB memory, 60 GiB disk. Verification, both image-security matrix entries,
publication hygiene, hosting operations and backend/worker deployment jobs select
these labels. There are no Windows/macOS jobs or reusable workflows. Chromium,
Firefox and WebKit coverage is retained. Native CI/security images now exercise
ARM64; x86 runtime security equivalence is not established by an ARM scan.

Two jobs retain `ubuntu-latest`: Vercel prebuilt frontend deployment and approved
release-artifact packaging. Their previous x86-64 build environment is preserved.
Ubuntu QEMU and the current Docker-documented QEMU 10.2.3 were tested in this VM;
Node could report x64 under the latter, but the full Next.js x86 image build crashed
with signal 11. An actual x86 Linux machine/VM or separately verified translation
setup is needed before migrating these jobs. No paid hosted fallback was added or
triggered. Their existing account restriction remains; frontend production release
and artifact packaging therefore remain blocked without compatible capacity.

## Installation and dependencies

The host needs free Homebrew Lima, Python 3 and authenticated `gh` with repository
admin access. Run `python3 scripts/runner/setup.py` from a reviewed checkout.
It checks privacy/admin access, refuses duplicate/replacement runners, downloads an
official actions/runner release, checks the published asset SHA-256, and registers
through a short-lived token passed over stdin. The existing GitHub OAuth token
never enters the VM. Automatic runner updates remain enabled.

Host VM files are under `~/.lima/onesa-portal-ci`; runner files and credentials
are at `/opt/onesa-actions-runner` **inside the VM**, outside Git. Work is under
`_work`; `/opt/hostedtoolcache` holds action-managed Node 24/Python 3.11 versions.
Ubuntu supplies Git, curl, build tools, Python 3, Docker and Buildx. The setup script
checks the official Node archive checksum and provisions all three browsers' OS
libraries using the frontend lockfile's Playwright version. Browser binaries are
installed per workflow, without granting the job sudo. No cache action was added;
ARM and x86 native caches must not be shared.

For new Playwright OS dependencies, while idle, copy `provision-guest.sh` into the
VM and run it as the Lima administrator with the new locked version; service
installation is idempotent. Alternatively run `/opt/onesa-node/bin/npx playwright@VERSION
install-deps chromium firefox webkit` as VM root. Review the version first.

## Service, startup and logs

`bash scripts/runner/status.sh` checks the VM, guest service, disk and GitHub status.
The supported runner service is installed using `svc.sh`, enabled in systemd and
starts whenever the VM boots. For start/stop/restart inside the VM:

```sh
limactl shell onesa-portal-ci -- sudo bash -c 'systemctl restart "$(cat /opt/onesa-actions-runner/.service)"'
limactl shell onesa-portal-ci -- sudo bash -c 'journalctl -u "$(cat /opt/onesa-actions-runner/.service)" -n 80 --no-pager'
```

Runner logs: `/opt/onesa-actions-runner/_diag` in the VM (14-day cleanup).
VM startup logs: `~/.lima/onesa-portal-ci/ha.stderr.log`, `serial*.log`, and
`launchd.{stdout,stderr}.log` on the host. Logs may contain restricted operational
information; inspect locally and do not commit raw logs.

While the runner is idle, stop the VM, then run
`python3 scripts/runner/host-service.py` to install
`~/Library/LaunchAgents/eu.onesa.portal-ci-vm.plist`. It runs Lima in the foreground
under launchd and starts the VM after **this Mac account logs in**. It cannot start
before FileVault unlock/login. Closing a terminal does not stop the service.
Mac sleep suspends CI and may break network connections/timeouts; keep the Mac
awake during jobs (`caffeinate -i` for an intentional local session). No permanent
power setting is changed. A real host reboot/login test requires the owner; the
VM/service restart test checks guest boot recovery only.

Before intentionally stopping the VM, unload its LaunchAgent:

```sh
launchctl bootout "gui/$(id -u)/eu.onesa.portal-ci-vm"
limactl stop onesa-portal-ci
# Resume:
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/eu.onesa.portal-ci-vm.plist"
```

## Trust and persistent state

No host mounts, SSH-agent forwarding, Docker Desktop socket, personal home directory
or host GitHub credentials are supplied to jobs. Application TCP/UDP forwarding is
disabled; Lima's local SSH management channel remains. No router ports are opened.
The dedicated Docker daemon belongs only to this VM. Docker group membership
permits VM root access: the VM, not the Unix account, is the isolation boundary.
The VM has outbound network access, including reachable LAN services; it is not
a complete network sandbox. Keep sensitive host/LAN services authenticated.

Job conditions permit only `DruHustle` as actor, and PRs must also have that author
and originate in this same repository. Fork/other-user PRs are skipped, so skipped
checks are **not** validation; review code and run an owner-controlled branch before
merging. No `pull_request_target` or privileged `workflow_run` path exists. This is
an operational trust boundary, not protection against a writer who edits workflows.
Repository writers can alter job conditions; grant write access only to trusted
maintainers and review workflow changes. Secrets remain accessible to authorized
jobs in their existing scope. Production approval/qualification checks are retained;
runner setup does not establish missing private-Free branch/environment protections.

Jobs use read-only token permissions (with existing checks/actions read scopes),
checkout credentials are not persisted, timeouts are bounded, and concurrency never
cancels an active deployment. Only one runner executes one job at a time. PostgreSQL
uses an allocated port. Browser servers are stopped using their own recorded PIDs;
GitHub runner process/container cleanup remains active. Job completion removes
only this repository's runner-owned checkout; restricted security reports are also
removed explicitly. Tool/browser/Docker caches persist in the VM and need disk review.
Never prune the host's Docker Desktop or kill unrelated development processes.

For disk pressure, first confirm GitHub reports `busy: false`, stop the guest runner,
then inspect `docker system df` **through `limactl shell onesa-portal-ci`**. Remove
only identified runner images/unused build cache. Never run broad host pruning or
remove active service containers. The service should be restarted after maintenance.

## Troubleshooting, removal and rollback

If queued for more than a few minutes, check exact labels, online/busy state, service
logs and outbound HTTPS connectivity to GitHub; investigate before retrying. One
runner intentionally queues concurrent jobs. A stale remote registration without
its VM is refused by setup; reconcile explicitly rather than replacing another runner.
Never delete credentials or copy `.runner`/`.credentials*` into Git.

Stop the LaunchAgent and guest service before removal. Obtain a short-lived removal
token with the host `gh` API and pass it privately via stdin to `config.sh remove`
using `ACTIONS_RUNNER_INPUT_TOKEN`; never echo it. Remove the LaunchAgent plist.
Delete the VM only after reviewing any retained evidence; `limactl delete` destroys
its runner-owned disk. No host development containers/data need removal.

Rollback through a reviewed PR restoring `runs-on: ubuntu-latest` and the browser
`--with-deps` install. Retain tests and trust guards; hosted jobs still need available
account allowance. Never enable a paid fallback automatically. Default-branch
workflows keep their previous routing until this PR is merged with authorization.

Self-hosting does **not** remove artifact/cache storage quotas or account-level
restrictions. Evidence on 2026-10-11: hosted checks reported recent payment failure
or spending limit; the available token could not read usage details (`user` scope
missing). Self-hosted eligibility was then verified: [push CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161012),
[publication hygiene](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161041),
[PR CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131178868) and
[manual smoke](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131160962)
passed on `onesa-portal-local-arm64`, runner ID 21, commit `09a5bc6`.
Fresh CI must verify the final PR revision after documenting the two incompatible
x86 jobs; the initial successful checks are evidence, not final-commit acceptance. Production workflows were not dispatched.

Official references: [runner requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[adding a runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
[service configuration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application),
[security](https://docs.github.com/en/actions/reference/security/secure-use),
[Lima configuration](https://lima-vm.io/docs/config/),
[Actions usage](https://docs.github.com/en/actions/concepts/billing-and-usage).
