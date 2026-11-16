SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
-- Keep existing sessions and foreign keys. Managed sessions cannot outlive their verified API grant.
ALTER TABLE sessions ADD COLUMN managed_expires_at timestamptz,
  ADD COLUMN managed_role text,
  ADD CONSTRAINT managed_portal_session_bounds CHECK (
    (managed_expires_at IS NULL AND managed_role IS NULL) OR
    (managed_expires_at IS NOT NULL AND managed_role IS NOT NULL AND expires_at <= managed_expires_at)
  );
CREATE TABLE portal_login_transactions (
  browser_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  encrypted_verifier text NOT NULL,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX portal_login_transactions_expiry ON portal_login_transactions(expires_at);
REVOKE ALL ON portal_login_transactions FROM PUBLIC;
