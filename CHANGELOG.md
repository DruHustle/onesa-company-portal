# Changelog

## 2026-10-10 — Fresh authentication and own-password controls

- Added transactional fresh password/MFA proof for user administration/MFA reset,
  rechecked session/role and preserved last-owner/self-edit protections.
- Added authenticated own-password change in Security; revoked all sessions/reset
  tokens while retaining MFA. Cleared password/proof inputs after submission.
- 26 backend tests and 12 Chromium/WebKit functional cases passed; lint/types/build
  and generated-contract drift passed. Five-width Security axe/overflow checks passed.
  API migration review and production release gates remain open; no new deployment.


## 2026-10-09

Prepared the independent company portal repository and private organization remote.
Added publication hygiene, engineering documentation and environment examples.
Production API readiness now rejects database administrator/schema-owner privileges.
Migrations provision a separate CRUD role without changing existing role passwords.
Prepared separate Vercel frontend and Render backend/worker configuration, durable
shared S3 storage requirements and a configurable upload limit for Vercel payloads.
Source publication is authorized; production promotion requires configured services
and verified company facts/notices. Database integration checks include role isolation.

## GitHub release verification — 2026-10-09

Source-only main is now published to the private Onesa UG repository. Added manual
GitHub Actions deployments with exact-commit CI/hygiene gates, pinned Vercel CLI and
Render live-status/commit verification. Native provider auto-deploys are disabled in
the deployment standard. Provider projects/secrets and actual target acceptance are
still required; no cloud deployment or production qualification is claimed.

Isolated browser acceptance resets only its test database rate buckets and uses one
absolute storage path shared by server and test cleanup. Local browser acceptance:
5 passed. Application production rate limits and private corporate files are preserved.

GitHub plan compatibility: deployment workflows consume repository-level Actions
secrets without paid deployment-environment features.


## Final cross-project audit — 2026-10-09

This section supersedes earlier current-state readiness claims. Existing custom Fastify CMS / Next.js site preserved; main baseline f3ffce1aee0b, local uncommitted candidate only. No new push/deployment/publication. Local 22 backend tests and 12 Chromium/WebKit browser cases passed; frontend lint/type/production build passed. Firefox startup, conservative contract compatibility review, complete ASVS/a11y and hosted operations/legal acceptance remain incomplete. Production release is **NO-GO**, distinct from local passing checks.

Added exact-origin controls, nonce CSP, independent provider examples, standard generated clients/compatibility gate, strict release fingerprint/approval tooling, synthetic restore and current container scanning. Corrected founder/director seed with additive migration; public facts exclude private metadata; durable file-deletion outbox commits before physical deletion and uses retry fencing; owner MFA-reset fresh step-up remains a high blocker.

Restricted release reports and evidence are ignored under docs/internal/release-audit. Read RELEASE_DECISION, RELEASE_BLOCKERS and VERCEL_RENDER_RUNBOOK before promotion. `python3 scripts/release/qualify.py decision` returns NO-GO. Actual provider credentials/origins/storage/inference/monitoring and human legal/content approvals remain required.

Current REST ownership verification: repository is private under DruHustle (User); onesa-ug remote redirects. Intended organization ownership is unverified and release-blocking. No ownership/remote/visibility changed.


## Domain and email setup — 2026-10-10

Owner-selected company `onesa.eu`, administration `portal.onesa.eu`, AI
`platform.onesa.eu` and future robot `robot.onesa.eu`. Company/portal host routing
and scoped Origin/BFF checks are prepared, with host-only cookies retained. The
existing durable email queue now supports Resend HTTPS, stable job idempotency,
timeout and safe receipt validation; SMTP remains available. Examples and Render
worker secret configuration updated without editing populated environment files.
See docs/engineering/DOMAINS_AND_EMAIL.md. DNS is currently Squarespace-managed;
external Vercel/Resend/DNS assignments, TLS, inbox provision and real delivery are
pending account access. No code publication or provider deployment occurred.

Verified locally: 30 backend tests passed (including Resend transport and the
company/public vs portal/auth Origin boundary), three frontend domain cases
passed, backend/frontend lint/types and builds passed. GitHub verification now
includes the domain unit tests. Owner confirmed Squarespace DNS and Zoho Mail;
Zoho root-domain MX/SPF/DKIM and Resend sending-subdomain records have separate
setup instructions. No providers or live inboxes were configured.

Branding: owner-supplied ONESA banner now supplies public/portal Open Graph and
Twitter previews; orbit screenshot supplies the favicon. Original PNG bytes and
provenance retained. Robot assets are independently prepared for its future frontend.
Host selection uses the exact configured Host authorities, because Next.js can
represent the internal server URL in nextUrl. Arbitrary forwarded hosts are ignored.

Final domain/branding acceptance: four host unit tests and the actual built-server
HTTP probe passed, covering redirects, API boundaries, forwarded-host spoofing,
portal noindex, same-origin PNGs, source hashes and favicon/Open Graph/Twitter tags.
Rendered preview URLs use `https://portal.onesa.eu`; favicon is host-relative.
Frontend lint/types/build, documentation/hygiene and Blueprint schema checks pass.
CI includes the isolated host probe. Hosted DNS/TLS, Zoho mailboxes and Resend
delivery remain pending account access. Temporary frontend/test DB stopped.

## Review and deployment verification — 2026-10-10

Fixed a Blueprint startup mismatch: Render generates 44-character base64 secrets,
below the portal's 48-character SESSION_KEY requirement. Require an explicitly
supplied persistent encryption key, keep API/worker values identical, and preserve
existing ciphertext keys. Added a regression test and Blueprint consistency check.
Deployment failures now identify missing Vercel secret names without exposing values.
Resend/Neon credential patterns are checked in source and history; the source scanner
now honors Git exclusions instead of traversing ignored local data. Replaced a
credential-like documentation placeholder; all three repository history scans pass.


## Remediation and release closure — 2026-10-10 v1.1

This dated continuation supersedes earlier current-result statements, preserving their historical evidence. Targeted upload/security/contract/UI/operational changes are implemented locally; current application builds and synthetic checks are recorded in the restricted release-closure ledger. No remote mutation, commit, push, email, DNS or public-release approval occurred. Company Portal and AI Platform remain independently **NO-GO** for hosted503s, credential containment, operations/legal and remaining security/manual acceptance. Do not represent the older deployed revision as this dirty candidate.

Portal preserves10MiB private-file capability through bounded transport; fresh MFA/private provenance controls remain intact and two intentional compatibility changes await client/version approval. AI preserves5MiB ingestion and existing real local models; adds explicit invitation gating, one-use recovery/outbox worker, shared DB admission quotas and honest bootstrap errors. AI runtime uses pinned Python3.11.17 Alpine and build-only pinned uv; native Linux PDF restrictions remain enforced. Compatibility18→0 is a proved schema refinement, not baseline reset. Private STAGING_OPERATIONS_DELTA.md and SECURITY_ACCEPTANCE.md specify hosted/manual/policy gaps. Exact refreshed results/source hashes are in RELEASE_CLOSURE.md/EVIDENCE_INDEX.json, not old milestone totals.

Next executable bounded task: qualify native AMD64 PDF denial and prepared candidate staging after owner-approved target/access, then diagnose503 from actual Vercel/Render logs; separately implement the reviewed password-blocklist/session-assurance policy. M5 live travel, training, paid access, hosted inference/capacity and human multilingual quality are still unqualified; no speculative provider integration introduced. Preserve original ordered milestone requirements and all prior dirty work. Robot unchanged.

## GitHub review and deployment follow-up — 2026-10-10

The owner has now authorized reviewing, committing and pushing to `main`, and
monitoring deployments. Production qualification remains mandatory; this permission
does not establish staging, operations or content/legal acceptance. Company record
files awaiting publication approval remain local and are excluded from Git and
documentation artifacts. The manual `Inspect hosting configuration` workflow uses
existing provider secrets for read-only service, configuration and deployment
checks; it emits only required-variable presence and allowlisted status fields.
Paired releases now wait for the backend (and portal worker) before promoting the
frontend. Remote CI and provider results will be recorded after the push; they are
not implied by the earlier local test results.
