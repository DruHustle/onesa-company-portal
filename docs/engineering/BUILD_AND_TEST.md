# Separate application builds and tests

The scanner release regressions run in the existing Python release suite. They
exercise real Ed25519 signatures in a disposable issuer fixture, source/artifact
and environment mismatches, revoked/expired or consumed contexts, unsafe rendered
settings, concurrent attempts and interrupted provider requests. The sanitized
`scanner-compose.fixture.json` describes public configuration for parsing tests;
it is neither a provider receipt nor owner authorization. Real default-entrypoint,
socket access, benign/EICAR, signature persistence and restart observations still
require the separately commissioned isolated owner-run path.

The database fixture now uses an owner with `CREATEDB` and `CREATEROLE`, without
superuser access. PostgreSQL does not grant a role creator `SET`/`INHERIT` access
by default. The provisioner checks the exact source/context marker before granting
access to its temporary non-login owner role. Read-only inspection grants nothing;
cleanup still refuses active connections and preserves the existing catalog.
See [PostgreSQL's role-creator settings](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-CREATEROLE-SELF-GRANT).

The owned worker-fixture tests use a fresh internal Docker network, synthetic TLS
certificate and disposable PostgreSQL 17 database. The approved staging hostname
resolves only to that test container; no hosted credential, published port, provider
account or application environment is used. The actual backend image applies its
canonical migrations to the empty fixture and proves concurrent provisioning,
runtime least privilege, expiry/source/context refusal and cleanup without forced
connection termination or changes to the existing catalog. CI requires this proof
after building the backend image. A local run uses
`python3 scripts/release/worker_fixture_smoke.py <immutable-backend-image-ID>` with
the pinned PostgreSQL image already downloaded. The nine guard/TLS SMTP tests run
with `node --test scripts/release/oracle_portal_worker_fixture.test.mjs scripts/release/oracle_portal_worker_smtp.test.mjs`.
SMTP accepts one named synthetic recipient over TLS and reports acceptance only.
These checks create no release authority or hosted qualification. The owner worker
adapter still requires separate review, commissioning and exact-source evidence.

Oracle CI selection keeps an existing push authoritative, including failed,
pending, skipped or cancelled evidence. Only an absent push permits the existing
owner-dispatched full workflow; both owner identities, a complete run listing,
first attempt and every mandatory job/security step remain required. Signed
references preserve the actual CI event. Synthetic mixed-event regressions must
reject a newer successful manual run presented over a failing push.

Production observations check readiness and anonymous private-route denials on the
existing Portal hostname, and require the Company hostname to keep those routes
blocked. Isolated staging still uses its combined protected Preview. The public
UI and served-asset checks continue on the Company hostname. An interrupted release
keeps its actual current deployment separate from the hash-checked source comparison
baseline and explicitly retained rollback artifact; none of these substitutes for
fresh qualification and authorization of a corrected candidate.

The browser verification job uses supported Ubuntu24.04 explicitly, retaining all
three engines, the bounded signed dependency installer and every existing deadline.

The offline release suite includes `test_oracle_inventory.py`: completed temporary
monitoring clients and list/inspect races do not become preservation baselines.
Long-lived temporary workloads, unchanged-inventory command failures, incomplete
metadata and real independent runtime changes still fail closed. These fixtures
make only mocked Docker reads and do not establish hosted qualification.

Owner-run static artifact checks treat Next.js catch-all chunk names such as
`[...path]` as literal filenames, encode them for HTTP, and reject traversal
segments, encoded paths, controls, query strings and fragments. Regressions verify
that every accepted asset is read and hashed; changed or oversized bodies still fail.

`scripts/test_oracle_backup_output.py` exercises the backup decoder and read transport
with synthetic encrypted objects and a deliberately slow pipe reader. It verifies
complete bytes under backpressure, reproduces the former synchronous truncation and
rejects failed or oversized reads. Owner-run qualification pins the read transport
to its separately installed, exact-source tool bundle.

The pinned backup container runs as its existing unprivileged user. Its reader is
a hash-verified temporary copy of public transport source, mode `0444` inside a
private temporary directory. The installed source and credential file stay `0600`.
Copy tests reject changed bytes, reused destinations and failed custody; a
network-disabled pinned-container fixture must reproduce private-source EACCES
and read all 512 KiB through the unchanged nonblocking writer from the copied source.

CI and hosted artifact-build workflows pin Node 24.22.1 explicitly; a cached
`24` major selector can otherwise select an older vulnerable patch. Runtime images
and provider-managed runtimes require their own source-bound verification.

> Current pipeline: [automated review, staging qualification and owner activation](../development/CI_CD_PIPELINE_REPORT.md). Prepared local changes are not live deployments; branch/PR optimization and automatic technical evidence supersede older manual-only details.

Run from the repository root with Node 24, Python 3 and Docker when building images.
Commit lockfiles; `npm ci` installs their exact dependency resolutions.

Reviewed dependency changes use `dev → staging → main`; automatic version PR creation is disabled while update configuration and compatibility constraints are retained.
Keep the Portal frontend on TypeScript 5.9.3 while `openapi-typescript` 7.13.0
requires `^5.x` and the installed typescript-eslint 8.71.1 peers require
`>=4.8.4 <6.1.0`. The TypeScript 7.0.2 update in PR #28 failed `npm ci`
with `ERESOLVE`; it must not enter a release. Dependabot ignores compiler major
version updates until the generator, lint tooling and compiler can be upgraded
together and pass contract generation, lint, type checks and builds. Do not use
`--force` or `--legacy-peer-deps` to hide peer conflicts. Supported minor/patch updates are reviewed and applied on dev. Security updates remain on the default branch under
[GitHub's documented target-branch behavior](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch)
and still require compatibility checks and the qualified release path.

## Frontend

```sh
npm --prefix onesa-company-portal-frontend ci
npm --prefix onesa-company-portal-frontend run lint
npm --prefix onesa-company-portal-frontend run typecheck
npm --prefix onesa-company-portal-frontend run build
docker build -t onesa-portal-frontend:local onesa-company-portal-frontend
```

For local development: `npm --prefix onesa-company-portal-frontend run dev`.
Configure `BACKEND_URL` privately on the frontend server, never in a browser secret.
The container listens on 3300 and needs same-origin routing for `/api/v1/*` to the
backend. `SITE_URL` and public-release settings are build-time configuration.
Frontend env example lives in its subdirectory; current native dev scripts load the
root `.env`, so export values explicitly for independent deployments.

After the production build, run the homepage loading regression:

```sh
npm --prefix onesa-company-portal-frontend run test:homepage-loading
```

It starts an isolated loopback mock API with synthetic content and exercises both
public-release settings, slow responses and recovery. No database, provider credentials
or hosted backend is required. Verify prompt hero rendering, bounded response completion,
request-scoped publication checks and fail-closed approval behavior. Passing locally
does not establish deployed performance or hosted acceptance.

The Node-only transport regression is independent of Next startup and browser installation:

```sh
npm --prefix onesa-company-portal-frontend run test:public-fetch
```

It checks real synthetic loopback delayed headers, stalled bodies, upstream cancellation,
recovery and404 with no database or provider. After installing the existing Chromium/WebKit
Playwright browsers, also run:

```sh
npm --prefix onesa-company-portal-frontend run test:public-loading
```

This separate production-renderer regression binds synthetic loopback services and
checks slow headers/bodies, optional copy/feed/related content, fresh publication and
detail reads, genuine404 versus transient failure, recovery, EN/DE navigation and
browser Back. Section copy and related stories stream independently; optional section
SEO falls back to maintained metadata after250ms. Complete public response reads have
a1500ms deadline and abort upstream on expiry. Required release/detail checks precede
streaming. No public data or approval is cached across requests. The fixture never
submits forms or uses a database/provider, and refuses local production env files.
Renderer setup polls readiness for at most60s; page-response assertions retain their
separate strict budgets. These are lab timings; exact-source hosted acceptance remains
a separate gate.

## Backend

### Idle database and worker regression

Oracle staging API container probes use `/api/v1/health`; the production image
default retains `/api/v1/ready` for existing dependency monitoring. The full request-path regression
poisons query and connection acquisition, supplies a session cookie, and proves
that liveness succeeds while `/api/v1/ready` correctly returns 503. Deployment
qualification retains real readiness, migration and restricted-role checks.

Worker health reads its atomic local success/deadline record and checks the private
scanner without SQL. A failed tick does not refresh that record. Successful
processing, retry recovery and durable outboxes remain required.
Restricted-role validation stays in startup and runs before processing when its
30-second validation deadline is due; it cannot wake an idle worker independently.

Explicit `WORKER_PROFILE=staging` permits `WORKER_IDLE_MAX_MS` from 5000 to 600000.
The staging Compose profile opts into a ten-minute maximum. Empty successful ticks
back off exponentially; actionable pending work, including delayed retries, keeps
five-second polling, and failures reset the delay. Newly arriving work may wait up
to ten minutes plus processing duration. Interactive staging sessions can select
5000 through the qualified configuration procedure. Production retains its 5000
default and no staging override. Disabled or unaddressed mail stays queued without
counting as actionable work. SIGTERM interrupts idle sleep promptly.

Run the complete backend suite on the guarded disposable PostgreSQL target.
`liveness.test.ts`, `worker-polling.test.ts` and `worker-idle.test.ts` cover database
failure, bounded success expiry, preserved pending mail, reminders, retry exhaustion
and pending deletion detection. Local tests do not establish deployment or savings.
`database-recovery.test.ts` terminates only its own idle connection on the guarded
local test database and proves the next operation reconnects. The pool discards a
failed idle client and logs a fixed event without exception text or credentials;
in-flight transactions still fail normally and are never replayed automatically.

After qualified staging installation, observe Neon control-plane status for at
least ten minutes without SQL or database-backed HTTP polling, then send one real
application request to verify wake-up. Free has a fixed five-minute idle tail.
At 0.25 CU, ten-minute periodic idle polling approaches 90 CU-hours per 30 days
before processing time, ramp-up and user traffic; continuous activity uses 180.
These are forecasts summed across all project computes, not measured savings.
Consumed allowance is not reset. See
[Neon scale to zero](https://neon.com/docs/introduction/scale-to-zero).

```sh
npm --prefix onesa-company-portal-backend ci
npm --prefix onesa-company-portal-backend run lint
npm --prefix onesa-company-portal-backend run typecheck
npm --prefix onesa-company-portal-backend run build
(cd onesa-company-portal-backend && node --import tsx --test tests/unit.test.ts tests/contracts.test.ts)
docker build -t onesa-portal-backend:local onesa-company-portal-backend
```

For a simpler unit command, from the backend directory use
`node --import tsx --test tests/unit.test.ts`. Supply `DATABASE_URL`, `SESSION_KEY`
and the other backend env values at runtime. Native development:
`npm --prefix onesa-company-portal-backend run dev`; production: built server or image.
The native scripts load root `.env` when present; examples are references, not auto-loaders.

## Integrated checks

`python3 scripts/check-contracts.py` and `python3 scripts/test-contract-break.py`
validate contracts. Full backend `npm test` requires a disposable PostgreSQL database
with `TEST_DATABASE_URL` ending `_test`; it truncates test tables. Never point it at
application data. Browser tests need an isolated seeded stack and installed Chromium:
`npm --prefix onesa-company-portal-frontend run test:e2e`.

The test preload and every backend test entrypoint apply
`tests/local-environment.ts` before importing runtime configuration. It rejects
hosted database bindings even when their name ends `_test`, clears inherited
S3/AWS storage credentials and endpoint aliases, scanner sockets/hosts and mail
provider credentials, and disables cloud metadata discovery. Browser database
fixtures use the same guard. Local fixtures use temporary files and explicit
loopback scanner mocks; actual provider tests require their separate controlled
acceptance scripts. An isolated SQL database alone does not isolate object storage
or notification delivery. Keep this guard when adding new test entrypoints.

The storage source also refuses inherited remote S3 configuration or orphan AWS
credentials in `NODE_ENV=test`, before client use and before every storage operation.
Explicit loopback storage requires a test bucket ending `-test`; default fixtures
remain temporary local files. The negative regression imports unsanitized synthetic
cloud settings and tries a runtime override with transport/file-write sentinels: both
must fail with zero storage writes and zero client sends. Real hosted storage checks
use the separately qualified, explicitly isolated acceptance target and procedure.

Backend test files run serially because their shared fixture performs grants,
migrations, truncation and sequence writes. The initialization regression creates
and removes only its uniquely named disposable `_test` database and test role;
it verifies rollback, strict refusal of existing objects and restricted permissions.

Existing `verify.yml` runs lint/build/contracts/database/browser/docs/container checks
under the `verify` job. Require `verify` and `publication-hygiene`. Full exact-source remote CI is a separate gate; inspect the actual current GitHub run and hosted acceptance receipts rather than treating local builds as deployed evidence.

## Container readiness regression

After backend tests create the restricted fixture role on an isolated
`TEST_DATABASE_URL` ending `_test`, build `portal-backend-ci` and run
`python3 scripts/startup_smoke.py portal-backend-ci`. This executes the actual
production CMD at PORT 10000, checks liveness, unsafe-role/unavailable-DB 503,
restricted-role 200, anonymous protected-route 401 and SIGTERM shutdown.
Do not use production records or change a live database role to run this test.

The read-only Portal inspection uses the retained reviewed development/staging/main workflow scopes. Its
allowlisted phase identifies whether runtime or migration URL validation failed;
never relax the established database identity guard or paste URLs into logs.
Inspection reports actual role safety and grants only after verifying the database
identity and schema. Applying a repair remains restricted to the original operator
branches and successful exact-revision checks.


After full backend tests provision the synthetic restricted role on the disposable
`TEST_DATABASE_URL`, run `python3 scripts/startup_smoke.py onesa-portal-backend:local`.
On Linux CI it uses host networking; for a dedicated Docker test database use
`--network container:<isolated-test-db>`. It exercises the production image's default
CMD at PORT=10000, health, owner-role 503, restricted-role 200, unavailable DB 503,
authentication and SIGTERM. Never supply an application database to this test.

## Approved company particulars and CMS

The maintained private owner record is `onesa-company-portal-backend/records/company-facts.v1.json`.
Only its eight expressly approved public fields are generated into independent product
snapshots; unapproved business claims, private records and identifiers remain excluded.
Run `python3 scripts/sync_company_details.py --workspace --check` when all three local
repositories are available, or omit `--workspace` for the independent Portal build.
The generated snapshots are committed, so CI and deployments require no private record
or sibling checkout. Never commit the private record simply to make a check pass.

`npm --prefix onesa-company-portal-backend run seed` is an explicit operator command,
never an application startup action. It synchronizes the approved company particulars
and EN/DE legal-notice CMS text transactionally, preserving previous CMS revisions.
New pages remain drafts; existing publication states and all legal/privacy settings
are preserved. Owner confirmation is identified as the source, not an independent
register extract. Company approval does not approve processors, retention, transfers,
recruitment or privacy disclosures. Check any assigned W-IdNr against the actual tax
notification; [DDG section 5](https://www.gesetze-im-internet.de/ddg/__5.html) requires
publication of assigned applicable identifiers. Do not invent an identifier or DPO.

Run the mail and company-publication unit tests and the public legal-page browser
checks, including contact links, exact EN/DE particulars, mobile layout and contrast.
Mail signatures retain stable provider idempotency keys and are not duplicated on
retries. Do not send actual email merely to execute the transport unit tests.

## Retired local approval files

`python3 scripts/release/qualify.py decision` always fails closed. Editable `gates.json` strings and a matching local source hash do not establish verified release authority. Use the existing trusted `release-qualification.yml`/`free-qualification.yml` workflow and owner-controlled promotion path. This does not add another reviewer or invalidate existing owner authorization. Contracts, isolated verification and safe anonymous smoke commands remain available.

## Dependency maintenance and continuing detection

Three permanent branches are retained: dev, staging and main. Temporary Dependabot
security-update and necessary narrow security-release candidate branches are permitted.
Automatic security-update PR creation is **enabled**, superseding the earlier scoped
disablement. All three actual default branches are main; they were not changed.
Security PRs target default main: ordinary version `target-branch: dev` does not
redirect them. Version PR limits remain zero while registry/compatibility metadata is
retained. Alerts are enabled, with zero open alerts at the 14 October readback; other
reported protections are unchanged. Direct dependency-graph SBOM readback returned
HTTP404, so that setting is not directly verified and was not modified. Existing
security PRs/branches are preserved. The owner confirmed receiving and monitoring
Actions failures and Dependabot alerts for all three repositories.

For an ordinary fix, review the advisory, affected package/lockfile, license and full
diff. Incorporate that single reviewed change on dev, retaining the bot PR/advisory
reference. Run lint/types, unit/integration/API checks, production builds and dependency/
image scans; promote through staging and main with actual hosted acceptance. Reconcile
the bot PR only after main contains the equivalent fix; do not merge it again or close
it just to shorten the branch list. Breaking changes, unexpected diffs, conflicts and
failing checks require owner review; patch/minor numbering is insufficient evidence.

For an urgent production finding, verify the actual deployed revision and prepare a
narrow temporary candidate from it. Exclude unrelated unfinished dev work. Qualify
that exact candidate against approved isolated staging resources and synthetic data,
including compatibility with the existing production API/data, then use the current
owner-controlled main release gate. Existing workflow credentials remain available
only on allowlisted staging/main refs: a temporary branch does not unlock them.
If staging already contains unfinished changes, do not reset it or deploy its unrelated
content; obtain a separately tested candidate-bound staging qualification through the
existing external owner path before release. The current staging dispatcher does not
accept arbitrary temporary refs. A candidate without trusted exact-source qualification
remains blocked. After deployment, reconcile the same fix into dev/staging and preserve
its reviewed source, release receipts and advisory. Delete a temporary branch only
after verified incorporation or legitimate supersession and no active dependencies.

PR and installation jobs use credential-free GitHub-hosted runners, isolated test
resources and synthetic data. Never add deployment secrets to Dependabot, use unsafe
pull_request_target, execute privileged PR artifacts, or blanket auto-merge. Vercel Git
configuration denies unspecified branches (including nested bot heads); only the
existing staging branch can prepare a native Preview. Production stays owner-controlled.

The existing full verification workflow runs weekly on Monday at 06:17 UTC after
qualified main adoption, and continues required checks for dev/staging/main changes.
Dependency/source/final-image gates, OS/application checks and Oracle maintenance are
retained. Track each advisory, severity, affected version, remediation action, responsible
owner, integration, release and deployed verification in the existing restricted findings
register. Zero alerts or a fix on dev is not proof the production artifact is patched.
A session is not a background monitor. Restore the security-PR setting with repository
`automated-security-fixes` PUT; do not disable it again under superseded instructions.

## System appearance and isolated browser fixtures

Identity assets are versioned alongside the foundation in
`design-system.consumer.json`. Their common O outline comes from the unchanged
owner-supplied orbit artwork; Company, AI, Robot and Docs use distinct geometric
frames. `node scripts/generate_identity_icons.mjs` deliberately regenerates the
canonical SVG,16/32/64 ICO and180PNG files with the existing installed Playwright
Chromium. Review the output and provenance, then explicitly copy the relevant
versioned product files into each consumer and qualify its release. This does not
run during application startup or silently update sibling builds. Native tab
readability requires actual browser evidence in addition to HTTP/MIME/byte checks.

`node scripts/test_system_appearance.mjs` validates the pinned shared foundation,
ordinary text/control contrast, registry and removal of clock/persisted overrides.
Browser checks use OS preference with an opposing mocked clock, plus live changes
preserving an unsaved draft, focus and session. All three browser engines remain required.
Read the canonical protected Onesa Design System and local consumer manifest before
changing shared semantics. Test representative Company, AI, Robot and Docs views together.

Every ordinary backend/browser fixture imports `tests/local-environment.ts` before
runtime modules. It rejects hosted/non-test databases and removes inherited cloud,
scanner and email credentials. Storage additionally rejects any remote binding in
`NODE_ENV=test` before client construction or writes. Local server adapters bind loopback;
no production bucket or credentials are prerequisites. Remote acceptance is a separate
explicitly approved isolated target, never a fallback from ordinary local tests.

## Engineering Docs identity verification

`npm --prefix onesa-company-portal-frontend run test:domains` also checks the
identity path/callback allowlist. After a production frontend build and Chromium
installation, run `npm --prefix onesa-company-portal-frontend run test:engineering-sign-in`.
It starts isolated loopback synthetic services and tests eight mobile/desktop
appearance views, validation recovery, focus and axe; it sends no email and reads
no database/provider configuration. Existing full backend tests exercise the actual
OIDC/PKCE/signed-email flow, code expiry/replay, membership and owner controls using
the disposable local test database and generated synthetic keys. The preload clears
inherited ENGINEERING configuration before tests; deterministic schema export
disables the provider. Local tests do not establish a successful Access integration
or email inbox receipt. The separate activation sequence is in
[Engineering Docs identity](ENGINEERING_DOCS_IDENTITY.md).

## Controlled workspace draft regressions

With Node 24, run `npm --prefix onesa-company-portal-frontend run test:workspace-drafts`
for history-event ordering, including native confirmation's nested event loop. The
Governance and editorial Playwright suites use the guarded loopback `_test` database
and real synthetic accounts. They cover unnamed controlled payloads, review notes,
failed saves, pending-mutation navigation, duplicate submission and all five publication
summary states. Keep server rate limits intact; clear only the fixture's local login
limiter between independent synthetic cases. Browser transport fixtures are not hosted
authorization evidence. The full hosted CI and release qualification remain required.

## Static-first optional hero media

The approved poster, framing and HTML heading remain the default. No approved video
exists; `src/config/hero-motion.ts` intentionally exports null. Enabling
`ONESA_HERO_MOTION_ENABLED=true` alone cannot create a video request. Future activation
requires rights-cleared local desktop/mobile variants, exact SHA-256/size provenance,
3–5 second single playback and measured poster/video LCP, CLS, CPU and transfer
acceptance. The owner-held asset brief describes the unchanged hand/Onesa-button scene.
No third-party embed, audio, looping, new product UI or fabricated asset is permitted.
Disable the frontend flag to retain the poster without changing any backend.

`npm --prefix onesa-company-portal-frontend run test:hero-motion` runs policy and
three-engine synthetic DOM controls. It verifies no source assignment for reduced
motion, data saving, slow connections or invalid assets; rejected/stalled playback,
mobile selection and changed constraints restore the poster. It does not qualify a
real codec, video asset or performance claim. A no-JavaScript visitor retains the
poster and actual HTML content. macOS Firefox uses its own application-data directory;
synthetic browser scratch may need owner cleanup because of macOS protected folders.

## Engineering sign-in request feedback

After a frontend build, run
`npm --prefix onesa-company-portal-frontend run test:engineering-sign-in`. The isolated
renderer covers delayed-send disabled visuals in system light/dark appearance,
duplicate submission prevention, failed-send email preservation, error clearance
on retry, a single visible Sent status without a Sent button, the 30-second server
resend boundary, expired interaction restart and stalled-request recovery. It also
checks actionable password-setup/approval errors and distinguishes unavailable
services from expired requests.
The fixture sends no real mail and grants no hosted membership. Browser feedback
checks complement the backend registration/link tests; they do not prove delivery
to a real mailbox or production Engineering Docs access.

The Engineering identity integration suite also checks an emailed link opened in
a browser with no original interaction cookie, including expiration of the original
interaction, a fresh PKCE/nonce/state exchange and explicit confirmation. Preparation
does not consume the link; replay, wrong Origin/CSRF, tampered/expired handoff and
disabled membership fail. The isolated UI fixture models the canonical redirect to
a fresh interaction and verifies that no token enters a request URL or browser
storage. It sends no real email and does not grant production membership.

The maintained `navigation.spec.ts` homepage-topic journeys check distinct focused
destinations, matching headings, substantive content and reloads in both languages.
The complete Technology overview and its legacy bookmarked anchors remain supported.

## Node TLS trust regression

Use Node 24.22.1 or a later reviewed security patch in the 24 series. Run
`node --test scripts/test_tls_trust.mjs` from the repository root. The test uses
a known public CA certificate and newly generated synthetic localhost certificates
in isolated child processes. It proves native fetch/HTTPS trust, rejection of
untrusted certificates and hostname mismatches, idempotence and fail-closed startup.
Temporary test keys are removed; it sends no application/provider requests.

The startup policy excludes only the SHA-256 fingerprint of the affected
emSign ECC Root CA - G3 from the effective application default store. It retains
other default/extra authorities and never disables certificate verification.
Node changes are thread-local. The API and worker preload the policy before
client construction; the Next frontend uses its Node-only instrumentation hook.
Container Node entry points also preload the policy.
See the [advisory](https://github.com/advisories/GHSA-6q48-6c7w-9gw2) and
[Node TLS API](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts).
Source tests are separate from source-bound staging and production acceptance.
After the frontend build, run `node scripts/check_tls_bundle.mjs
onesa-company-portal-frontend` from the repository root. The guard checks actual
gateway and sign-in server traces and rejects trust-code inclusion in browser
bundles. Check owner-built Vercel artifacts too by supplying their `.vercel/output`
directory as the third argument. Instrumentation source alone is insufficient
evidence that a serverless adapter included the policy.

## Remember-browser and shared Portal session controls

The existing Engineering sign-in renderer covers unchecked-by-default remember
controls, retained selection between methods, actual request payloads, failed
submission, keyboard/appearance and an explicit approved Portal-session choice.
These synthetic controls send no real email and establish no production membership.
The backend integration and access-registration suites check session versus
persistent cookies for password and email-link MFA, unchanged server expiry,
rotation, logout/revocation and one-use factors. The actual OIDC integration checks
transient versus remembered provider cookies, signed identity, PKCE, missing or
disabled membership, expired/non-MFA Portal sessions, forced login and max_age.
Remembering a browser grants no product role and never counts as fresh MFA.

MFA reuse additionally requires purpose-signed, session-bound authentication-time
proof. `session-proof.test.ts` checks tampering, another signing purpose, token
substitution, future/expired/malformed evidence and renewal without extending MFA
freshness. Legacy sessions keep normal Portal access but cannot provide a made-up
authentication time to Docs. No schema, application credential or MFA key changes.

## Temporary backup-client cleanup

The Oracle regression command below includes
`scripts/test_oracle_backup_cleanup.py`. It exercises both PostgreSQL backup
helpers with disposable state and synthetic connection settings. Failed container
startup, failed psql startup, a Docker cleanup timeout and an interrupted pipe wait
must still remove the private connection file and attempt scoped helper cleanup.
The helpers use automatic removal on exit and explicitly remove their anonymous
image volumes during cleanup. Named application volumes are outside this scope.

Before installing these helper changes, qualify the exact source with the existing
CI path and network-isolated containers using the already pinned PostgreSQL image.
Verify forced removal and natural expiry without running a database executable,
then confirm existing application containers and volumes are preserved. Update
only these operations files through the existing component installation; preserve
configuration, keys, receipts and timers, and never rerun the bootstrap installer.
Observe the next normal scheduled backup rather than triggering a production backup
to test cleanup.

## Operations notification regression

Run `python3 -m unittest discover -s scripts -p 'test_oracle*.py'` for the
complete Oracle-operation regression set, including
`scripts/test_oracle_monitor_persistence.py`. Its eight disposable-state tests
cover interrupted final writes, failed replacement, the next normal sample,
pending delivery identity, restart counters, private file modes and simulation
separation. Delivery is mocked; no production state or mail is used.

The notification controls additionally cover
synthetic incident transitions, immediate initial alerts, thirty-minute grouping of
new failure rules/services and six-hour reminders for all unchanged incidents.
The existing `notification_cooldown_seconds` controls the update window (default
1800, integer range 60–21600). Partial improvement does not send another update;
previously emailed rules/services remain grouped until that incident closes.
Recovery requires at least five elapsed minutes and six consecutive healthy samples,
with gaps of at most two minutes. Brief health, rapid repeated samples, missed samples
and invalid/future timestamps cannot prematurely confirm recovery. A two-hour replay
of changing failures and brief health produces one initial alert and one grouped update,
followed by one recovery after sustained health. These counts describe that synthetic
sequence, not a daily message cap or hosted reliability guarantee.
Tests also cover stable
notification identities after ambiguous delivery and bounded credential-free Robot
readiness probes. These controls send no mail or application command and do not restart
services. Installation is a separately qualified operations-component change; never
rerun the initial operations bootstrap against existing production.

Every observation still reaches the private metrics/failure records, independently of
email suppression. `last-recovery.json` records the first clean observation; only the
confirmed recovery notification closes the emailed incident. Keep the existing one-minute
timer, probe timeouts, dependencies and scanner enforcement. Validate the installed source
hash, singleton scheduling and normal samples through the protected operator procedure;
local regression results alone do not establish that the notification policy is live.

Pending delivery retries stop after23 hours and require provider reconciliation before
the24-hour [Resend idempotency window](https://resend.com/changelog/idempotency-keys)
expires. Metric sampling and failure records continue; no new key is created to
re-send an ambiguously accepted event. Healthy legacy installations do not receive
a retrospective recovery email when this policy is first installed.

The final snapshot adds restart baselines before one call to the existing atomic
record writer. A failed temporary write or replacement retains the previous complete
record, including a pending notification identity. This does not establish fsync,
power-loss durability or concurrent-writer safety. Before installation, read back
the actual singleton systemd oneshot unit/timer and check for duplicate schedulers;
do not start a second monitor to test concurrency. Preserve real pending delivery
and reconciliation records. Qualify interruption cases only with disposable state
and mocked delivery, then verify the installed file hash and normal scheduled samples.

## Credential-verified administrator onboarding and resend feedback

The maintained `test:engineering-sign-in` renderer suite checks that no MFA field
appears before credential proof, enrolled accounts receive the factor step and
unenrolled accounts receive setup. Both methods retain MFA and remembered-session
boundaries. It also checks plain Sent status, immediate duplicate-submit exclusion,
disabled styling, a 30-second explicit resend, failure recovery and server-reported
Engineering cooldown after refresh. All delivery is mocked on loopback.

The isolated backend suite covers correct/incorrect/disabled accounts, no session
before factor verification, bearer-link state discovery without consuming attempts,
concurrent delivery coalescing and explicit resend after the server window. Unknown
recipients retain the same acknowledgement/cooldown. These tests do not enroll a
real owner, send real mail or prove production access. Deploy compatible API support
before the frontend; old clients supplying a factor remain supported.

The bootstrap onboarding regression runs the actual bootstrap process only on the
isolated local test database, verifies no active/printed factor, completes the UI
API enrollment protocol and confirms an occupied database cannot be overwritten.
Existing production enrollments require explicit scoped recovery; a missing audit
event alone does not establish that an existing factor can safely be removed.

## Advisory patch candidate — 24 October 2026

The current source lock includes Fast URI 3.1.9/4.2.3 and Nodemailer 10.1.4.
The focused records were reviewed from security PRs #198 and #199; unrelated peer,
optional and native lock entries were retained. Nodemailer retains MIT-0 licensing;
Fast URI retains its existing license. Full dependency checks and the actual runtime
image must pass before release. A source lock update does not update the serving API
or worker. Private `records/` owner inputs are excluded from the Docker build context.

The current source candidate pins official Node 24.22.1 runtime images (21 October security patch), plus explicit musl and scanner Brotli package minima so cached older layers cannot satisfy the new runtime requirement. The scanner engine remains the reviewed ClamAV 1.4.6. Qualify the API, mail worker and scanner independently; a source lock patch does not update their serving containers. [Node maintainer advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) and [Brotli release](https://github.com/google/brotli/releases/tag/v1.2.1) provide provenance.

## Owner-run frontend boundary regressions

`python3 -m unittest discover -s scripts/release -p 'test_*.py'` includes disposable
installer provenance, source/artifact identity, frontend scope, provider configuration,
secret custody, interrupted requests and read-only reconciliation cases. Run
`node --test scripts/release/oracle_vercel_transport_guard.test.cjs` with loopback
socket access for atomic request-budget and real transport failure cases.
The separate pinned CLI protocol fixture requires the credential-free disposable
CLI image and synthetic custody/workspaces; the protected guide specifies that
fixture arrangement. It never accepts provider credentials or authorizes a release.

The anonymous Portal browser probe checks EN/DE presentation, mobile and desktop,
system appearance, reduced motion, accessibility, existing contact navigation and
private anonymous denials in Chromium, Firefox and WebKit. Its explicit synthetic
loopback entry emits `LOCAL_SYNTHETIC_NOT_HOSTED`, which cannot satisfy the hosted
receipt gate. Real owner-run CLI invocation accepts only the approved HTTPS origins.
It submits no contact form and makes no account, publication or data mutation.

`node --test scripts/release/oracle_portal_browser_readiness.test.mjs` exercises the
actual owner probe in all three installed browsers. The disposable test directory
must resolve the frontend's locked browser dependencies, as in `verify.yml`. Open
background requests cannot replace successful-document and visible-content checks;
failed documents and missing expected content still fail. Navigation waits for the
destination document and rendered product anchor. The probe retains all 18 views,
accessibility, JavaScript-error, mutation, prefetch and anonymous-boundary checks.
The disposable regression has a 60-second lifecycle budget for cold browser startup,
assertions and cleanup; launch/navigation/background-request waits are separately
bounded at 10/10/5 seconds. It releases held responses before closing the browser,
including failed-launch cleanup, and records phase diagnostics. Rendered assertions
remain at five seconds. Production probe timeouts and source-specific qualification
allowances are unchanged. This follows
[Playwright's readiness guidance](https://playwright.dev/docs/api/class-page#page-wait-for-load-state).

Shared responsive links now default to `prefetch={false}` while preserving explicit
caller overrides and click navigation. This bounds anonymous background work and
avoids the reproduced WebKit speculative-fetch failures during page transitions.
The source-equivalence gate accepts only that exact navigation-byte transformation;
a broader navigation edit requires broader qualification. The browser probe keeps
its zero-error gate and also requires zero speculative prefetches.

The Portal project's existing default region and prebuilt deployment regions are
separate identities: the source-bound profile preserves project default `iad1`
and actual function region `fra1`. The named provider readback and real pinned-CLI
fixture verify both; qualification never changes a provider setting to make an
assumption pass. A changed project default or deployment region is unqualified.

Callback preservation uses the application's existing HTTPS Cloudflare Access team
host and exact callback-path contract, with no userinfo, custom port, query or
fragment. The runner validates that structure before credential use, then checks
the exact named existing provider value; it never changes Access, accounts or MFA.

## Drone product introduction

After building the frontend, run `npm run test:drone-product` from
`onesa-company-portal-frontend`. The production-renderer fixture refuses private frontend
env files, uses a synthetic loopback content service and checks EN/DE, 390/1440px,
light/dark, keyboard-operable concept rotation, axe and existing enquiry links.
The drone media checks decode responsive images, require zero video requests before
explicit playback (also under reduced motion), verify the real local 12-second MP4
and native controls, exercise a failed video request and preserve no-JavaScript
content. They also check the homepage and portfolio entry. The silent film animates
AI-generated concept stills; it is not footage of aircraft, simulation or a working
product. Prompts, image/video hashes and processing are in
`onesa-company-portal-frontend/public/brand/sources.json`.
It does not submit a live enquiry or establish hosted publication approval.

Worker process regressions use `node --test scripts/release/oracle_portal_worker_fixture.test.mjs scripts/release/oracle_portal_worker_smtp.test.mjs scripts/release/oracle_portal_worker_probe.test.mjs`.
The backend image-security job additionally runs `sudo -n python3 scripts/release/worker_fixture_smoke.py "$image" --worker-workflows --synthetic-scanner` on the disposable GitHub-hosted runner. It uses an internal Docker network, temporary PostgreSQL/TLS, loopback S3/SMTP protocol fixtures, and a synthetic scanner protocol fixture. The original seven-case database fixture test remains separate.

The process suite starts the actual worker and verifies password/MFA login and replay denial, private-file quarantine and role denials, clean/rejected scan handling, TLS mail acceptance, once-only queue execution, actual object deletion, stale-lock recovery, retry exhaustion, staging idle backoff, graceful shutdown, and session persistence across worker restarts. SMTP acceptance does not establish inbox delivery; the protocol fixtures do not establish external storage or scanner acceptance. The synthetic source/CI inputs are parser-test data, never issued release records. Hosted staging still requires the commissioned external verifier, a reserved source-bound context, exact artifacts and real operational evidence. The new probe is not a production worker executor or an issuer.

## Scanner qualification resource readback

The isolated scanner qualification uses a bounded 2560 MiB memory budget. The
observer compares actual memory, CPU and process limits, capabilities, ports and
read-only isolation with the signed source profile before and after restart.
Resource drift remains a failed check. Existing host-capacity, security, signature,
authenticated-workflow and rollback gates are still required. The synthetic
contract tests do not establish genuine hosted memory headroom or acceptance.
