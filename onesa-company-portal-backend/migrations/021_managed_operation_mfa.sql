SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE sessions ADD COLUMN managed_subject text, ADD COLUMN managed_issuer text;
CREATE TABLE portal_operation_challenges (
  challenge_hash text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  operation_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  verified_at timestamptz
);
CREATE INDEX portal_operation_session ON portal_operation_challenges(session_hash);
CREATE INDEX portal_operation_expiry ON portal_operation_challenges(expires_at);
ALTER TABLE portal_login_transactions ADD COLUMN operation_challenge text
  REFERENCES portal_operation_challenges(challenge_hash) ON DELETE CASCADE;
REVOKE ALL ON portal_operation_challenges FROM PUBLIC;
