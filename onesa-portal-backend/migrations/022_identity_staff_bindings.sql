SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

ALTER TABLE users ADD COLUMN managed_staff_issuer text, ADD COLUMN managed_staff_subject text,
  ADD CONSTRAINT managed_staff_credentials CHECK (
    (managed_staff_issuer IS NULL AND managed_staff_subject IS NULL)
    OR (managed_staff_issuer IS NOT NULL AND managed_staff_subject IS NOT NULL
        AND password_hash = '!managed:' AND mfa_secret IS NULL AND mfa_pending IS NULL)
  );
CREATE UNIQUE INDEX users_managed_subject ON users(managed_staff_issuer, managed_staff_subject)
  WHERE managed_staff_issuer IS NOT NULL;

-- A rollback to a Portal password or email-link handler must still respect
-- ownership of accounts created exclusively through the Identity service.
CREATE FUNCTION enforce_managed_staff_session() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE binding record;
BEGIN
  SELECT managed_staff_issuer AS issuer, managed_staff_subject AS subject
    INTO binding FROM public.users WHERE id=NEW.user_id;
  IF binding.issuer IS NOT NULL THEN
    IF TG_TABLE_NAME = 'identity_sessions' THEN
      RAISE check_violation USING MESSAGE = 'Managed staff must use Onesa Identity';
    END IF;
    IF NEW.managed_issuer IS DISTINCT FROM binding.issuer
       OR NEW.managed_subject IS DISTINCT FROM binding.subject
       OR NEW.managed_expires_at IS NULL THEN
      RAISE check_violation USING MESSAGE = 'Managed staff require a matching managed session';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_managed_staff_session BEFORE INSERT OR UPDATE OF user_id,managed_issuer,managed_subject,managed_expires_at
  ON sessions FOR EACH ROW EXECUTE FUNCTION enforce_managed_staff_session();
CREATE TRIGGER reject_legacy_managed_staff_session BEFORE INSERT OR UPDATE OF user_id
  ON identity_sessions FOR EACH ROW EXECUTE FUNCTION enforce_managed_staff_session();
