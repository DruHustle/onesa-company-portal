# Session handoff

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
