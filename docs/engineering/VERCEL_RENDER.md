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


## Current Portal deployment gate

The reviewed Dockerfile CMD and restricted-role/schema readiness tests pass in CI. The hosted API remains unqualified: the owner migration secret failed the established Portal database identity guard. Confirm the intended Portal Neon project/branch and direct hostname before any further repair. Never substitute AI credentials or bypass this guard. Use `repair-hosting.yml` for the targeted, identity-checked operator procedure; it verifies schema checksums and preserves records. Read-only inspection is supported on the audit branch; applying changes remains restricted to the reviewed operator/main branches. The frontend also needs server-only BACKEND_URL and PROXY_SHARED_KEY, and the configured worker ID must be replaced by a verified worker target. No successful Portal rollout is claimed.

## Owner-confirmed alternate Portal endpoint

On 2026-10-11 the owner identified direct endpoint `ep-autumn-glade-b9760olg.c-7.eu-central-1.aws.neon.tech`, database `neondb`. The Render runtime was previously verified against the separate `dark-boat` endpoint. Do not replace the runtime URL or broaden permission-repair identity checks merely because a new endpoint was supplied.

Use `repair-hosting.yml` on `audit/portal-master-acceptance` with `portal_action=inspect-confirmed-target` to inspect only the confirmed direct migration secret, TLS and Portal schema in a read-only transaction. It reports an empty, mismatched or verified Portal schema and whether application rows exist without returning records or credentials. It reads the existing provider identity but does not connect to its database, change settings, migrate, provision roles or deploy. Database reconciliation/cutover and backup requirements depend on the actual inventory; an empty replacement must not silently discard existing Portal records.

TLS inspection uses the established client socket encrypted/authorized state; server-side pg_stat_ssl does not qualify the client-to-proxy connection. See [Node TLS socket verification](https://nodejs.org/api/tls.html#tlssocketauthorized).
