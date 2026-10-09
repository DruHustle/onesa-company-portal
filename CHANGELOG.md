# Changelog

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
