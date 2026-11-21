-- Preserve the verified requester through asynchronous Docs owner approval.
-- A deleted account leaves its request bound to a retired identity.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE engineering_enrollment_accounts (
 registration_id uuid PRIMARY KEY REFERENCES access_registrations(id) ON DELETE CASCADE,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
REVOKE ALL ON engineering_enrollment_accounts FROM PUBLIC;
