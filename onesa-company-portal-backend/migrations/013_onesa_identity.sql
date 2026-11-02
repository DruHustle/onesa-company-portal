-- Shared identity is opt-in. Existing credentials, approvals and product data remain intact.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('owner','administrator','editor','business','hr','viewer','member'));
CREATE TABLE identity_profiles (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 email_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Legacy registrations are not linked by immutable user ID. Existing accounts
-- verify their email once without replacing credentials or existing approvals.
CREATE TABLE identity_sessions (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf text NOT NULL,
 authenticated_at timestamptz NOT NULL,
 amr text[] NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX identity_sessions_user ON identity_sessions(user_id);
CREATE TABLE identity_records (
 model text NOT NULL, id text NOT NULL, encrypted_payload text NOT NULL,
 uid text, grant_id text, account_id text, expires_at timestamptz NOT NULL, consumed_at bigint,
 PRIMARY KEY(model,id)
);
CREATE INDEX identity_records_uid ON identity_records(model,uid) WHERE uid IS NOT NULL;
CREATE INDEX identity_records_grant ON identity_records(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX identity_records_account ON identity_records(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX identity_records_expiry ON identity_records(expires_at);
CREATE TABLE identity_product_access (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product text NOT NULL CHECK(product IN ('ai','drone','robot')),
 role text NOT NULL CHECK(role IN ('user','viewer','operator','admin')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked','rejected')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,product),
 CHECK((product='ai' AND role IN ('user','admin')) OR (product IN ('drone','robot') AND role IN ('viewer','operator','admin')))
);
CREATE TABLE identity_drone_memberships (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('viewer','operator','admin')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 PRIMARY KEY(user_id,tenant_id)
);
CREATE TABLE identity_registration_links (
 token_hash text PRIMARY KEY,
 email text NOT NULL CHECK(email=lower(email)),
 display_name text NOT NULL,
 products jsonb NOT NULL,
 existing_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE INDEX identity_registration_expiry ON identity_registration_links(expires_at);
-- Credential, MFA, role and disable changes revoke every shared session atomically,
-- including changes through the existing administration and recovery routes.
CREATE FUNCTION revoke_onesa_identity_on_account_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.mfa_secret IS DISTINCT FROM NEW.mfa_secret OR OLD.disabled IS DISTINCT FROM NEW.disabled
    OR OLD.role IS DISTINCT FROM NEW.role THEN
  DELETE FROM identity_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_records WHERE account_id=OLD.id::text;
 END IF;
 RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER revoke_onesa_identity AFTER UPDATE OF password_hash,mfa_secret,disabled,role OR DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION revoke_onesa_identity_on_account_change();
REVOKE ALL ON identity_profiles,identity_sessions,identity_records,identity_product_access,identity_drone_memberships,identity_registration_links FROM PUBLIC;
