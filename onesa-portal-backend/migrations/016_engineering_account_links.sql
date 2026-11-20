-- Link only after proof of both an existing central account and approved Docs identity.
-- No identity, password, approval, product grant or link is inferred or backfilled.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
-- Server time retains subsecond freshness; OIDC integer iat alone is insufficient.
ALTER TABLE engineering_identity_records ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE identity_engineering_links (
 membership_id uuid PRIMARY KEY REFERENCES engineering_memberships(id) ON DELETE CASCADE,
 user_id uuid UNIQUE NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 linked_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON identity_engineering_links FROM PUBLIC;
CREATE FUNCTION preserve_engineering_account_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.membership_id IS DISTINCT FROM NEW.membership_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  RAISE EXCEPTION 'Engineering account links cannot be reassigned';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engineering_account_link_immutable BEFORE UPDATE ON identity_engineering_links
 FOR EACH ROW EXECUTE FUNCTION preserve_engineering_account_link();
CREATE OR REPLACE FUNCTION revoke_onesa_identity_on_account_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.password_hash IS NOT DISTINCT FROM NEW.password_hash
     AND OLD.mfa_secret IS NOT DISTINCT FROM NEW.mfa_secret AND OLD.disabled IS NOT DISTINCT FROM NEW.disabled
     AND OLD.role IS NOT DISTINCT FROM NEW.role THEN RETURN NEW; END IF;
 END IF;
  DELETE FROM engineering_identity_records WHERE account_id IN
   (SELECT membership_id::text FROM identity_engineering_links WHERE user_id=OLD.id);
  DELETE FROM identity_grant_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_sessions WHERE user_id=OLD.id;
  DELETE FROM identity_records WHERE account_id=OLD.id::text;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
