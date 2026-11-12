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

The existing `jobs.payload` carries a `mailPresentation` version and an encrypted
`mailAttempt` custody envelope. Before the first external submission, one locked
transaction renders the complete request and commits its exact bytes, message/job
identity, recipient/input digest, provider and sending-configuration fingerprint,
and first-attempt timestamp. Resend JSON and SMTP MIME (including Date, boundaries
and inline attachments) are compiled once. Credentials are not stored; their
fingerprint stays inside the encrypted envelope under the existing encryption key.
No column, migration or additional database privilege is added. Queue diagnostics
continue to exclude payloads and recipients.

Resend retries require the same input and effective sender/provider/credential
binding and replay the saved bytes with the original job idempotency key. Changed
configuration, invalid custody and legacy attempted jobs without custody become
`failed` for reconciliation, preserving their payload and attempt count. A legacy
never-attempted job may receive its first frozen request. SMTP has no provider
idempotency guarantee: a committed SMTP attempt is held for reconciliation rather
than automatically replayed after an ambiguous outcome. Message-ID alone does not
prove deduplication. No transport requirement is weakened.

Automatic Resend retries retain the conservative 23-hour bound from job creation
and additionally enforce the saved first-attempt time. Future timestamps fail
closed. Existing cooldowns, five-attempt limit, row locks and acceptance-status
semantics remain; provider acceptance is not inbox delivery.

Rollout and rollback require quiescing the old worker and reconciling all attempted
legacy messages before enabling the new worker. Do not run old and new workers
concurrently: old workers do not enforce custody. Existing API producers remain
compatible. Keep the custody-aware worker during an API/frontend rollback; an older
worker must not resume versioned attempts. Preserve encrypted envelopes and their
key in private backups; never reset attempts, rekey messages or reconstruct proof
from current configuration. This is source behavior, not a deployment claim.

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

## Shared Onesa identity (prepared migrations 013 and 014)

Migration 013 preserves the existing `users.id`, password and MFA fields and adds
the nonadministrative `member` role. `identity_profiles` stores verified identity
and display name. It never infers verification from unrelated historical email
records. `identity_product_access` holds explicit status, role and revision for
AI, Drone and Robot; `identity_drone_memberships` identifies existing workspaces
with narrower roles. No product data is moved into the identity database.

`identity_sessions`, encrypted `identity_records` and hashed one-use
`identity_registration_links` hold expiring capabilities. Migration 014 adds
`identity_grant_sessions`, which binds a provider grant to an specific source
session, actual authentication time, factors and expiry. Source-session rechecks
run under the same account lock as global revocation and password changes.
Credential/MFA/disable/global-role changes revoke central capabilities atomically
through the database trigger. The existing worker cleans expired capabilities;
account and access approval evidence remain.

The existing provisioning path grants restricted CRUD on these seven new tables;
no new service, sequence, public privilege or credential rotation is required.
Readiness validates migration checksums and actual privileges. Keep additive schema
when reverting application code. Older images cannot safely serialize new member
roles even when they can read the schema. Use the qualified candidate image with
shared identity disabled as the fallback; verify it against restored data containing
a member before using it. Do not remove new identities or rewrite existing passwords.
Isolated restore quarantine clears all shared sessions, grants and verification
links, including optional migration 014 artifacts, while preserving account and
approval records. Activation still requires the existing restore/release controls.

The dedicated shared-identity release adapter serializes the reviewed 012, 014 or
published Mobile 015 transition to 016
transition with the same migration advisory lock. It refuses partial or unknown
schema histories and compares all applied checksums before writing. The pending
additive migrations and restricted grants commit together; a completed 016 database is
idempotent. Existing account IDs, email addresses, credential fields, MFA, role,
disablement and all Engineering membership, credential and registration records
are compared under transaction locks. A failed
post-commit runtime-readiness observation is an uncertain release outcome requiring
inspection, never an instruction to replay or reverse the migration. The ordinary
API profile remains unable to apply it. See the
[release adapter tests](../engineering/BUILD_AND_TEST.md#shared-identity-release-adapters).


## Optional Mobile identity vocabulary (prepared migration 015)

`015_mobile_identity.sql` expands only the product and product-specific role
constraints in `identity_product_access`. Mobile permits `customer`, `agent`,
`support`, `operations`, `finance`, `auditor` and `admin`; the role sets for AI,
Drone and Robot remain unchanged. No rows, credentials, client configurations,
access approvals or workspace memberships are created or changed by this migration.
A Mobile client remains unavailable unless explicitly provisioned in issuer config.

The migration is transactional with bounded lock/statement timeouts. Keep this
additive schema if reverting application code; do not drop approved Mobile access
records to satisfy an older image. The prepared shared-identity profile pins these
published 015 bytes before Engineering migration 016; it refuses an earlier
unshipped `015_engineering_account_links.sql` history instead of renaming or
adopting it. Qualify the complete Portal release/migration path and fallback before
deployment. Local generated contracts and isolated tests
are source verification, not evidence of a live migration or client registration.

## Prepared Engineering account links (migration 016)

`identity_engineering_links` stores one immutable central user ID for one existing
Engineering membership ID. The migration creates no links or users and changes no
password, MFA, approval or product entitlement. Link creation requires an explicit
user choice, a live verified central session and the existing Docs password or
one-use approved mailbox proof in one transaction. A conflicting identity cannot
replace the recorded link, including after an email-address change. Hard deletion
of a linked central user is restricted so it cannot silently restore independent
Docs authentication; ordinary disablement preserves the membership and link. Any
future deliberate account erasure must coordinate the linked identities explicitly,
without automatic unlinking or credential fallback. Protocol records retain their
server creation time so a forced fresh request can compare it with the actual
central authentication time on the same database clock, including within one second.

Linked Engineering grants reuse `identity_grant_sessions` and remain subordinate
to the exact central source session. The encrypted Engineering adapter rejects
late records after source revocation, including writes completing after logout.
Credential/MFA/role/disable changes and central global logout remove linked issuer
artifacts. Existing Docs passwords stay stored without replacement but cannot
independently authenticate a linked identity. Exact membership and Cloudflare Access
authorization remain separate; existing Access cookies are not revoked by deleting
issuer records. Restore quarantine retains link and approval evidence while clearing
the existing capability tables. Keep additive schema during rollback, and do not
use feature disablement as permission to reactivate separate linked credentials.

## Company billing bridge data boundary (prepared)

The Portal billing bridge adds no Portal migration or payment ledger. It reuses
the current `users`, identity profiles and account/native session custody through
`requireAccount`, `lockAccountSession` and `identityAccount`. Before issuing each
short-lived billing assertion, the transaction rechecks the same immutable user,
session expiry and verified email under the existing locks. Revoked, disabled or
unverified identities cannot acquire a billing assertion. The matching prepared
Portal identity schema is a prerequisite even when the shared-identity issuer is
disabled; enabling the bridge does not apply migrations or provision memberships.

Company billing accounts, explicit owner/payer/viewer memberships, Stripe customer
bindings, immutable commercial intents, operation journals, webhook reconciliation
and Metronome usage outboxes belong to the independent `onesa-billing` database.
That service has its own migration and separate API, webhook, meter and dispatcher
runtime grants. The Portal process neither receives those database credentials
nor shares its application role with billing. Portal, Docs and product permissions
are not copied into billing membership, and no account is granted a billing role
merely because its Portal role is administrative.

Billing history and original request identities must remain available across
uncertain provider outcomes. Disabling the bridge changes access to the Portal
entry point; it does not cancel charges, delete financial records, revoke other
provider sessions or undo the independent service's data. Qualification and
recovery must preserve both services' original identity and operation records.
This source boundary supplies no live migration, restore or payment acceptance.

Migration 017 adds the Farmer product and its ordinary `user` role to the existing
product-access constraints. It changes no identity, membership or approval rows.

### Migration 018: ordinary customer product grants

`018_customer_product_identity.sql` extends the product/role check constraints
for Logistics `user`, PasoFi `customer`, and Factory `user`. It changes no existing
accounts, grants, approvals or memberships. Apply through the normal bounded
transactional migrator after migration 017; the exact new source requires isolated
qualification and a compatible release profile. Product databases remain independent.

For a disposable local copy restored at schema 016, 017 or 018, set
`TEST_DATABASE_URL` to its loopback PostgreSQL URL (database name ending in
`_test`) and run `npm run rehearse:customer-identity` from the backend. It checks
the actual loopback TCP peer (including a loopback-published Docker port) and the
exact reviewed migration inventory, runs the application migration plan, verifies
existing product grants and the eight ordinary product roles, repeats the plan for
idempotency, and rolls back the whole rehearsal. Output gives counts and the original
schema version. A production upgrade still requires a separately commissioned release
profile, restore/rollback evidence and hosted identity acceptance.
