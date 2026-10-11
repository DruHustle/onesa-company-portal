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

## Outstanding owner and hosted acceptance

- Verify organization ownership and provider bindings; the inspected GitHub owner
  is DruHustle, not an independently verified onesa-ug organization.
- Retest hosted API/worker readiness and original503 failures at the reviewed revision.
- Verify credential rotation privately; never restore exposed credentials.
- Complete independent security/accessibility and API compatibility acceptance.
- Confirm domain/DNS, email delivery, staging isolation and target-host operations.
- Obtain real company-fact/editorial/legal approval before public release.

Check current evidence before closing these items. Removing completed setup/handoff
instructions does not satisfy release gates. Implementation history remains in Git
and CHANGELOG.md; ongoing policies are consolidated in root AGENTS.md.


## Portal runtime acceptance

The guarded staging layout action passed at reviewed revision f3715a4 in run
38136781194. Readback 38136905181 confirms audit branch, backend root, Node command,
readiness path and disabled native auto-deploy. All eight required staging runtime
variables remain missing. The service named worker is actually a web service. Its runtime secrets, private storage and real executor
must be independently qualified; no owner URL or exposed credential may be reused.

Local image/readiness checks pass; current exact-SHA CI must qualify the combined
runner/audit revision. The owner-confirmed autumn-glade target was initialized with
seven migrations and a restricted login. Last authenticated production runtime
readback pointed to dark-boat; current runtime remains unqualified. Database
initialization is complete and must not be repeated. Hosted
acceptance still needs that cutover, frontend proxy settings and a verified worker
target. See docs/engineering/VERCEL_RENDER.md.

## Branch protection acceptance — 2026-10-10

- **NOT ENFORCED:** Fresh public main readback shows no active protection. Earlier writes were rejected while private; current eligibility must be checked separately. No production approval is inferred.
- Activate and verify the [prepared policy](docs/development/branch-protection/ACTIVATION.md) after separately authorized eligibility changes; verify check uniqueness and pending/failure/pass merge behavior.
- Resolve the [recorded deployment environment/integration gaps](docs/development/BRANCH_PROTECTION_REPORT.md) before promotion.

## Historical private local runner acceptance — 2026-10-11

- Verified repository scope, online/idle state, Linux ARM64/custom labels, checksum,
  idempotent registration, systemd service restart and LaunchAgent VM boot recovery.
- Initial [push CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161012),
  [PR CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131178868),
  [publication hygiene](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161041)
  and [manual smoke](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131160962)
  passed at `09a5bc6`; job metadata identifies `onesa-portal-local-arm64` (ID 21).
- Owner merged [the runner-policy PR](https://github.com/DruHustle/onesa-company-portal/pull/4). The audit merge retains all newer application fixes and requires fresh exact-revision hosted checks, including x86 runtime jobs.
  ARM CI/security images do not establish x86 runtime security equivalence. Production commands remain untested against providers; no
  production workflow was dispatched. Existing release gates still apply.
- No private registration is currently active. Real Mac reboot/login and sleep
  recovery remain separately authorized future private-runner acceptance tasks.

## Public hosted runner acceptance — 2026-10-11

- Owner selected public repositories and GitHub-hosted Actions. Local runner jobs
  are private-only; existing shared concurrency and production gates remain intact.
- Verify test, browser, contract, publication-hygiene and AMD64 image-security jobs
  on the new exact commit before accepting the routing change.
- Historical private runner acceptance does not certify a current registration.
  Production promotion still requires all applicable release gates and authorization.

## Automated release qualification acceptance

Local evidence/approval automation and rejection tests are implemented. See
[qualification guide](docs/engineering/AUTOMATED_QUALIFICATION.md) for the trust model and owner actions. Remote CI/provenance validation, main
protection, encryption secret provisioning, complete hosted staging/production
acceptance and explicit owner operations/legal approval remain blocked.
The migration switch stays off and the original secret gate is retained.
