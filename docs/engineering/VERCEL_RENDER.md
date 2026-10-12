# Vercel frontend and Render backend

> Current private-Free release policy: [safeguards and external owner authorization](../development/PRIVATE_FREE_SAFEGUARDS.md). Legacy JSON approval is retired; native protection requirements below apply only to a verified supported configuration.

Owner-created Portal staging targets are recorded in `FREE_STAGING_SETUP.md`.
Use the read-only inspection workflow's `portal_scope=staging` option to inspect
those IDs; the default remains production inspection. This does not deploy or
modify production secrets. Current runner billing/usage restrictions must be
resolved before hosted inspection or qualification can resume.

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
historically required the exact-commit `RELEASE_QUALIFICATION_JSON` secret with all four
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

Inspection also returns allowlisted service/deployment IDs, Preview-protection
status and an existing Render inventory restricted to the three Onesa repositories.
Pagination is bounded and partial results are marked incomplete. Discovery alone
does not authorize deploying or repurposing an existing resource. No environment
values or provider commands are printed. See [Render pagination](https://api-docs.render.com/reference/pagination).

`gh workflow run repair-hosting.yml --ref main` repairs the existing service layout
and absent nonsecret configuration, then reads it back. Repository and runtime
identity must match before any update. This does not deploy or migrate the database;
missing database/model credentials and qualification remain explicit blockers.


## Verified Portal database targets — 2026-10-12

The owner-authenticated Neon inventory in organization `org-rapid-flower-72785494`
identifies these existing projects. The owner's convention is a `-staging` suffix
on the **project** name; the default branch inside that project may be named `production`.

| Scope | Project | Branch | SQL endpoint |
| --- | --- | --- | --- |
| Production | `morning-mode-04948381` / `onesa-ai-company-portal-backend-db` | `br-red-morning-b9d1sxnz` | `ep-dark-boat-b91lg22g` |
| Staging | `gentle-mud-16323345` / `onesa-ai-company-portal-backend-db-staging` | `br-little-boat-b9fg0rqq` | `ep-morning-shadow-b9jkzgsz` |

Both use `neondb` and Frankfurt `c-7.eu-central-1.aws.neon.tech`. Runtime connections
use the pooled endpoint, certificate-verified TLS and restricted `onesa_portal_app`.
Owner migration credentials must target the same scope directly. Never substitute
`summer-rain-37989301` / the non-staging migrations project (`ep-autumn-glade-b9760olg`)
for staging. Preserve that historical database and its records; do not copy its data.

Fresh read-only SQL found both approved runtime projects empty and using elevated
owner logins. The corrected staging target was initialized with seven unchanged,
CI-qualified migrations and a new staging-only restricted role, preserving existing
roles/data/passwords. Its actual TLS, login, checksums and zero operational rows were
verified from Oracle. Only staging Render `DATABASE_URL` and the root-owned Oracle
staging configuration were rebound. No production configuration/data was changed.
Private credentials and factual receipts remain under `private/oracle/worker`.

`repair-hosting.yml` keeps inspection read-only. A repair or empty-target initializer
must run on its allowed branch with complete exact-source CI/hygiene. Initialization
requires a privately saved dedicated application password and refuses existing public
objects or application roles. It is transactional and never resets credentials.
The production initializer now rejects the obsolete alternate migration project;
production remains uninitialized and must pass the actual release/operations gates.
Use `dev → staging → main`; do not recreate historical audit branches.

ClamAV remains private to Oracle through `CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock`.
Leave `CLAMAV_HOST` and `CLAMAV_PORT` unset in Render; uploads remain quarantined until
the qualified Oracle executor scans them. Legacy Render worker auto-deployments are
off. The failed staging worker is suspended; the production worker is retained until
Oracle production qualification succeeds. Do not add credentials to the obsolete
staging web service or introduce duplicate job executors.

Database initialization/configuration is distinct from deployment acceptance. Recheck
all bucket objects against synthetic provenance before enabling staging jobs, rerun
protected hosted acceptance on the corrected binding, and verify backups/restores,
mail delivery, monitoring, legal/privacy processing and production role/storage scope.
Client TLS is qualified by the actual encrypted/authorized socket, not Neon’s separate
proxy-to-database `pg_stat_ssl` hop.

## Automated qualification migration

See [automated release qualification](AUTOMATED_QUALIFICATION.md) for immutable
Actions evidence, explicit owner reviews, build integrity and the guarded migration.
The legacy JSON secret fallback is retired. Private-Free production uses the external owner handoff; production credential removal/rotation and provider control verification remain owner actions.
