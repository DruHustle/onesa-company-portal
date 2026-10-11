# Free-only staging setup — 2026-10-10

## Owner setup for the verified Portal database — 2026-10-11

The owner has supplied the API `srv-db5k5had0e5s73fos4g0` at
`https://onesa-company-portal-backend-staging.onrender.com` and the proposed worker
`srv-db5k4mlckfvc73agdr40` at
`https://onesa-company-portal-backend-worker-e1j1.onrender.com`.
Do not create duplicate services. Their repository, branch, runtime, plan,
environment scope and actual health remain unverified: GitHub refused the new
inspection job before startup with an account billing/spending-limit restriction.
No provider environment values, service commands or deployments were changed.

After GitHub Actions is available, run **Inspect hosting configuration** on
`audit/portal-master-acceptance`, selecting `portal_scope=staging`:

```sh
gh workflow run inspect-hosting.yml --repo DruHustle/onesa-company-portal \
  --ref audit/portal-master-acceptance -f portal_scope=staging
```

This action only reads the two supplied service IDs, allowlisted resource inventory
and existing production frontend configuration; it never deploys or prints
credential values. Review repository/branch/type mismatches before writes.
Check **GitHub account → Settings → Billing & licensing → Usage / Budgets and alerts**
for available included Actions usage and the restriction. Keep paid usage disabled.
If included minutes are exhausted, wait for their reset or separately approve an
existing private self-hosted runner. Do not raise a spending limit automatically
or repeatedly retry a rejected workflow without resolving its cause.

The autumn-glade Portal database is already initialized with seven reviewed
migrations and a verified restricted `onesa_portal_app` login. Its fresh password
is saved as private repository Actions secret `PORTAL_APP_DB_PASSWORD`; GitHub
does not reveal saved secret values. Do not reset that role or use `neondb_owner`
as the API login. An operator workflow can transfer its credential privately once
the actual staging service is identified. Do not copy production credentials.

For the supplied API, check **Render → service → Settings** against:

| Setting | Value |
|---|---|
| Name | Owner-created `onesa-company-portal-backend_staging` |
| Repository | `DruHustle/onesa-company-portal` |
| Branch | `audit/portal-master-acceptance` |
| Root Directory | `onesa-company-portal-backend` |
| Runtime | Docker |
| Dockerfile / context | `./Dockerfile` / `.` relative to the root directory |
| Docker Command override | Leave blank; use the reviewed image CMD |
| Region | Frankfurt |
| Instance | Free; do not apply the historical paid root Blueprint |
| Auto Deploy | Off |
| Health Check Path | `/api/v1/ready` |

Do not replace the existing production service. Creation may initiate an initial
build; the service cannot pass startup/readiness until its private staging settings
are installed. A resource existing in the dashboard is not successful deployment.
The service ID and URL have already been supplied; they are not requested again.
The verified restricted credential still needs a guarded private transfer;
do not paste it into chat or use the Neon owner connection as the API runtime.

Staging API configuration uses `NODE_ENV=production` for hosted security,
`PUBLISH_ENABLED=false`, a restricted pooled `DATABASE_URL` for autumn-glade,
a fresh independent `SESSION_KEY` of 64 hex characters, and a fresh independent
`PROXY_SHARED_KEY`. `PUBLIC_ORIGIN` must be the actual protected staging frontend
origin; a separate company origin is optional and must be distinct if configured.
The API requires a private staging bucket and its actual `S3_BUCKET`, `S3_ENDPOINT`,
`S3_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Use `staging.env.example`
as the key inventory, with fresh scoped credentials entered through approved settings.
Never place the owner database URL or backend credentials in `NEXT_PUBLIC` variables.

For Vercel, retain the existing portal project and frontend root
`onesa-company-portal-frontend`, with production branch `main`. Enable Vercel
Authentication for Preview deployments. Keep native Git deployments disabled;
deployment will use GitHub Actions/CLI. Use Preview-only variables scoped to
`audit/portal-master-acceptance`, with server-only `BACKEND_URL` set to the verified
new API and the matching fresh `PROXY_SHARED_KEY`. The actual protected Preview
origin must be coordinated with `PUBLIC_ORIGIN`, `SITE_URL` and `PORTAL_URL`; do
not guess a Vercel hostname or reuse public production origins.

No free Render background-worker instance exists. Do not select a paid worker or
use an unrelated web service as one. Full enquiry/email/scanner acceptance still
needs an independently approved worker/scanner host. A free existing private host
is possible, but its real reachable endpoints and storage access must be verified.
The supplied `backend-worker_staging` public URL is characteristic of a web service;
its name does not establish a background-worker runtime. Do not add a dummy HTTP
health response to disguise worker failure or claim an always-running Free worker.
Confirm the actual service type first; preserve it without repurposing it.

Acceptance remains exact-source CI, real health/ready JSON200, anonymous auth401,
authenticated CMS/business tests, storage and worker/mail tests, persistence and
restoration. See [Render Free limits](https://render.com/docs/free) and
[Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

The owner has rejected paid services and will create the isolated staging environment.
No resource, paid upgrade, trial subscription, DNS change or populated private env
file was changed by preparing this guide. Checked-in examples contain no credentials.
**Free staging is feasible; the complete production stack is not yet qualified.**

## Verified ongoing free options

| Component | Free option | Important limit / fit |
| --- | --- | --- |
| Separate AI and Portal PostgreSQL | **Neon Free**, independent projects/credentials; prefer AWS Frankfurt | 1 GB SQL storage/project, 100 CU-hours/project/month, 5 GB egress/project/month, six-hour restore history; can scale to zero. The current account's quota must be checked. |
| Private Portal objects | **Neon Free Object Storage**, isolated staging bucket/credential | 5 GB/project; S3-compatible. Use actual endpoint and private bucket policies. No credential reuse or automatic data copy. |
| API web services | **Render Free**, Docker in Frankfurt | Sleeps after 15 minutes; 750 running instance hours shared per workspace/month; ephemeral disk, limited memory. No free background-worker type. Do not attach a paid disk. |
| Commercial Next.js frontends | **Netlify Free** | 300 credits/month hard cap; no auto-recharge. Shared account exhaustion can pause all projects. Next.js adapter/host routing/streaming must be tested on this provider. |
| Application email | **Resend Free** | 3,000 messages/month, 100/day; quotas shared between products in one account. Requires fresh scoped credentials and actual approved-recipient delivery tests. |
| Staff mailboxes | **Zoho Mail free custom-domain plan**, if offered in the selected data center | Up to five users, 5 GB/user, one domain. Availability is regional; verify the EU signup actually offers Free. Do not choose a paid plan or assume IMAP support. |

Official sources checked on 2026-10-10:
[Neon current plan](https://neon.com/docs/introduction/plans),
[Neon's October storage update](https://neon.com/blog/neon-free-plan-1-gb-per-project),
[Neon object storage](https://neon.com/blog/neon-backend-is-ga),
[Render Free](https://render.com/docs/free),
[Netlify current pricing](https://www.netlify.com/pricing/),
[Netlify commercial free use](https://www.netlify.com/blog/introducing-netlify-free-plan/),
[Resend current pricing](https://resend.com/pricing),
[Zoho regional availability](https://www.zoho.com/mail/custom-domain-email.html).
The older Netlify article establishes commercial eligibility, not current numerical
quotas; use the current pricing page for those.

**Vercel Hobby is limited to personal/noncommercial use.** Do not describe it as a
free commercial Onesa hosting plan. Existing Vercel projects/domains/workflows are
preserved; moving to Netlify is a proposed provider choice, not an applied migration.
[Official Vercel policy](https://vercel.com/docs/limits/fair-use-guidelines).
Render's free PostgreSQL expires after **30 days**, with no backups; it is a temporary
test option, not the durable free database recommendation. No free Render worker exists.
Render Free compute can still incur bandwidth/build overages when a payment method
is attached. For strict zero spend, use a Free workspace without a payment method,
check the build spend limit and usage, and accept suspension at quota exhaustion;
never enable an upgrade/paid add-on. The existing account's payment method/plan has
not been changed. Free staging has no shell or one-off-job access on Render, so run
migrations from the reviewed image on an authorized operator machine. A domain's
existing registration/renewal cost is also not made free by hosting.

## Free inference and continuous workers

No verified offer provides a dedicated, always-on European GPU running the existing
vLLM/checkpoint configuration at zero ongoing cost. Paid Scaleway/Render proposals
are superseded, not approved. Keep hosted inference **BLOCKED**, and preserve the
working local Mac Ollama model without exposing the Mac to the internet.

Candidates, rather than configured integrations:

- **Groq Free**: a hosted API, not a dedicated GPU VM. Its current published free
  `qwen/qwen3.8-27b` allowance is 30 requests/minute, 1,000/day, 8,000 tokens/minute
  and 200,000/day; actual account limits may differ. It is a different checkpoint
  from the local Qwen 4B. Endpoint `https://api.groq.com/openai/v1` is official,
  but the current adapters name mock/Ollama/vLLM; provider identity, discovery,
  streaming, cancellation and errors need an honest integration/acceptance change
  before wiring it in. Do not label Groq as a deployed vLLM host. Retained customer
  data is stored in the US; ZDR is available but does not establish EU-only
  processing. Use only synthetic staging material until privacy/model approval.
  [Free limits](https://console.groq.com/docs/rate-limits),
  [data controls/location](https://console.groq.com/docs/your-data).
- **Cloudflare Workers AI Free**: 10,000 neurons/day, shared across models, with
  hard failure when free quota is exhausted. Some models require paid access.
  Generation/embedding models and OpenAI-style response compatibility must be
  selected and qualified; EU-only execution and the existing pinned embedding
  revision are not established. No automatic provider or vector-version switch.
  [Current model pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- **Hugging Face ZeroGPU**: qualifying personal accounts older than 30 days may
  host two free Spaces; free usage is five GPU-minutes/day and Gradio-based.
  Organization hosting requires a paid plan. This is a queued demo service,
  not the current always-on private vLLM API deployment.
  [Official eligibility and limits](https://huggingface.co/docs/hub/spaces-zerogpu).
- **Oracle Cloud Always Free CPU**: current A1 allowance is **2 OCPUs/12 GB RAM**
  (1,500 OCPU-hours and 9,000 GB-hours/month), with 200 GB block storage quota.
  This is CPU, not GPU; home-region capacity/eligibility must be confirmed, and
  idle instances can be reclaimed. An available approved EU instance could run
  separate existing worker processes and potentially quantized Ollama/CPU
  embeddings after Linux memory/latency tests. No throughput, availability or
  public endpoint is established. Remain on Always Free-labelled resources;
  do not upgrade to pay-as-you-go to obtain capacity. Account terms/verification
  are the owner's action. [Current official allowance](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Recommendation for the first free pilot: **Neon database + Render API + Netlify
frontend**, isolated synthetic data. Choose hosted inference separately after model
and privacy review; until then the AI database/core can be tested while inference
remains unavailable. Existing semantic embedding implementation is retained, not
silently replaced with lexical search. Full worker/file/email acceptance remains
blocked without an actual worker/scanner host. Do not fake a worker with a web-service
ID or add artificial traffic to defeat provider sleep/quotas.

## Owner setup: isolation and secrets

1. Keep production domains/services/data untouched. Create named **staging projects**
   in the chosen free accounts and use their actual assigned HTTPS origins first;
   no Squarespace DNS cutover is needed to start. Company/portal need distinct
   assigned origins. Protect staging access; use synthetic accounts/documents only.
2. In Neon, inspect existing projects first. Reuse only a verified AI-specific
   staging project, never Portal's database. Otherwise create `onesa-ai-db-staging`
   on Free, PostgreSQL 16, **AWS Frankfurt**, with scale-to-zero. Portal staging
   gets its own project/credentials. No production-to-staging copy. Keep paid
   upgrades/add-ons off and monitor database/storage/compute/egress limits.
3. For AI, enable `CREATE EXTENSION IF NOT EXISTS vector` using the identified
   staging bootstrap owner. Preserve **256** dimensions and versioned embeddings.
   Keep separate migration owner and restricted application CRUD roles. Use the
   actual externally reachable Neon TLS host across providers: it is **not** a
   Render Internal URL/private-network connection. Verify `sslmode=require` and
   actual encrypted connection. Use the established `postgresql+psycopg` driver
   deliberately for AI, plain `postgresql` for Portal's Node pg driver.
   [Neon regions](https://neon.com/docs/introduction/regions),
   [pgvector](https://neon.com/docs/extensions/pgvector).
4. Copy the repository's `staging.env.example` to an ignored private `.env.staging`
   only if that file does not already exist (`cp -n staging.env.example .env.staging`).
   Replace blank REQUIRED secrets privately. Generate new staging keys in a trusted
   secret manager. Never reuse the credentials exposed earlier; do not rotate a
   persistent Portal encryption key blindly and strand existing data. Import only
   the backend section into Render and only frontend settings into the frontend
   project. **Never import the entire backend env into frontend settings.**
5. Create a Render **Free web service** from the relevant GitHub repo, `main`, Docker,
   Frankfurt, root `<repository-name>-backend`, Dockerfile `./Dockerfile`, context `.`.
   Do not apply the historical paid root `render.yaml`. A web-service-only
   [free staging Blueprint](../../infra/deployment/render-free-staging.yaml) is
   prepared separately; it intentionally provisions no database or worker.
   Disable automatic deployment;
   save variables **without deploying** until the intended source is reviewed and
   CI green. Render controls `PORT`; listen on 0.0.0.0. Use the product command below.
6. Create a Netlify **Free staging project**, connected to the correct GitHub repo,
   Node 24, with the product frontend base directory below; build `npm run build`.
   Let the Next.js adapter detect the framework (SSR/BFF is required; do not choose
   static export). Configure only its frontend variables and exact assigned origins.
   Keep existing production GitHub service/project IDs unchanged. A staging service
   needs its own identity; never overwrite production deployment secrets with it.
   Keep automated production publishing off; manually qualify the exact reviewed
   staging commit. The current GitHub production workflow targets Vercel and is
   deliberately still guarded; it is not a Netlify deployment workflow.
   [Next.js adapter](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/),
   [Node 24](https://www.netlify.com/changelog/2026-07-07-nodejs-24-default-new-sites/).
7. With a securely injected, confirmed **staging migration-role** connection, run
   only the product migration below. Check schema head/permissions and a synthetic
   restricted-role connection before deployment. Do not migrate an unidentified
   target. Back up existing staging data if any. No connection string in CLI arguments.
8. Inspect UI/base URLs and BFF origins; deploy only the reviewed staging artifact.
   Test liveness vs core/model readiness, login/invitation rules, upload ownership,
   synthetic retrieval and honest dependency failures. No fake AI success or green
   readiness because a server merely starts. Ensure original source-upload archive
   requirements are distinguished from extracted text/vector persistence.
9. Test synthetic backup/restore to a separately isolated free target, roles/vector
   dimensions/revocations/deletions and mail suppression. Neon's six-hour recovery
   window does not establish business RTO/RPO or complete object restoration. Keep
   separate encrypted SQL/object exports under an approved retention procedure.
   Quota exhaustion, sleep and free-provider outages require honest UI/error handling.
10. Real email tests need an approved recipient and the rotated Resend sending-only
    key entered directly in the worker settings. Respect both daily and monthly
    quotas across the products. Zoho staff inbox setup is independent from Resend.
    Do not send real email merely because DNS/domain verification exists.

No staged/live acceptance, original-file retention, continuous worker operation,
managed GPU capacity or company legal approval is claimed. Production remains NO-GO.

## Portal-specific commands and environment

- API root: `onesa-company-portal-backend`; command `node dist/src/server.js`.
  `/api/v1/health` is liveness; `/api/v1/ready` includes the existing production
  prerequisites. Do not bypass private-storage/worker/publication checks.
- Frontend base: `onesa-company-portal-frontend`. Server-only `BACKEND_URL` is the
  real Render staging origin. `PROXY_SHARED_KEY` must match that staging API.
  `SITE_URL`, `COMPANY_ORIGIN` are the exact distinct company staging origin;
  `PORTAL_URL`, `PUBLIC_ORIGIN` are the exact portal staging origin. No secret
  `NEXT_PUBLIC_*`; only the public 10 MiB upload ceiling. Leave publication off.
- Use `NODE_ENV=production` to retain HTTPS/cookie/proxy/storage protections even
  in cloud staging. Generate a separate persistent >=48-character SESSION_KEY
  for the empty staging database; do not replace the production encryption key.
- Migration from the reviewed backend image: `node dist/src/services/migrate.js`,
  with privately injected **staging owner/migration-role DATABASE_URL**. Verify
  migrations/checksums and then use the restricted role for API/worker. Do not
  use the exposed Neon owner URL as a runtime credential or test live data.
- Create/verify a private staging bucket in the isolated Portal Neon project;
  enter actual S3_BUCKET, S3_ENDPOINT, S3_REGION and newly scoped AWS access/secret
  keys. Endpoint alone is not a credential. The existing production bucket and
  objects are preserved. Scanner host must be a real approved reachable ClamAV
  service; do not bypass quarantine when none is available.
- Worker command: `node dist/src/jobs/worker.js`. Render's stored worker ID actually
  points at a web service; no same-repository background worker was discovered.
  For free-only staging, run the existing worker against the isolated staging
  env on an owner-controlled development/Always Free CPU host. This is not
  evidence of continuous production worker availability. A proper hosted worker
  must be provisioned/qualified before recruitment/files/mail release.
- [`staging.env.example`](../../staging.env.example) supplies supported names and
  safe blocked defaults. SMTP with no host leaves mail unavailable until the
  owner supplies an approved test recipient and privately configures Resend.
  Do not import an unset NOTIFY_EMAIL as an empty invalid email value.

Do not promote the free staging project onto `onesa.eu`/`portal.onesa.eu` or change
Squarespace/Zoho/Resend DNS in this setup. Existing production projects are preserved.
## Confirmed Portal staging layout repair — 2026-10-11

Read-only Actions inspection verified the owner-created API
`srv-db5k5had0e5s73fos4g0` is a Frankfurt Free Docker web service in this repository,
but uses main, the wrong root/health path, native auto-deploy and missing runtime
variables. After `verify.yml` and `repository-hygiene.yml` pass on the exact reviewed
`audit/portal-master-acceptance` revision, run **Repair existing hosting configuration**
with `portal_action=repair-staging-layout` on that branch. This pauses native
auto-deploy, sets the audit branch, backend root, Dockerfile/context, Node server
CMD and `/api/v1/ready`, then verifies readback. It does not deploy, initialize a
database, read/copy runtime credentials, change a plan or modify production.

Set fresh, independently scoped staging `DATABASE_URL`, `SESSION_KEY` (at least
48 characters), `PUBLIC_ORIGIN`, `COMPANY_ORIGIN`, `PROXY_SHARED_KEY`, `S3_BUCKET`,
`S3_ENDPOINT`, `S3_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` directly in
the staging API settings. Keep `PUBLISH_ENABLED=false`. Use a restricted application
database role and private staging storage. Never use previously exposed credentials
or the migration-owner URL. Saving settings is not readiness or release acceptance.

The purported worker `srv-db5k4mlckfvc73agdr40` was authenticated as a Free web
service, not a background worker. Do not convert it to a paid plan or wrap a worker
in dummy HTTP health checks. A separately approved genuinely free private executor
and delivery/scanner/storage acceptance remain prerequisites.

The [Render update-service API](https://api-docs.render.com/reference/update-service)
does not deploy configuration updates automatically; deployment is a separate
operation requiring the existing release/target gates.
