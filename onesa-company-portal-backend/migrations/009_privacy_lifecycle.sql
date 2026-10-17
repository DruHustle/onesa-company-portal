-- Additive control plane only. No policy approval, business-data deletion or timer.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

ALTER TABLE enquiries ADD COLUMN closed_at timestamptz;
ALTER TABLE applications ADD COLUMN rejected_at timestamptz;
ALTER TABLE files ADD COLUMN purpose_end_at timestamptz;
CREATE INDEX privacy_closed_enquiries ON enquiries(closed_at,id) WHERE status='closed';
CREATE INDEX privacy_rejected_applications ON applications(rejected_at,id) WHERE status='rejected';
CREATE INDEX privacy_ended_files ON files(purpose_end_at,id) WHERE purpose_end_at IS NOT NULL;

-- Do not invent historical outcome dates for existing closed/rejected records.
CREATE FUNCTION privacy_track_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='enquiries' AND NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.closed_at=CASE WHEN NEW.status='closed' THEN now() ELSE NULL END;
 ELSIF TG_TABLE_NAME='applications' AND NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.rejected_at=CASE WHEN NEW.status='rejected' THEN now() ELSE NULL END;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_enquiry_outcome BEFORE UPDATE OF status ON enquiries FOR EACH ROW EXECUTE FUNCTION privacy_track_outcome();
CREATE TRIGGER privacy_application_outcome BEFORE UPDATE OF status ON applications FOR EACH ROW EXECUTE FUNCTION privacy_track_outcome();

CREATE TABLE privacy_holds (
 id uuid PRIMARY KEY,
 target_kind text NOT NULL CHECK(target_kind IN ('enquiry','application','file')),
 target_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
 evidence_refs text[] NOT NULL CHECK(cardinality(evidence_refs) BETWEEN 1 AND 20),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 released_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 released_at timestamptz,
 release_reason text,
 version integer NOT NULL DEFAULT 1 CHECK(version IN (1,2)),
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 CHECK((released_at IS NULL AND released_by IS NULL AND release_reason IS NULL AND version=1)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL AND length(release_reason)>=10 AND version=2))
);
CREATE INDEX privacy_active_holds ON privacy_holds(target_kind,target_id) WHERE released_at IS NULL;

CREATE TABLE privacy_lifecycle_requests (
 id uuid PRIMARY KEY,
 request_kind text NOT NULL CHECK(request_kind IN ('erasure','retention')),
 case_reference text NOT NULL CHECK(length(case_reference) BETWEEN 1 AND 2000),
 identity_evidence_refs text[] NOT NULL CHECK(cardinality(identity_evidence_refs) BETWEEN 1 AND 20),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','cancelled','executing','storage_pending','completed','partial')),
 policy_id text,
 policy_revision integer,
 plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
 reviewed_at timestamptz,
 cancelled_at timestamptz,
 completed_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(policy_id,policy_revision) REFERENCES governance_versions(record_id,revision) ON DELETE RESTRICT,
 CHECK((request_kind='erasure' AND policy_id IS NULL AND policy_revision IS NULL)
    OR (request_kind='retention' AND policy_id IS NOT NULL AND policy_revision IS NOT NULL))
);
CREATE INDEX privacy_requests_created ON privacy_lifecycle_requests(created_at DESC,id);
CREATE TABLE privacy_lifecycle_targets (
 request_id uuid NOT NULL REFERENCES privacy_lifecycle_requests(id) ON DELETE RESTRICT,
 target_kind text NOT NULL CHECK(target_kind IN ('enquiry','application','file')),
 target_id uuid NOT NULL,
 record_sha256 text CHECK(record_sha256 ~ '^[a-f0-9]{64}$'),
 result text NOT NULL CHECK(result IN ('planned','held','not_due','not_found','deleted','storage_pending','failed','skipped')),
 result_code text NOT NULL,
 storage_key text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,target_kind,target_id)
);
CREATE TABLE privacy_lifecycle_events (
 id bigserial PRIMARY KEY,
 lifecycle_request_id uuid REFERENCES privacy_lifecycle_requests(id) ON DELETE RESTRICT,
 hold_id uuid REFERENCES privacy_holds(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL,
 note text NOT NULL DEFAULT '',
 evidence_refs text[] NOT NULL DEFAULT '{}',
 http_request_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(lifecycle_request_id IS NOT NULL OR hold_id IS NOT NULL)
);
CREATE INDEX privacy_events_request ON privacy_lifecycle_events(lifecycle_request_id,id);
CREATE INDEX privacy_events_hold ON privacy_lifecycle_events(hold_id,id);
CREATE TRIGGER privacy_events_immutable BEFORE UPDATE OR DELETE ON privacy_lifecycle_events FOR EACH ROW EXECUTE FUNCTION protect_governance_event();

CREATE FUNCTION privacy_protect_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Privacy hold history must be preserved' USING ERRCODE='23514'; END IF;
 IF OLD.released_at IS NOT NULL OR
  (to_jsonb(NEW)-ARRAY['released_by','released_at','release_reason','version']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['released_by','released_at','release_reason','version']) THEN
  RAISE EXCEPTION 'Only explicit release of an active privacy hold is permitted' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_hold_history BEFORE UPDATE OR DELETE ON privacy_holds FOR EACH ROW EXECUTE FUNCTION privacy_protect_hold();

CREATE FUNCTION privacy_prevent_held_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text := TG_ARGV[0];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||target||':'||OLD.id::text,0));
 IF EXISTS(SELECT 1 FROM privacy_holds WHERE target_kind=target AND target_id=OLD.id AND released_at IS NULL) THEN
  RAISE EXCEPTION 'An active privacy hold prevents deletion' USING ERRCODE='23514',CONSTRAINT='privacy_active_hold';
 END IF;
 IF target='application' THEN
  IF EXISTS(SELECT 1 FROM privacy_holds WHERE target_kind='file' AND target_id=OLD.file_id AND released_at IS NULL) THEN
   RAISE EXCEPTION 'An associated file has an active privacy hold' USING ERRCODE='23514',CONSTRAINT='privacy_active_hold';
  END IF;
 END IF;
 IF target='file' AND EXISTS(SELECT 1 FROM privacy_holds h JOIN applications a ON a.id=h.target_id WHERE h.target_kind='application' AND a.file_id=OLD.id AND h.released_at IS NULL) THEN
  RAISE EXCEPTION 'The application has an active privacy hold' USING ERRCODE='23514',CONSTRAINT='privacy_active_hold';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER privacy_enquiry_hold BEFORE DELETE ON enquiries FOR EACH ROW EXECUTE FUNCTION privacy_prevent_held_delete('enquiry');
CREATE TRIGGER privacy_application_hold BEFORE DELETE ON applications FOR EACH ROW EXECUTE FUNCTION privacy_prevent_held_delete('application');
CREATE TRIGGER privacy_file_hold BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION privacy_prevent_held_delete('file');
REVOKE ALL ON privacy_holds,privacy_lifecycle_requests,privacy_lifecycle_targets,privacy_lifecycle_events FROM PUBLIC;

-- Append-only identities, not copies of erased personal data. No deletion is executed here.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE privacy_erasure_journal (
 id bigserial PRIMARY KEY,
 target_kind text NOT NULL CHECK(target_kind IN ('enquiry','application','file')),
 target_id uuid NOT NULL,
 erased_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX privacy_erasure_journal_time ON privacy_erasure_journal(erased_at,id);
CREATE TRIGGER privacy_erasure_journal_immutable BEFORE UPDATE OR DELETE ON privacy_erasure_journal FOR EACH ROW EXECUTE FUNCTION protect_governance_event();
CREATE FUNCTION privacy_record_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO privacy_erasure_journal(target_kind,target_id) VALUES(TG_ARGV[0],OLD.id);
 RETURN OLD;
END $$;
CREATE TRIGGER privacy_record_enquiry_erasure AFTER DELETE ON enquiries FOR EACH ROW EXECUTE FUNCTION privacy_record_erasure('enquiry');
CREATE TRIGGER privacy_record_application_erasure AFTER DELETE ON applications FOR EACH ROW EXECUTE FUNCTION privacy_record_erasure('application');
CREATE TRIGGER privacy_record_file_erasure AFTER DELETE ON files FOR EACH ROW EXECUTE FUNCTION privacy_record_erasure('file');
REVOKE ALL ON privacy_erasure_journal FROM PUBLIC;

-- Preserve reviewed plan identities and monotonic request history at the SQL boundary.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION privacy_protect_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Lifecycle request history must be preserved' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','reviewed_by','reviewed_at','cancelled_at','completed_at','version']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','reviewed_by','reviewed_at','cancelled_at','completed_at','version']) THEN
  RAISE EXCEPTION 'Lifecycle plan identity is immutable' USING ERRCODE='23514';
 END IF;
 IF (
  (OLD.state='planned' AND NEW.state='executing' AND NEW.version=OLD.version AND NEW.reviewed_by IS NOT NULL AND NEW.reviewed_at IS NOT NULL AND NEW.cancelled_at IS NULL AND NEW.completed_at IS NULL) OR
  (OLD.state='planned' AND NEW.state='cancelled' AND NEW.version=OLD.version+1 AND NEW.cancelled_at IS NOT NULL AND NEW.reviewed_by IS NULL AND NEW.reviewed_at IS NULL AND NEW.completed_at IS NULL) OR
  (OLD.state='executing' AND NEW.state IN ('partial','storage_pending') AND NEW.version=OLD.version+1 AND NEW.reviewed_by=OLD.reviewed_by AND NEW.reviewed_at=OLD.reviewed_at AND NEW.cancelled_at IS NULL AND NEW.completed_at IS NULL) OR
  (OLD.state IN ('partial','storage_pending') AND NEW.state='completed' AND NEW.version=OLD.version+1 AND NEW.completed_at IS NOT NULL AND NEW.reviewed_by=OLD.reviewed_by AND NEW.reviewed_at=OLD.reviewed_at AND NEW.cancelled_at IS NULL)
 ) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_integrity BEFORE UPDATE OR DELETE ON privacy_lifecycle_requests FOR EACH ROW EXECUTE FUNCTION privacy_protect_request();
CREATE FUNCTION privacy_protect_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Lifecycle target history must be preserved' USING ERRCODE='23514'; END IF;
 IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.record_sha256 IS DISTINCT FROM OLD.record_sha256 THEN
  RAISE EXCEPTION 'Lifecycle target identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_target_integrity BEFORE UPDATE OR DELETE ON privacy_lifecycle_targets FOR EACH ROW EXECUTE FUNCTION privacy_protect_target();
