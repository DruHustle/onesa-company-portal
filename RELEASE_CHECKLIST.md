# Production release checklist

- Exact source revision passed CI, including publication hygiene and full contracts/tests.
- Vercel frontend and Render API/worker have approved account ownership and capacity.
- PostgreSQL migrations applied with owner credentials outside the API/worker runtime;
  restricted application credentials passed readiness and role-isolation tests.
- API and worker use the same access-controlled encrypted S3 bucket and encryption key.
- SESSION_KEY and PROXY_SHARED_KEY are securely shared where needed; public origin is
  one approved HTTPS Vercel/custom hostname, with Secure cookies and CSRF validation.
- Backup retention, off-host restoration, database health, worker/notification failures,
  access alerts and operational contacts are configured and tested on the target.
- Verify the six required company facts and approve the English/German legal pages,
  recruitment handling and provider review using authorized company records. Do not
  mark unverified claims approved merely to pass a gate. PUBLISH_ENABLED stays false
  until editorial/legal approval; public forms remain gated in production.
- Run end-to-end tests on isolated fixtures, target-host smoke checks and rollback
  with backward-compatible schema. Confirm upload limits and private file quarantine.
- Existing local data is preserved; no private records are automatically migrated.

Source publication and infrastructure preparation alone do not complete this checklist.

## Local runner acceptance — 2026-10-11

- Verified repository scope, online/idle state, Linux ARM64/custom labels, checksum,
  idempotent registration, systemd service restart and LaunchAgent VM boot recovery.
- Initial [push CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161012),
  [PR CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131178868),
  [publication hygiene](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161041)
  and [manual smoke](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131160962)
  passed at `09a5bc6`; job metadata identifies `onesa-portal-local-arm64` (ID 21).
- Before merge, verify fresh checks on the final [PR revision](https://github.com/DruHustle/onesa-company-portal/pull/4), including retention of the two incompatible x86 jobs.
  ARM CI/security images do not establish x86 runtime security equivalence. Production commands remain untested against providers; no
  production workflow was dispatched. Existing release gates still apply.
- Owner must authorize the PR merge to change default-branch routing; real Mac
  reboot/login and sleep recovery remain owner acceptance tasks.
