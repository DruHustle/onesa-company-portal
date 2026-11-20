-- Registration is separate from authorization; no existing account or approval is changed.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE access_registrations (
 id uuid PRIMARY KEY,
 email text NOT NULL CHECK(email=lower(email)),
 audience text NOT NULL CHECK(audience IN ('admin','engineering')),
 display_name text NOT NULL,
 password_hash text,
 state text NOT NULL DEFAULT 'unverified' CHECK(state IN ('unverified','pending','approved','rejected')),
 email_verified_at timestamptz,
 reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 review_note text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(email,audience)
);
CREATE TABLE access_links (
 token_hash text PRIMARY KEY,
 purpose text NOT NULL CHECK(purpose IN ('registration','admin','engineering')),
 registration_id uuid REFERENCES access_registrations(id) ON DELETE CASCADE,
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 membership_id uuid REFERENCES engineering_memberships(id) ON DELETE CASCADE,
 interaction_uid text,
 identity_hash text,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((purpose='registration' AND registration_id IS NOT NULL AND user_id IS NULL AND membership_id IS NULL AND interaction_uid IS NULL)
    OR (purpose='admin' AND user_id IS NOT NULL AND registration_id IS NULL AND membership_id IS NULL AND interaction_uid IS NULL)
    OR (purpose='engineering' AND membership_id IS NOT NULL AND interaction_uid IS NOT NULL AND registration_id IS NULL AND user_id IS NULL))
);
CREATE INDEX access_links_expiry ON access_links(expires_at);
CREATE TABLE engineering_credentials (
 membership_id uuid PRIMARY KEY REFERENCES engineering_memberships(id) ON DELETE CASCADE,
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON access_registrations,access_links,engineering_credentials FROM PUBLIC;
