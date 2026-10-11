# Vercel frontend and Render backend

The repository contains provider configuration, not a completed remote deployment.
Use the private `onesa-ug/onesa-company-portal` GitHub repository and `main`. The frontend and
backend remain separate release units. Grant the providers access only to the required
organization repositories. Deploy through `.github/workflows/deploy.yml`, dispatched from GitHub Actions.

## Vercel

Create project `onesa-company-portal` with Next.js, Node 24, root directory `onesa-company-portal-frontend`,
install `npm ci` and build `npm run build`. Configuration is in that root's
`vercel.json`. For the AI frontend enable inclusion of source outside the project root
for its shared API client within the frontend directory. Production branch: `main`.
Deploy a protected preview first, using one stable HTTPS hostname for authentication;
do not send production credentials to arbitrary preview deployments.

Set server-only backend origin: `BACKEND_URL` for the portal, `ONESA_API_URL` for AI,
using the actual Render HTTPS URL. Cookies/CSRF/Origin pass through the frontend BFF;
do not use cross-site cookies or expose database/model credentials to JavaScript.
Portal additionally needs `PUBLIC_ORIGIN`, `SITE_URL` and matching server-only
`PROXY_SHARED_KEY`. Supply `NEXT_PUBLIC_MAX_UPLOAD_BYTES=10485760` at build time.
AI route duration is 150 seconds for bounded streamed generation; verify plan limits.

## Render

`render.yaml` configures Docker services with app-only build contexts, private
PostgreSQL, Frankfurt region, readiness checks and disabled native auto-deploys. Templates
use paid always-on resources: review actual pricing/capacity before applying. No
resources or charges are created by storing this file. Databases disable public IP
access by default; allow only an approved temporary operator address if external
migration access is needed, and remove it afterwards.

Create/provision database schema with a separate migration-owner identity; then supply
only a restricted application URL in Render's secret environment settings. Do not use
a managed database owner's connection string directly as the web application's role.
Render user-creation permissions must be checked; if SQL CREATE ROLE is unavailable,
use a provider-supported scoped user and equivalent grants. Application readiness is
the final privilege check. Owner credentials must not remain in API/worker environments.

Portal uses a Render API and background worker with a shared encrypted private S3
bucket and encryption key. Supply scoped bucket credentials privately; do not attach
separate ephemeral local storage to the two services. Configure SMTP and scanner as
approved integrations; without scanning, uploaded PDFs stay quarantined. Company
facts and legal/editorial gates remain unapproved until the owner verifies them.

AI uses PostgreSQL/pgvector and a restricted database URL with `postgresql+psycopg://`.
Apply Alembic migrations using owner credentials, enable vector, and grant CRUD while
keeping `alembic_version` read-only. Set actual `ONESA_PUBLIC_ORIGIN`, secure cookies
and generated metrics token. Production configuration refuses mock inference;
local Mac Ollama is not reachable from Render. Supply a qualified authenticated
remote Ollama/vLLM endpoint and model before claiming a live AI service. No model is
downloaded or trained by deployment.

## Provider limits and promotion

Vercel function payloads are limited to4.5MB including encoding. The bounded client
preserves10MiB Portal files using512KiB upload chunks and<=1MiB reauthorized download
chunks through the same-origin BFF. AI preserves5MiB source documents similarly.
Configure the Portal build limit to10485760; do not silently apply the former3MiB
workaround. Legacy whole-file routes remain but may exceed host limits; migrate large
consumers to the bounded protocol and retest actual TLS/storage/scanner behavior.
Streaming, login/MFA, Secure cookie/CSRF, ownership, private files, DB role restrictions,
worker queues, backups/restore and rollback must pass on the actual target before
production promotion. Provider deployment does not approve corporate claims/privacy
notices. Keep public data-collection gates closed until the owner completes them.

Sources: [Vercel monorepos](https://vercel.com/docs/monorepos),
[function limits](https://vercel.com/docs/functions/limitations),
[duration](https://vercel.com/docs/functions/configuring-functions/duration),
[Render Blueprint fields](https://render.com/docs/blueprint-spec),
[monorepo roots](https://render.com/docs/monorepo-support),
[pgvector](https://render.com/docs/postgresql-extensions).

## GitHub deployment setup

One-time provider setup is required: import this private GitHub repository into Vercel,
configure the frontend root above and its production environment, and create the
Render Blueprint services, private database and backend secrets described above.
Disable Vercel Git auto-deploys and retain Render `autoDeployTrigger: off` so GitHub
Actions owns releases. Initial provider provisioning may create an initial deploy;
keep it access-protected until target checks pass.

Store the following secrets in each repository's Actions secrets. The organization
currently uses GitHub Free; private repositories cannot consume organization secrets
or deployment environment secrets on that plan. These commands prompt privately; never put credential values in command
history or chat. Vercel IDs must belong to the configured project/team. Render API
access must belong to the service owner's workspace.

```sh
gh secret set VERCEL_TOKEN --repo onesa-ug/onesa-company-portal
gh secret set VERCEL_ORG_ID --repo onesa-ug/onesa-company-portal
gh secret set VERCEL_PROJECT_ID --repo onesa-ug/onesa-company-portal
gh secret set RENDER_API_KEY --repo onesa-ug/onesa-company-portal
gh secret set RENDER_BACKEND_SERVICE_ID --repo onesa-ug/onesa-company-portal
gh secret set RENDER_WORKER_SERVICE_ID --repo onesa-ug/onesa-company-portal
gh workflow run deploy.yml --repo onesa-ug/onesa-company-portal --ref main -f application=both
gh run list --repo onesa-ug/onesa-company-portal --workflow deploy.yml
gh run watch RUN_ID --repo onesa-ug/onesa-company-portal --exit-status
```

The workflow refuses a branch other than main or a commit without successful push CI
and publication-hygiene checks. Frontend and backend jobs remain independently selectable.
Vercel builds the checked-out commit with production provider settings; Render receives
that exact SHA and is polled until live, with commit verification. Render deploy failure
or timeout fails the workflow. Check service logs and health before retrying; roll back
using provider controls to a previously qualified release if needed. No provider tokens,
database URLs or application secrets belong in the repository.

## Final release qualification — 2026-10-09

Prepared configuration is not a hosted deployment. Production promotion additionally
requires the exact-commit `RELEASE_QUALIFICATION_JSON` Actions secret with all four
reviewed gates passing and a matching source fingerprint. The local audit decision
is NO-GO. Do not supply a passing attestation until target, operations and content
approvals actually exist. See restricted `docs/internal/release-audit/` evidence.

Render AI health checks now use `/core-ready`: DB/core failures are unhealthy, while
optional inference outage reports degraded without causing restart storms. `/ready`
still verifies inference. Node runtime images exclude build-only package managers;
run compiled Node migration/worker entry points, not `npm`, inside runtime containers.


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

### Read-only hosting diagnosis

Run `gh workflow run inspect-hosting.yml --ref main` in this repository to check
the existing Render services and Vercel project using the configured Actions
secrets. The workflow never changes provider settings, deploys code, creates
resources or prints environment values. Inspect its log for required configuration
presence, root/health-path matches and the provider's deployment commit. A successful
diagnostic job means the inspection ran; it does not establish healthy deployment.
Production deployment still requires a reviewed exact-commit qualification record.

`gh workflow run repair-hosting.yml --ref main` repairs the existing service layout
and absent nonsecret configuration, then reads it back. Repository and runtime
identity must match before any update. This does not deploy or migrate the database;
missing database/model credentials and qualification remain explicit blockers.


## Render DATABASE_ROLE follow-up — 2026-10-10

Status: local role procedure and regression verification complete; hosted role repair
remains open. Baseline source `db505c89131788c05809ab240f3617ff1a99137f`;
local branch `fix/render-database-role`, uncommitted changes. No push or deployment.

DATABASE_ROLE is a custom HttpError(503) emitted by /api/v1/ready in src/app.ts when
production applicationRoleSafe rejects the connected current_user. The role is
unsafe, not necessarily missing or unable to connect: elevated role flags, schema
CREATE, relation ownership/inherited ownership, migration-table writes, or membership
in elevated roles cause rejection. The check uses NODE_ENV and the identity selected
by DATABASE_URL, not a DATABASE_ROLE environment variable. Which individual condition
failed on Render remains unverified because existing authorized workflows cannot
query the effective database role. Do not bypass this validation.

Fresh read-only provider inspection run 38077726204 confirms Docker/root/context/
Dockerfile/readiness path and nonempty direct DATABASE_URL. Latest attempted deployment
is update_failed at `532bd1c41a9f4a8310ddb931f112508d558d202b`, older than source.
The diagnostic returned direct_health_http=0 (no HTTP response obtained within its
bounded request), not readiness success. Linked environment groups, actual database
identity/TLS, live revision, migrations and active role require private provider/DB
readback. Worker binding inspection resolves a web_service, so do not apply worker
changes using that ID without verifying the actual target.

Changes: existing database-role.ts now returns safe, named privilege-failure reasons
without credentials. Existing provision.ts requires reviewed expected host/database,
a dedicated onesa_portal database and remote TLS; defaults to read-only diagnostics.
Explicit --apply retains the existing transactional limited-role grant procedure and
never changes an existing password. Readiness now checks reachability, existing
production-role restrictions, every bundled migration checksum and table CRUD/sequence grants.
Failures return honest 503 codes DATABASE_CONNECTION/DATABASE_ROLE/DATABASE_SCHEMA/
DATABASE_PERMISSIONS. Docker health check follows PORT rather than hardcoded 8300.
Added production image CMD smoke to verify.yml and extended real role integration
coverage. Public/private authorization and legal publication gates are preserved.

Both actual production backend build and Linux Node 24 test stage pass. Full backend
suite: 36 passed, zero skips, using disposable onesa_portal_test. Verified owner role
fails 503, provisioned restricted role reaches 200, migration writes/schema creation
are denied, removed grant/stale checksum/unreachable DB fail, protected auth/me=401,
health=200 independently of DB and graceful SIGTERM exits 0. Actual production image
runs default node CMD at PORT=10000. Lint/types/build, contracts/breaking-contract test,
provider tests and publication hygiene pass. No hosted success or new remote CI pass
is claimed. Legal/publication/operations gates remain open.

Reviewed operator procedure (never use the AI/Neon staging URL): confirm Portal
service DATABASE_URL and linked groups against its own approved resource; privately
inject migration-owner DATABASE_URL into an isolated operator process.
Set PORTAL_EXPECTED_DB_HOST and PORTAL_EXPECTED_DB_NAME to the independently reviewed
Portal identity. Run migrations with that owner, then `node dist/src/services/provision.js`
for read-only privilege reasons and TLS confirmation. Review role identity/membership/
ownership and grants before applying `PORTAL_APP_DB_PASSWORD=<private injection>` with
`node dist/src/services/provision.js --apply`. Required minimum: LOGIN without elevated
flags/memberships, public schema USAGE, CRUD on application tables, SELECT only on
schema_migrations, sequence USAGE/SELECT. No schema CREATE, owner membership,
migration writes, superuser or unrestricted grants. Grants cover existing tables;
rerun reviewed provisioning after owner migrations add tables. Existing passwords
are not reset: authenticate with the existing role credential or use a separately
approved rotation process. Verify connection and readiness using the restricted role,
then separately approve setting only API/actual-worker DATABASE_URL to that restricted
Portal URL (preserve database/host/TLS settings). Owner credentials must not remain in
runtime or overriding groups. Changing production secrets is not authorized here.
Deploy the exact reviewed new revision only after CI/release approval and recheck
health=200/ready=200, unavailable dependencies, authorization and publication gates.
