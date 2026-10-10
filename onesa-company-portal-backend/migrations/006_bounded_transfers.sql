-- Additive durable transport; existing 10 MiB file and private/quarantine controls remain.
CREATE TABLE bounded_transfers (
 id uuid PRIMARY KEY,
 owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
 peer_hash text NOT NULL,
 capability_hash text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('application','document')),
 expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1 AND 15728640),
 checksum text NOT NULL,
 cursor integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '20 minutes',
 result jsonb,
 result_status integer
);
CREATE INDEX bounded_transfers_expiry ON bounded_transfers(expires_at);
CREATE TABLE bounded_transfer_chunks (
 transfer_id uuid REFERENCES bounded_transfers(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence>=0),
 encrypted_payload text NOT NULL,
 checksum text NOT NULL,
 PRIMARY KEY(transfer_id,sequence)
);
