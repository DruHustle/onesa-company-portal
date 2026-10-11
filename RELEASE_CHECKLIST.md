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


## Render DATABASE_ROLE follow-up — 2026-10-10

Local implementation and isolated regression verification passed; hosted repair remains
open. See [the exact evidence, changes and reviewed configuration procedure](docs/engineering/VERCEL_RENDER.md)
for current source/deployment revisions and outstanding provider checks. No push or
deployment, production secret change, DNS/resource/plan change or readiness acceptance.

## Branch protection acceptance — 2026-10-10

- **BLOCKED, NOT ENFORCED:** GitHub rejected ruleset/classic protection writes for this private personal repository. No production approval is inferred.
- Activate and verify the [prepared policy](docs/development/branch-protection/ACTIVATION.md) after separately authorized eligibility changes; verify check uniqueness and pending/failure/pass merge behavior.
- Resolve the [recorded deployment environment/integration gaps](docs/development/BRANCH_PROTECTION_REPORT.md) before promotion.
