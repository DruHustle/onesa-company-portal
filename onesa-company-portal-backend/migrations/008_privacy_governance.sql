-- Additive internal CMS extension. No public content, retention settings or jobs change.
CREATE TABLE governance_records (
 stable_id text PRIMARY KEY CHECK(stable_id ~ '^(ONESA-PRIV-(RET|PROC|DEC)-001|(RET|PROC|DEC)-[0-9]{2})$'),
 kind text NOT NULL CHECK(kind IN ('document','retention','processor','decision')),
 document_id text REFERENCES governance_records(stable_id) ON DELETE RESTRICT,
 classification text NOT NULL DEFAULT 'INTERNAL' CHECK(classification='INTERNAL'),
 current_revision integer NOT NULL CHECK(current_revision>0),
 effective_revision integer,
 archived boolean NOT NULL DEFAULT false,
 seed_fingerprint text CHECK(seed_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='document' AND document_id IS NULL) OR (kind<>'document' AND document_id IS NOT NULL))
);
CREATE TABLE governance_versions (
 record_id text NOT NULL REFERENCES governance_records(stable_id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 version_label text NOT NULL,
 title text NOT NULL,
 owner text NOT NULL,
 product_scopes text[] NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 evidence_refs text[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft_pending_review' CHECK(status IN ('draft','draft_pending_review','pending_review','approved','needs_changes','rejected')),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 source_file text,
 created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 review_due_at timestamptz,
 effective_at timestamptz,
 approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 approved_email text,
 approved_role text CHECK(approved_role IS NULL OR approved_role='owner'),
 approved_at timestamptz,
 approval_scope text,
 approval_evidence_refs text[],
 PRIMARY KEY(record_id,revision),
 CHECK(status<>'approved' OR (approved_by IS NOT NULL AND approved_email IS NOT NULL AND approved_role IS NOT NULL AND approved_role='owner' AND approved_at IS NOT NULL AND effective_at IS NOT NULL AND review_due_at IS NOT NULL AND approval_scope IS NOT NULL AND length(approval_scope)>=10 AND approval_evidence_refs IS NOT NULL AND cardinality(approval_evidence_refs)>0 AND review_due_at>effective_at)),
 CHECK(status='approved' OR (approved_at IS NULL AND approved_by IS NULL AND effective_at IS NULL))
);
ALTER TABLE governance_records ADD CONSTRAINT governance_current_version FOREIGN KEY(stable_id,current_revision) REFERENCES governance_versions(record_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE governance_records ADD CONSTRAINT governance_effective_version FOREIGN KEY(stable_id,effective_revision) REFERENCES governance_versions(record_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE governance_events (
 id bigserial PRIMARY KEY,
 record_id text NOT NULL,
 revision integer NOT NULL,
 actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 actor_email text,
 actor_role text,
 action text NOT NULL,
 note text NOT NULL DEFAULT '',
 scope text NOT NULL DEFAULT '',
 evidence_refs text[] NOT NULL DEFAULT '{}',
 request_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(record_id,revision) REFERENCES governance_versions(record_id,revision) ON DELETE RESTRICT
);
CREATE INDEX governance_kind ON governance_records(kind,archived);
CREATE INDEX governance_reviews ON governance_versions(review_due_at,status);
CREATE INDEX governance_events_record ON governance_events(record_id,id);
CREATE FUNCTION protect_governance_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='approved' THEN
  RAISE EXCEPTION 'Governance versions must be preserved; approved versions are immutable' USING ERRCODE='23514';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','review_due_at','effective_at','approved_by','approved_email','approved_role','approved_at','approval_scope','approval_evidence_refs']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','review_due_at','effective_at','approved_by','approved_email','approved_role','approved_at','approval_scope','approval_evidence_refs']) THEN
  RAISE EXCEPTION 'Amendments require a new governance version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_version_immutable BEFORE UPDATE OR DELETE ON governance_versions FOR EACH ROW EXECUTE FUNCTION protect_governance_version();
CREATE FUNCTION protect_governance_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Governance review events are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER governance_event_immutable BEFORE UPDATE OR DELETE ON governance_events FOR EACH ROW EXECUTE FUNCTION protect_governance_event();
REVOKE ALL ON governance_records,governance_versions,governance_events FROM PUBLIC;
