# Changelog

## 2026-10-11 — Public repository hosted Actions

- Record the owner-selected temporary public visibility and standard GitHub-hosted
  runner policy. Local runners remain private-only; retain security and release gates.
- Clarify that earlier private-plan protection failures are historical and do not
  establish current public-repository enforcement. No billing or protection settings changed.
- Route public Portal jobs to Ubuntu hosted runners, including browser OS dependencies;
  keep the manual local smoke gated to private repositories.

## 2026-10-11 — Guarded staging layout repair

- Fresh authenticated inspection found the owner-created staging API on main with
  the wrong root/health path, native auto-deploy enabled and no runtime variables.
  Add an exact-source CI-gated operator action limited to its fixed service ID,
  matching repository, Docker runtime, Frankfurt and free plan.
- Pause auto-deploy with readback before changing branch/root/CMD/health; verify
  final configuration without reading/copying environment values or deploying.
  Refuse foreign, paid, mismatched and unverified targets. The purported worker is
  a web service and remains blocked; no conversion, paid plan or runtime cutover.

## 2026-10-11 — Scanner framing and crashed final worker attempts

- Require one complete NUL-framed INSTREAM clean response. Ambiguous, truncated
  and error replies remain quarantined; infected signatures containing an OK
  substring are rejected. Bound scanner response bytes and total elapsed time.
- Exhausted email/storage leases become failed after expiry without a sixth
  attempt. Active final leases remain owned; reconcile provider acceptance before
  any manual retry. Added TCP scanner and disposable-database regressions.

## 2026-10-11 — Owner-created staging targets

- Record the two supplied Render service IDs and add an explicit read-only staging inspection scope. Production settings and release guards remain unchanged; hosted verification is blocked by GitHub's account runner restriction.

## 2026-10-11 — Deployment target discovery

Read-only hosting inspection reports exact deployment IDs, Preview protection and
a bounded, repository-filtered inventory of existing Onesa Render services.
Provider environment values and commands remain excluded. Partial inventories are
marked incomplete; discovery does not authorize repurposing or deploying a service.
Added foreign-resource, redaction and pagination regression checks.

## 2026-10-11 — Confirmed empty Portal database initialization

- Added a separate operator action for the owner-confirmed empty autumn-glade
  database. Exact-commit CI, database identity and verified client TLS are required;
  occupied schemas and existing role passwords are preserved by refusal.
- Seven unchanged migrations and a dedicated restricted login are created in one
  transaction, using a private pre-saved application credential. The login's schema
  checksums and permissions are verified before any proposed runtime cutover.
  This operation never changes Render settings, connects to dark-boat or deploys.
- The shared migration executor does not load runtime environment files. Added a
  disposable-database rollback/permissions regression. Database test files run
  serially because shared-fixture grants and sequence writes reproduced a catalog
  update race; all tests remain enabled.

## 2026-10-11 — Read-only database diagnostics

Identify runtime URL, migration URL, schema, authentication and permission failures
without logging credentials or provider responses. Read-only inspection now verifies
the actual configured runtime role, grants and migration checksums. Role repair and
production release guards remain unchanged; audit branches cannot apply permissions.


## 2026-10-11 — Targeted Render database-role repair

- Added an operator-only workflow that verifies the established Portal Neon target,
  all migration checksums and the complete table inventory before permission changes.
- Uses a fresh private direct owner URL to create a restricted runtime role, verifies
  its CRUD/sequence access and forbidden administrative privileges, and saves only
  the Portal API DATABASE_URL with private provider readback. Existing records,
  migrations, role passwords, worker and frontend settings remain untouched.
- The operation does not deploy or restart; existing production qualification gates
  continue to apply. Missing owner credentials or unknown schema/roles fail safely.

## 2026-10-11 — Isolated local Actions runner

- Route compatible verification/inspection jobs to the existing repository-scoped ARM64 Ubuntu VM runner.
  Preserve check names, security gates, three-browser coverage and release controls.
- Restrict execution to owner-controlled branches/PRs, use read-only checkout
  credentials, bounded timeouts, allocated database ports and runner-owned cleanup.
- Add checksum-verified provisioning, service/status tools and maintenance guidance.
  Remote acceptance is tracked in the release checklist.
- Retain hosted x86 frontend prebuilt deployment and artifact packaging: local
  x86 emulation crashed the full frontend build. No paid fallback was enabled.

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

CI follow-up: clean GitHub runners exposed root-owned Trivy report permissions;
image scans now use an exported image archive and the runner UID, retaining all
vulnerability/secret checks. The platform development dependency declaration now
includes pinned pip-audit, with the lock regenerated from source. Hosting readback
found missing provider configuration and failed native Render deployments. The
manual repair workflow only updates existing matched-repository Docker layout,
health paths, disables native auto-deploy and adds absent approved public origins
or portal S3 aliases. It never deploys, migrates data, copies/rotates credentials,
changes plans, creates resources or marks qualification gates as passed.

Browser CI repairs: portal blob download anchors are attached to the document and
object URLs are retained until WebKit starts downloading; the exact 10 MiB private
CV upload/download and SHA-256 check passed native Linux WebKit. Documentation
test grants accept only the old fixed or new randomized synthetic example.com
fixtures. Render AI configuration now rejects implicit development/test defaults
and suppresses input values in configuration validation errors. Fresh platform
backend checks passed (146 passed, 4 conditional skips); remote full checks remain
in progress. No production qualification record was fabricated.


## Production-hostname preview repair — 2026-10-10

GitHub browser verification reached the production-hostname checks and exposed
portal preview metadata referencing the orbit icon instead of the supplied ONESA
banner. The portal now uses `/social/onesa-banner.png` (1536 × 1024) for its social
preview; the orbit favicon is preserved. A fresh production build and the isolated
production-hostname routing, exact asset SHA-256, preview metadata and noindex
checks passed. The Linux WebKit private 10 MiB download regression also passed.
Production remains NO-GO: the actual worker ID identifies a web service, provider
backend deployment failed, frontend proxy settings and credential rotation are
unverified, and operations/content/legal qualification is incomplete.


## Owner free-only staging direction — 2026-10-10

The owner rejected paid database/GPU budgets and will establish staging. Added
staging.env.example with real application variable names, blank credential/endpoint
fields and isolated origins; existing populated env files remain untouched.
FREE_STAGING_SETUP.md documents ongoing free Neon/Render/Netlify/Resend/conditional
Zoho options, exact product setup/migration commands, limitations and owner steps.
Paid proposals/Blueprints are historical and explicitly not to be applied. No paid
resource, account subscription, DNS cutover, live migration or model switch occurred.
Vercel Hobby commercial restrictions, expiring Render free database, missing free
workers, EU model/privacy/capacity and restored backup limits remain material.
Free inference candidates are unconfigured, not a deployed real-model endpoint.
Production remains NO-GO; preserve independent products and all original data.

### 2026-10-11 — Production readiness checks

Readiness now verifies migration checksums, application CRUD and sequence grants,
and the existing restricted-role boundary. Container probes honor the assigned
PORT. CI exercises the actual production command, unavailable databases, safe and
unsafe roles, authentication boundaries and graceful shutdown on an isolated DB.
The historical hosted role fault has not been reclassified from a timeout alone.


## 2026-10-10 — GitHub Free governance plan

- Selected private GitHub Free operation with voluntary feature-branch PRs, verified
  CI, manual authorization and least practical write access. No paid upgrade or
  visibility workaround is proposed; main enforcement remains blocked.

## 2026-10-10 — Branch protection and governance audit

- Verified private personal ownership, admin access, actual PR CI/security check names
  and deployment/environment evidence across all three repositories.
- Attempted repository rulesets and classic fallback; GitHub rejected both with HTTP
  403 requiring Pro eligibility. Main readback remains unprotected, NOT ENFORCED.
- Prepared exact payloads, solo-developer PR/recovery policy, templates and API-backed
  reports. Local `deploy.yml` display names now use `deploy-qualification`, `deploy-frontend` and `deploy-backend` plus `deploy-worker`. Job IDs, dependency expressions and deployment behavior are preserved. This removes collisions with required CI checks. These edits are not yet published; merge them through a reviewed PR and verify the resulting names before activating the payload.
- Existing local work is preserved. No push, merge, deployment, billing, visibility,
  credential or external provider change was performed.

## 2026-10-10 — Render database-role follow-up

- Guarded the existing restricted-role operator procedure with database identity/TLS
  checks and read-only default; added credential-free privilege reasons.
- Readiness verifies migration checksums and application CRUD grants; Docker health
  follows PORT. Production CMD and owner/restricted/dependency regressions added to CI.
- 36 backend tests passed on isolated PostgreSQL; production image smoke passed.
  Hosted role condition/identity remain unverified; production/legal gates stay open.

## 2026-10-10 — Instruction documentation cleanup

Removed completed GitHub setup instructions and duplicate status/session-handoff
logs. Consolidated contribution, security, repository governance and agent policies
in one root AGENTS.md per independent repository. Preserved unfinished work in
existing roadmap/release documentation, updated links and documentation tooling.

## 2026-10-11 — Reviewed governance integration

Consolidated policy references and templates, preserved later audited runtime fixes, and reconciled deployment notes with actual staging evidence. Prepared protection settings remain reference only under GitHub Free. Original local work and private environment files are preserved. Public production qualification is unchanged.

## 2026-10-11 — Confirmed alternate Portal database inspection

Added a strictly read-only inspection operation for the owner-confirmed alternate Neon Portal endpoint. Existing runtime-role repair still accepts only its established target. Inspection verifies TLS/schema and reports data presence without records, credentials, migrations, permission changes, settings updates or deployment. Corrected the operator workflow reference to repair-hosting.yml.

Follow-up: verify encrypted/certificate-validated TLS at the actual client socket, rather than using pg_stat_ssl for Neon proxy connections. Reject unverified/plain connections before SQL.
