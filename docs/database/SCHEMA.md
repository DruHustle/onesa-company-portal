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

## Lifecycle control and replay journal

Migration 009 adds explicit outcome timestamps without backfilling history,
`privacy_holds`, `privacy_lifecycle_requests`, `privacy_lifecycle_targets`,
`privacy_lifecycle_events` and `privacy_erasure_journal`. Holds/history/events are
protected by triggers; erasure identities append within the business-delete
transaction. Application/CV holds protect each other. Grant the existing restricted
role access to these new tables/sequences through the existing provisioning path,
without changing its password. Keep additive schema during application rollback.
No TTL timer, imported approval or automatic business deletion is introduced.

## Separate Engineering Docs identities

Prepared additive migration 010 adds `engineering_memberships`, encrypted
`engineering_identity_records` and one-use `engineering_email_challenges`. It seeds
no accounts, changes no existing credentials/roles and grants nothing to PUBLIC.
The existing restricted application role needs only CRUD on these three tables;
there are no new sequences. Identity artifacts expire after their protocol lifetime;
the existing worker removes expired artifacts and challenges. Membership and owner
audit evidence remain until explicitly managed. Existing Access sessions require
separate revocation during offboarding; deleting a Portal challenge cannot revoke
an already-issued Access session. No migration or provider configuration is claimed
live by this source description.
