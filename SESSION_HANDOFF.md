# Session handoff

Current release focus (2026-10-10 v1.1): local remediation and release closure, independently NO-GO. The latest appended v1.1 results supersede historical totals/provider claims below. Do not push/deploy/rotate credentials/change DNS without the corresponding scoped authorization. Protected provider503 diagnosis/staging, operations, assurance/accessibility and legal/scope acceptance remain open; private release-closure ledger assigns every original finding. Prior milestone notes and user changes are preserved as history.

Continue the existing Fastify/PostgreSQL backend and Next.js frontend. Both applications have installed dependencies. Foundation sources include migration 001, cryptography, roles, storage and PDF templates. No frontend routes or backend application entry point existed when continuation 004 began. Use node --import tsx rather than the tsx CLI in restricted environments (the CLI opens an IPC socket). Use a separate PostgreSQL database and dedicated Compose project for portal tests; never access the AI platform database.

## Publication/deployment preparation — 2026-10-09

Source publication to private main is authorized. Full backend checks pass (20 tests),
including restricted application role provisioning and production readiness rejection
of administrator/schema-owner roles. Cloud target is Vercel frontend and Render API
plus worker, using shared durable private S3 storage. See render.yaml and
 docs/engineering/VERCEL_RENDER.md. Do not store owner credentials in runtime env.
The original local company database/storage and private PDFs are preserved. No data
is automatically migrated. Keep company/legal editorial gates closed until reviewed.
Provider authentication, stable HTTPS origins, remote CI and live acceptance remain.

## GitHub release verification — 2026-10-09

Source-only main is now published to the private Onesa UG repository. Added manual
GitHub Actions deployments with exact-commit CI/hygiene gates, pinned Vercel CLI and
Render live-status/commit verification. Native provider auto-deploys are disabled in
the deployment standard. Provider projects/secrets and actual target acceptance are
still required; no cloud deployment or production qualification is claimed.

Isolated browser acceptance resets only its test database rate buckets and uses one
absolute storage path shared by server and test cleanup. Local browser acceptance:
5 passed. Application production rate limits and private corporate files are preserved.


## Final cross-project audit — 2026-10-09

This section supersedes earlier current-state readiness claims. Existing custom Fastify CMS / Next.js site preserved; main baseline f3ffce1aee0b, local uncommitted candidate only. No new push/deployment/publication. Local 22 backend tests and 12 Chromium/WebKit browser cases passed; frontend lint/type/production build passed. Firefox startup, conservative contract compatibility review, complete ASVS/a11y and hosted operations/legal acceptance remain incomplete. Production release is **NO-GO**, distinct from local passing checks.

Added exact-origin controls, nonce CSP, independent provider examples, standard generated clients/compatibility gate, strict release fingerprint/approval tooling, synthetic restore and current container scanning. Corrected founder/director seed with additive migration; public facts exclude private metadata; durable file-deletion outbox commits before physical deletion and uses retry fencing; owner MFA-reset fresh step-up remains a high blocker.

Restricted release reports and evidence are ignored under docs/internal/release-audit. Read RELEASE_DECISION, RELEASE_BLOCKERS and VERCEL_RENDER_RUNBOOK before promotion. `python3 scripts/release/qualify.py decision` returns NO-GO. Actual provider credentials/origins/storage/inference/monitoring and human legal/content approvals remain required.

Current REST ownership verification: repository is private under DruHustle (User); onesa-ug remote redirects. Intended organization ownership is unverified and release-blocking. No ownership/remote/visibility changed.


## Application feature continuation — 2026-10-10 (current)

Sensitive administrator-user edits/MFA resets now consume a fresh actor password plus
TOTP/recovery proof in the same transaction as the user update and audit. Current
session/role are rechecked under locks; missing proof, replay and concurrent reuse
are rejected. Forbidden/failed attempts do not consume recovery codes. The Users form
requests fresh proof and clears sensitive input values after submission.

Added own-password change to Security for every authenticated role. Fresh proof,
Origin/CSRF and throttling apply; successful change revokes all sessions and outstanding
reset tokens, clears cookies and requires sign-in with the new password and MFA.
MFA remains enabled. Tests exercise owner user changes/MFA reset and fresh MFA sign-in.

Evidence: 26 backend tests passed; lint/types/build passed for both apps; 12 Chromium/
WebKit functional browser cases passed, including five-width Security axe/overflow.
Generated OpenAPI/client drift passes. Conservative baseline review retains two findings
(user-update request tightening and private-field removal from public company responses).
Baseline and release gates were not silently reset. No actual customer email was sent.
Commands/logs are ignored under data/audit-20261009/evidence/features-*.

The owner reports Render setup complete; hosted API/worker/storage/SMTP delivery and
operational acceptance were not verified here. SMTP/storage qualification, Firefox,
manual ASVS/accessibility, API migration review, legal/facts and organization ownership
remain outstanding. SEC-03 is locally remediated, pending deployed acceptance and
independent review. Current changes remain local; no new commit/push/deployment.


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

Latest isolated results: 31 backend tests pass, backend lint/build pass, frontend
lint/types/production build pass, four domain unit tests and actual production-host
HTTP/brand checks pass, 14 Chromium/WebKit browser cases pass. Generated-client drift
passes. Two conservative compatibility findings remain (fresh-proof user mutation
request and company response); production qualification is still NO-GO.

The configured Neon s3-bucket passed one unique synthetic AES256 upload, byte-exact
read-back and deletion of that test object. Existing objects were not accessed.
Local storage activation/database selection and private encryption keys were preserved.

Remote inspection: GitHub main remains f3ffce1; its checks passed, but its last GitHub
deployment failed due to missing configuration. Vercel reports its older frontend
deployment successful; the live portal /api/v1/auth/me returns 503 and its root
redirects to /en. onesa.eu still serves Squarespace. GitHub lacks portal
RENDER_BACKEND_SERVICE_ID and VERCEL_PROJECT_ID. Render/Vercel integrations and
authenticated local CLI access are unavailable. Provider logs, runtime variables,
migrations/restricted database role and end-to-end email delivery remain unverified.
Do not fabricate qualification or claim successful production deployment.
No commit, push, DNS change or production deployment occurred in this review.
Evidence: ignored data/audit-20261009/evidence/review-*.{log,json}.

## Diagnostic current-state audit — 2026-10-10

This dated diagnostic supersedes historical readiness/coverage statements where different. Application code/configuration/migrations/dependencies and robot were unchanged. Both releases remain independently NO-GO. Current findings, exact dirty-snapshot identity, test totals/limitations, hosted503s and next steps are in docs/internal/release-audit/CURRENT_STATE_AUDIT.md (path relative to repository root). The protected EVIDENCE_INDEX.json records executed commands; NEXT_STEP_CODEX_PROMPT.md contains a bounded continuation. No public deploy/push, DNS, credential rotation, email or real-user mutation occurred. Source tests used disposable synthetic databases; real-model checks used only approved existing local resources.

Portal:31 backend,4 domain and14Chromium/WebKit browser tests pass; fresh frontend/backend images pass security gates;2contract reviews, hosted/API/worker/email/legal/ops and Firefox coverage remain unresolved.

Generated documentation validation applies to the pre-addendum snapshot; release documentation must be regenerated after future implementation/status changes. Prior successful storage/deployment/model statements are explicitly dated historical evidence rather than current hosted qualification.


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
