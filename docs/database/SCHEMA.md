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

## Registration, approval and sign-in links

Additive migration 011 adds `access_registrations`, `access_links` and
`engineering_credentials`. Registration stores no password until email verification;
pending password hashes are cleared after approval/rejection. Only hashed, expiring
single-use link tokens are stored. Mail jobs retain their encrypted payloads under the
existing mail lifecycle. Approval never overwrites existing credentials or grants an
owner role. Engineering credentials belong only to the documentation membership.
The restricted application role requires CRUD on these tables; no sequence or public
privilege is introduced. Restore lockdown removes every restored sign-in/registration
link while preserving approval evidence and inert password hashes. This source change
is not a claim that migration 011 or the new login options are deployed.

The existing `jobs.payload` also carries an optional, nonsecret `mailPresentation`
version. The worker locks the job and records `branded-v1` atomically on its first
claim, before delivery. Previously attempted unversioned jobs retain `plain-v0`;
retries retain their selected version and existing provider idempotency key.
Encrypted message text remains encrypted in the outbox. No column or migration is
added. Keep a deployed renderer version immutable; future designs need a new version.
An ambiguous delivery must be reconciled, never rekeyed or reset to obtain a new
design. A worker rollback must account for pending versioned deliveries through the
protected release procedure; an older renderer cannot safely rewrite those requests.

Automatic mail retries stop 23 hours after `jobs.created_at`. Creation is a
conservative lower bound on the first possible attempt, including legacy jobs;
the schema needs no new column. Previously attempted pending jobs outside that
window, or with a future creation time, become failed without changing their
identity, payload or attempt count. Provider reconciliation is required before any
further action. Never-attempted queued mail can still receive its first attempt.
This bounds restart recovery before Resend's 24-hour idempotency expiry; SMTP
acceptance and Message-ID alone do not guarantee exactly-once inbox delivery.

## Editorial publication snapshots (prepared migration 012)

Additive migration 012 backfills each existing published row into `published_snapshot`
without altering its public fields, revision or schedule. `published_content` provides
its typed public edition independently from the working draft. A partial unique index
protects published kind/locale/slug routes. Draft-only rows remain unpublished.

Run the ordinary checksum-verified migration and grant the existing restricted API/worker
role SELECT on the new view through `provisionApplicationRole`; preserve its password.
The readiness check requires the view permission. The new API and scheduled publisher
must be released together so scheduled replacements capture their approved snapshot.
Retain this additive schema during application rollback and use the preserved qualified
component/data recovery procedure; do not drop snapshots or rewrite revisions.
This describes source behavior, not a claim that migration 012 is already deployed.

Rollback compatibility: older APIs read the working row rather than its publication
snapshot. Once replacement drafts have been saved, rolling back to such a writer can
hide the still-approved edition or expose the wrong working state. Do not restore
rows, drop the new column or restart that older writer as an automatic rollback.
Keep the compatible backend when reverting a frontend; a backend recovery needs a
reviewed compatible candidate and the established preservation/restore controls.

Isolated restore quarantine clears both scheduled publication and published snapshots,
including backups predating migration 012. This extends the existing disposable-target
lockdown; it grants no live-restore, erasure, credential or production-data authority.
