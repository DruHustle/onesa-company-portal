-- An OIDC grant remains subordinate to the exact browser session that approved it.
-- This prevents an in-flight callback from reviving access after global sign-out.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE identity_grant_sessions (
 grant_id text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_token_hash text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('account','portal')),
 authenticated_at timestamptz NOT NULL,
 amr text[] NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX identity_grant_sessions_user ON identity_grant_sessions(user_id);
CREATE INDEX identity_grant_sessions_source ON identity_grant_sessions(source_token_hash);
REVOKE ALL ON identity_grant_sessions FROM PUBLIC;
CREATE OR REPLACE FUNCTION revoke_onesa_identity_on_account_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM identity_grant_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_records WHERE account_id=OLD.id::text;
  RETURN OLD;
 END IF;
 IF OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.mfa_secret IS DISTINCT FROM NEW.mfa_secret OR OLD.disabled IS DISTINCT FROM NEW.disabled
    OR OLD.role IS DISTINCT FROM NEW.role THEN
  DELETE FROM identity_grant_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_records WHERE account_id=OLD.id::text;
 END IF;
 RETURN NEW;
END $$;
