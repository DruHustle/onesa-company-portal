# Deployment and independent releases

The frontend and backend have separate Docker build contexts and versioned images.
Build either image using the build guide, label it with the reviewed source revision,
and release only the selected application when API compatibility allows. Worker and
migration jobs use the backend image. Do not bundle sibling repositories.

Before production: approve domain/content/ownership, provision TLS ingress, a private
PostgreSQL database and encrypted access-controlled storage, generate runtime secrets,
validate email/storage/antivirus integrations and verify backup restoration. Apply
migrations once through a controlled job before API rollout. Retain the old image and
use backward-compatible migrations so rollback does not require deleting data.

Reference stack: `compose.production.yaml`, proxy settings under `infra/proxy`, and
`scripts/verify-production-gates.mjs`. Supply a private `.env.production` via
`PORTAL_ENV_FILE`, `POSTGRES_PASSWORD`, approved `PORTAL_DOMAIN`, `BACKEND_IMAGE` and
`FRONTEND_IMAGE`. Validate configuration with `docker compose --env-file .env.production
-f compose.production.yaml config --quiet` (single shell command). Do not print expanded
configuration containing secrets. Only deploy after explicit authorization.

For separate hosts, route `/api/v1/*` from the frontend's public origin to the backend
through TLS ingress, including cookies, Origin and CSRF headers. Configure the frontend
server's `BACKEND_URL` and backend `PUBLIC_ORIGIN` consistently. Keep database and storage
private. Health checks: frontend `/en`; backend `/api/v1/ready`. Run smoke and isolated
browser checks before traffic promotion. Monitor authentication/errors/worker queues.

`release.yml` selects and builds one application container artifact manually; it does not publish or
deploy. Configure production reviewers in GitHub and verify the selected commit passed
`verify` and `publication-hygiene` before manually dispatching it; the workflow enforces these exact-revision checks. Artifacts must contain
images/approved synthetic evidence only, never corporate PDFs, uploads or secrets.


### Release-candidate protocol migration (2026-10-10)

Generated clients are derived from actual route schemas; accepted release-baseline.json is unchanged. New bounded upload/chunk/finalization/cancel routes preserve agreed size capabilities and authorize owner/expiry/quota/type/checksum at the backend. Large downloads use reauthorized bounded chunks; older whole-file clients must migrate before hosted large-file acceptance. Portal user mutations require current password plus fresh MFA/recovery proof; older clients receive403 STEP_UP_REQUIRED, not a silent fallback. Public provenance/reviewer fields stay private. This intentional compatibility policy requires coordinated client/version approval. AI optional invitation input and strictly refined response schemas are directionally checked. Durable recovery uses one-use tokens and queued/provider-accepted truthfulness; hosted mail is not verified. Consult generated contracts and restricted release ledger for exact paths/tests; no public rollout occurred.


Owner free-only direction supersedes paid provisioning examples. Follow
[FREE_STAGING_SETUP](FREE_STAGING_SETUP.md) and staging.env.example; no paid
Blueprint/application or production release is approved by an example.

### Neon S3 environment and Render build troubleshooting — 2026-10-10

API and worker need the same private `S3_BUCKET` (owner-selected `s3-bucket`).
`S3_ENDPOINT` and `S3_REGION` remain canonical; the backend also accepts
`AWS_ENDPOINT_URL_S3` and `AWS_REGION` when the canonical values are absent.
The SDK reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` privately. An
endpoint alone does not identify a bucket. Replace exposed credentials directly
in Neon/Render; do not place their values in source, frontend bundles or reports.

Use root directory `onesa-company-portal-backend`, Dockerfile `./Dockerfile`,
and Docker context `.`. The seven migrations are tracked in that backend root.
A missing-migrations COPY error requires verifying the actual service, selected
commit and build context; do not remove the COPY or skip schema checks. The
API starts with `node dist/src/server.js`; a real background worker uses
`node dist/src/jobs/worker.js`, not a web service that requires an HTTP port.
Do not create a paid worker or hide missing worker functionality to satisfy the
owner's free-only requirement. Both roles require verified shared persistent
storage. Successful compilation does not prove bucket access, credential
rotation, migrations, worker operation or production release qualification.
