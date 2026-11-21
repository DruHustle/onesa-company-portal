-- Metadata deletion and durable cleanup request commit together; physical deletion follows.
CREATE TABLE storage_deletions (
 storage_key text PRIMARY KEY CHECK(storage_key ~ '^[a-f0-9-]{36}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','accepted','failed')),
 attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_deletions_pending ON storage_deletions(status,run_at);
