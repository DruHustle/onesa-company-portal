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
