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

- Pending: verify online/idle, guest and host service recovery, smoke and full CI
  metadata on the task branch. No production deployment is authorized by this test.
- ARM64 release images require compatible deployment targets; hosted x86 image
  portability has not been demonstrated.
