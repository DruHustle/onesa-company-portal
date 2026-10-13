# Database schema and ownership

PostgreSQL migrations in the backend are ordered, checksummed and transactionally
serialized by an advisory lock. `schema_migrations` records applied versions; editing
an applied migration is rejected. Tables represent users/sessions/MFA, company facts,
settings, content/revisions, jobs, enquiries, applications/files, templates and audit.
UUIDs, foreign keys and constraints preserve workflow integrity.

Production migrations/seeding/provisioning use the owner connection. API and worker
use `onesa_portal_app`, which has public schema USAGE, CRUD on application tables,
read-only access to `schema_migrations` and no schema creation/admin privileges.
Run `dist/src/services/provision.js` with a generated PORTAL_APP_DB_PASSWORD after
migrations. Existing passwords are retained; rotations require an operator procedure.
Render-managed databases require an operator-created scoped user if CREATE ROLE is
unavailable to the managed owner; grant equivalent privileges and verify readiness.

Never run integration tests on application data: TEST_DATABASE_URL must end `_test`.
Backups and restore targets remain private and outside Git. Use an isolated restore
and approved retention/key custody before production migration or rollback.

## Internal privacy governance

Migration 008 adds `governance_records`, `governance_versions` and
`governance_events` to the existing Portal schema. Current/effective revision foreign
keys are deferred until transaction completion; version payloads are immutable
snapshots. Approved versions and append-only review events cannot be altered or
deleted. Restrict access through the existing owner/admin API roles and preserve
these records during restores. See [the governance architecture](../engineering/PRIVACY_GOVERNANCE.md).
