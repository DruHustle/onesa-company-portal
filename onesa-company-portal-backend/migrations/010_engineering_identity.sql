-- Separate documentation identities. No administrative role, existing account or Access policy is changed.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE engineering_memberships (
 id uuid PRIMARY KEY,
 email text UNIQUE NOT NULL CHECK(email=lower(email)),
 enabled boolean NOT NULL DEFAULT false,
 access_policy_evidence text NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE engineering_identity_records (
 model text NOT NULL,
 id text NOT NULL,
 encrypted_payload text NOT NULL,
 uid text,
 grant_id text,
 account_id text,
 expires_at timestamptz NOT NULL,
 consumed_at bigint,
 PRIMARY KEY(model,id)
);
CREATE INDEX engineering_identity_uid ON engineering_identity_records(model,uid) WHERE uid IS NOT NULL;
CREATE INDEX engineering_identity_grant ON engineering_identity_records(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX engineering_identity_expiry ON engineering_identity_records(expires_at);
CREATE TABLE engineering_email_challenges (
 interaction_uid text PRIMARY KEY,
 membership_id uuid REFERENCES engineering_memberships(id) ON DELETE CASCADE,
 code_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON engineering_memberships,engineering_identity_records,engineering_email_challenges FROM PUBLIC;
