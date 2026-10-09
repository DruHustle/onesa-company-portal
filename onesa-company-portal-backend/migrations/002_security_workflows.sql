ALTER TABLE users ADD COLUMN mfa_pending text, ADD COLUMN enroll_hash text, ADD COLUMN enroll_expires timestamptz;
CREATE TABLE mfa_recovery (user_id uuid REFERENCES users(id) ON DELETE CASCADE, code_hash text NOT NULL, PRIMARY KEY(user_id,code_hash));
ALTER TABLE files ADD COLUMN parent_id uuid REFERENCES files(id), ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE templates ADD CONSTRAINT templates_status CHECK(status IN ('draft','approved','archived'));
INSERT INTO settings VALUES ('brand','{"approved":false}');
