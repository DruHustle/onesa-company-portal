-- Run only with the dedicated migration connection against the billing database.
-- Runtime logins are provisioned separately and receive exactly one group role.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['onesa_billing_owner','onesa_billing_api',
    'onesa_billing_dispatcher','onesa_billing_webhook','onesa_billing_meter'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Existing billing group role is not the required restricted nonlogin role';
    END IF;
  END LOOP;
END
$roles$;

CREATE SCHEMA billing AUTHORIZATION onesa_billing_owner;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
SET LOCAL ROLE onesa_billing_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE TABLE billing.schema_migrations (
  version text PRIMARY KEY,
  checksum text CHECK(checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing.schema_migrations(version,checksum) VALUES ('001_company_billing',nullif(current_setting('onesa_billing.migration_checksum',true),''));

CREATE TABLE billing.scope_refs (
  ref text PRIMARY KEY CHECK(ref ~ '^[a-f0-9]{64}$'),
  application text NOT NULL CHECK(application='company'),
  stripe_account_id text NOT NULL CHECK(stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  mode text NOT NULL CHECK(mode IN ('test','live')),
  config_version text NOT NULL CHECK(length(config_version) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(application,stripe_account_id,mode,config_version)
);

CREATE TABLE billing.accounts (
  id uuid PRIMARY KEY,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  retention_hold boolean NOT NULL DEFAULT true
);
CREATE TABLE billing.principals (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject)
);
CREATE TABLE billing.memberships (
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES billing.principals(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK(role IN ('owner','payer','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,principal_id)
);
CREATE TABLE billing.account_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES billing.principals(id) ON DELETE RESTRICT,
  affected_principal_id uuid REFERENCES billing.principals(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('account_created','membership_changed','account_closed')),
  revision integer NOT NULL CHECK(revision>0),
  role text CHECK(role IN ('owner','payer','viewer')),
  membership_status text CHECK(membership_status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing.commercial_intents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  kind text NOT NULL CHECK(kind IN ('customer','checkout','invoice','portal')),
  client_key text NOT NULL CHECK(length(client_key) BETWEEN 1 AND 128),
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  catalog_snapshot jsonb NOT NULL CHECK(jsonb_typeof(catalog_snapshot)='array'),
  request_snapshot jsonb NOT NULL CHECK(jsonb_typeof(request_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,id),
  UNIQUE(account_id,kind,client_key)
);

CREATE TABLE billing.operations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  commercial_intent_id uuid NOT NULL,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  kind text NOT NULL CHECK(kind IN ('customer_create','checkout_create','invoice_create','invoice_finalize','portal_create')),
  client_key text NOT NULL CHECK(length(client_key) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  request_snapshot jsonb NOT NULL CHECK(jsonb_typeof(request_snapshot)='object'),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','succeeded','failed','unknown')),
  first_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),
  reason text CHECK(reason IN ('provider_timeout','provider_error','lease_expired','configuration_changed','result_unverified','provider_rejected')),
  provider_object_id text,
  provider_object_type text,
  provider_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(account_id,id),
  UNIQUE(account_id,kind,client_key),
  UNIQUE(account_id,kind,commercial_intent_id),
  FOREIGN KEY(account_id,commercial_intent_id) REFERENCES billing.commercial_intents(account_id,id) ON DELETE RESTRICT,
  CHECK((state='prepared' AND first_attempt_at IS NULL) OR (state<>'prepared' AND first_attempt_at IS NOT NULL)),
  CHECK(state<>'dispatched' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(state<>'succeeded' OR (provider_object_id IS NOT NULL AND provider_object_type IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX operations_dispatch ON billing.operations(created_at,id) WHERE state='prepared';
CREATE TABLE billing.operation_attempts (
  operation_id uuid NOT NULL REFERENCES billing.operations(id) ON DELETE RESTRICT,
  fence integer NOT NULL CHECK(fence>0),
  lease_token uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text CHECK(outcome IN ('succeeded','failed','unknown')),
  reason text,
  PRIMARY KEY(operation_id,fence)
);
CREATE TABLE billing.customer_bindings (
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  customer_id text NOT NULL CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,stripe_account_id,mode),
  UNIQUE(stripe_account_id,mode,customer_id),
  FOREIGN KEY(account_id,operation_id) REFERENCES billing.operations(account_id,id) ON DELETE RESTRICT
);
CREATE TABLE billing.provider_resources (
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  object_type text NOT NULL CHECK(object_type IN ('customer','checkout.session','invoice','billing_portal.session','credit_note','charge')),
  object_id text NOT NULL CHECK(length(object_id) BETWEEN 3 AND 200),
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  provider_state text NOT NULL CHECK(length(provider_state) BETWEEN 1 AND 100),
  amount_minor bigint CHECK(amount_minor>=0),
  currency text CHECK(currency ~ '^[a-z]{3}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(stripe_account_id,mode,object_type,object_id),
  FOREIGN KEY(account_id,operation_id) REFERENCES billing.operations(account_id,id) ON DELETE RESTRICT
);

CREATE TABLE billing.webhook_events (
  id uuid PRIMARY KEY,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  event_id text NOT NULL CHECK(event_id ~ '^evt_[A-Za-z0-9_]+$'),
  event_type text NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
  object_id text NOT NULL CHECK(length(object_id) BETWEEN 3 AND 200),
  object_type text NOT NULL CHECK(object_type IN ('checkout.session','invoice','customer','credit_note','charge')),
  provider_created_at timestamptz NOT NULL,
  body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
  format text NOT NULL CHECK(format IN ('snapshot','thin')),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stripe_account_id,mode,event_id)
);
CREATE TABLE billing.reconciliation_jobs (
  event_row_id uuid PRIMARY KEY REFERENCES billing.webhook_events(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','held')),
  first_attempt_at timestamptz,
  retry_deadline timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 40),
  lease_token uuid,
  lease_until timestamptz,
  fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),
  reason text CHECK(reason IN ('unbound_resource','provider_unavailable','configuration_changed','ownership_mismatch','unsupported_event','lease_expired','retry_deadline_exceeded','attempt_limit_exceeded')),
  completed_at timestamptz,
  CHECK((first_attempt_at IS NULL AND retry_deadline IS NULL AND attempt_count=0)
    OR (first_attempt_at IS NOT NULL AND retry_deadline IS NOT NULL AND retry_deadline=first_attempt_at+interval '24 hours' AND attempt_count>0)),
  CHECK(state<>'leased' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL AND attempt_count>0 AND lease_until<=retry_deadline))
);
CREATE TABLE billing.resource_observations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  event_row_id uuid REFERENCES billing.webhook_events(id) ON DELETE RESTRICT,
  object_type text NOT NULL CHECK(object_type IN ('customer','checkout.session','invoice','billing_portal.session','credit_note','charge')),
  object_id text NOT NULL CHECK(length(object_id) BETWEEN 3 AND 200),
  provider_state text NOT NULL CHECK(length(provider_state) BETWEEN 1 AND 100),
  amount_minor bigint CHECK(amount_minor>=0),
  currency text CHECK(currency ~ '^[a-z]{3}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,operation_id) REFERENCES billing.operations(account_id,id) ON DELETE RESTRICT,
  UNIQUE(event_row_id,operation_id)
);
CREATE TABLE billing.credit_note_observations (
  event_row_id uuid PRIMARY KEY REFERENCES billing.webhook_events(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  parent_operation_id uuid NOT NULL,
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  invoice_id text NOT NULL CHECK(invoice_id ~ '^in_[A-Za-z0-9]+$'),
  credit_note_id text NOT NULL CHECK(credit_note_id ~ '^cn_[A-Za-z0-9]+$'),
  provider_state text NOT NULL CHECK(provider_state IN ('issued','void')),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  currency text NOT NULL CHECK(currency ~ '^[a-z]{3}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,parent_operation_id) REFERENCES billing.operations(account_id,id) ON DELETE RESTRICT
);
CREATE INDEX credit_note_history ON billing.credit_note_observations(stripe_account_id,mode,credit_note_id,observed_at DESC);

CREATE TABLE billing.usage_events (
  id uuid PRIMARY KEY,
  application text NOT NULL DEFAULT 'company' CHECK(application='company'),
  account_id uuid NOT NULL REFERENCES billing.accounts(id) ON DELETE RESTRICT,
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  producer_issuer text NOT NULL CHECK(length(producer_issuer) BETWEEN 1 AND 2048),
  producer_subject text NOT NULL CHECK(length(producer_subject) BETWEEN 1 AND 256),
  source_event_id text NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 200),
  transaction_id text NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 200),
  scope_ref text NOT NULL REFERENCES billing.scope_refs(ref) ON DELETE RESTRICT,
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
  prepared_event jsonb NOT NULL CHECK(jsonb_typeof(prepared_event)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stripe_account_id,mode,producer_issuer,producer_subject,source_event_id),
  UNIQUE(stripe_account_id,mode,transaction_id),
  UNIQUE(account_id,id)
);
CREATE TABLE billing.usage_outbox (
  event_id uuid PRIMARY KEY REFERENCES billing.usage_events(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','accepted','quarantined')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  retry_deadline timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  accepted_at timestamptz,
  reason text,
  CHECK(state<>'leased' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL AND first_attempt_at IS NOT NULL AND retry_deadline IS NOT NULL)),
  CHECK(state<>'accepted' OR accepted_at IS NOT NULL)
);
CREATE INDEX usage_pending ON billing.usage_outbox(next_attempt_at,event_id) WHERE state IN ('pending','leased');
CREATE TABLE billing.usage_attempts (
  event_id uuid NOT NULL REFERENCES billing.usage_events(id) ON DELETE RESTRICT,
  fence integer NOT NULL CHECK(fence>0),
  lease_token uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  outcome text CHECK(outcome IN ('accepted','retry','quarantined','lease_expired')),
  reason text,
  PRIMARY KEY(event_id,fence)
);

-- Frozen requests/identities survive account closure and ordinary runtime access.
CREATE FUNCTION billing.refuse_frozen_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable billing record'; END $$;
CREATE TRIGGER immutable_scope BEFORE UPDATE OR DELETE ON billing.scope_refs FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_intent BEFORE UPDATE OR DELETE ON billing.commercial_intents FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_customer BEFORE UPDATE OR DELETE ON billing.customer_bindings FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON billing.webhook_events FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_usage BEFORE UPDATE OR DELETE ON billing.usage_events FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_observation BEFORE UPDATE OR DELETE ON billing.resource_observations FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_account_event BEFORE UPDATE OR DELETE ON billing.account_events FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE TRIGGER immutable_credit_note BEFORE UPDATE OR DELETE ON billing.credit_note_observations FOR EACH ROW EXECUTE FUNCTION billing.refuse_frozen_change();
CREATE FUNCTION billing.protect_operation_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(OLD.id,OLD.account_id,OLD.commercial_intent_id,OLD.application,OLD.kind,OLD.client_key,OLD.idempotency_key,OLD.scope_ref,OLD.fingerprint,OLD.request_snapshot,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.account_id,NEW.commercial_intent_id,NEW.application,NEW.kind,NEW.client_key,NEW.idempotency_key,NEW.scope_ref,NEW.fingerprint,NEW.request_snapshot,NEW.created_at) THEN
    RAISE EXCEPTION 'Immutable billing operation request';
  END IF;
  IF OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at THEN
    RAISE EXCEPTION 'Original billing attempt time is immutable';
  END IF;
  IF OLD.provider_object_id IS NOT NULL AND ROW(NEW.provider_object_id,NEW.provider_object_type) IS DISTINCT FROM ROW(OLD.provider_object_id,OLD.provider_object_type) THEN
    RAISE EXCEPTION 'Bound provider identity is immutable';
  END IF;
  IF OLD.state<>'prepared' AND NEW.state='prepared' THEN RAISE EXCEPTION 'Submitted operation cannot be reset'; END IF;
  IF OLD.state IN ('succeeded','failed') AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'Terminal operation cannot be reset'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON billing.operations FOR EACH ROW EXECUTE FUNCTION billing.protect_operation_request();
CREATE FUNCTION billing.protect_resource_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(OLD.stripe_account_id,OLD.mode,OLD.object_type,OLD.object_id,OLD.account_id,OLD.operation_id,OLD.scope_ref)
    IS DISTINCT FROM ROW(NEW.stripe_account_id,NEW.mode,NEW.object_type,NEW.object_id,NEW.account_id,NEW.operation_id,NEW.scope_ref) THEN
    RAISE EXCEPTION 'Bound financial resource is immutable';
  END IF;
  IF OLD.object_type='invoice' AND OLD.provider_state IN ('paid','void') AND NEW.provider_state<>OLD.provider_state THEN
    RAISE EXCEPTION 'Terminal invoice state cannot regress';
  END IF;
  IF OLD.object_type='checkout.session' AND ((OLD.provider_state LIKE 'complete.%' AND NEW.provider_state NOT LIKE 'complete.%')
    OR (OLD.provider_state LIKE '%.paid' AND NEW.provider_state NOT LIKE '%.paid')
    OR (OLD.provider_state LIKE 'expired.%' AND NEW.provider_state<>OLD.provider_state)) THEN
    RAISE EXCEPTION 'Terminal checkout state cannot regress';
  END IF;
  IF (OLD.provider_state='paid' OR OLD.provider_state LIKE '%.paid')
    AND ROW(OLD.amount_minor,OLD.currency) IS DISTINCT FROM ROW(NEW.amount_minor,NEW.currency) THEN
    RAISE EXCEPTION 'Settled totals cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_resource_state BEFORE UPDATE OR DELETE ON billing.provider_resources FOR EACH ROW EXECUTE FUNCTION billing.protect_resource_state();
CREATE FUNCTION billing.protect_attempt_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.ended_at IS NOT NULL AND OLD IS DISTINCT FROM NEW) THEN RAISE EXCEPTION 'Completed attempt history is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operation_attempt_history BEFORE UPDATE OR DELETE ON billing.operation_attempts FOR EACH ROW EXECUTE FUNCTION billing.protect_attempt_history();
CREATE TRIGGER usage_attempt_history BEFORE UPDATE OR DELETE ON billing.usage_attempts FOR EACH ROW EXECUTE FUNCTION billing.protect_attempt_history();
CREATE FUNCTION billing.protect_reconciliation_custody() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.event_row_id<>OLD.event_row_id THEN RAISE EXCEPTION 'Reconciliation custody cannot be replaced'; END IF;
  IF OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at THEN RAISE EXCEPTION 'Original reconciliation attempt is immutable'; END IF;
  IF OLD.retry_deadline IS NOT NULL AND NEW.retry_deadline IS DISTINCT FROM OLD.retry_deadline THEN RAISE EXCEPTION 'Original reconciliation deadline is immutable'; END IF;
  IF OLD.state IN ('done','held') AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Terminal reconciliation custody is immutable'; END IF;
  IF NEW.fence<OLD.fence OR NEW.attempt_count<OLD.attempt_count THEN RAISE EXCEPTION 'Reconciliation fencing cannot go backwards'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_custody BEFORE UPDATE OR DELETE ON billing.reconciliation_jobs FOR EACH ROW EXECUTE FUNCTION billing.protect_reconciliation_custody();
CREATE FUNCTION billing.protect_usage_custody() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.event_id<>OLD.event_id THEN RAISE EXCEPTION 'Usage custody cannot be replaced'; END IF;
  IF OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at THEN RAISE EXCEPTION 'Original usage attempt is immutable'; END IF;
  IF OLD.retry_deadline IS NOT NULL AND NEW.retry_deadline IS DISTINCT FROM OLD.retry_deadline THEN RAISE EXCEPTION 'Original usage deadline is immutable'; END IF;
  IF OLD.state IN ('accepted','quarantined') AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Terminal usage custody is immutable'; END IF;
  IF NEW.fence<OLD.fence OR NEW.attempt_count<OLD.attempt_count THEN RAISE EXCEPTION 'Usage fencing cannot go backwards'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_custody BEFORE UPDATE OR DELETE ON billing.usage_outbox FOR EACH ROW EXECUTE FUNCTION billing.protect_usage_custody();

REVOKE ALL ON ALL TABLES IN SCHEMA billing FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA billing FROM PUBLIC;
GRANT USAGE ON SCHEMA billing TO onesa_billing_api,onesa_billing_dispatcher,onesa_billing_webhook,onesa_billing_meter;
GRANT SELECT ON billing.schema_migrations TO onesa_billing_api,onesa_billing_dispatcher,onesa_billing_webhook,onesa_billing_meter;
GRANT SELECT,INSERT ON billing.scope_refs TO onesa_billing_api,onesa_billing_meter;
GRANT SELECT ON billing.scope_refs TO onesa_billing_dispatcher,onesa_billing_webhook;
GRANT SELECT,INSERT ON billing.accounts,billing.principals,billing.memberships,billing.commercial_intents,billing.operations TO onesa_billing_api;
GRANT SELECT,INSERT ON billing.account_events TO onesa_billing_api;
GRANT UPDATE(status,revision,closed_at) ON billing.accounts TO onesa_billing_api;
GRANT UPDATE(role,status,revision,updated_at) ON billing.memberships TO onesa_billing_api;
GRANT SELECT ON billing.customer_bindings,billing.provider_resources,billing.resource_observations,billing.credit_note_observations,billing.usage_events,billing.usage_outbox TO onesa_billing_api;
GRANT SELECT ON billing.accounts,billing.commercial_intents,billing.operations,billing.customer_bindings,billing.provider_resources,billing.webhook_events,billing.reconciliation_jobs,billing.usage_events,billing.usage_outbox,billing.operation_attempts,billing.usage_attempts TO onesa_billing_dispatcher;
GRANT INSERT ON billing.customer_bindings,billing.provider_resources,billing.resource_observations,billing.operation_attempts,billing.usage_attempts TO onesa_billing_dispatcher;
GRANT SELECT,INSERT ON billing.credit_note_observations TO onesa_billing_dispatcher;
GRANT UPDATE(state,first_attempt_at,lease_token,lease_until,fence,reason,provider_object_id,provider_object_type,provider_state,completed_at) ON billing.operations TO onesa_billing_dispatcher;
GRANT UPDATE(ended_at,outcome,reason) ON billing.operation_attempts,billing.usage_attempts TO onesa_billing_dispatcher;
GRANT UPDATE(provider_state,amount_minor,currency,verified_at) ON billing.provider_resources TO onesa_billing_dispatcher;
GRANT UPDATE(state,first_attempt_at,retry_deadline,next_attempt_at,attempt_count,lease_token,lease_until,fence,reason,completed_at) ON billing.reconciliation_jobs TO onesa_billing_dispatcher;
GRANT UPDATE(state,next_attempt_at,first_attempt_at,retry_deadline,lease_token,lease_until,fence,attempt_count,accepted_at,reason) ON billing.usage_outbox TO onesa_billing_dispatcher;
GRANT SELECT,INSERT ON billing.webhook_events,billing.reconciliation_jobs TO onesa_billing_webhook;
GRANT SELECT ON billing.accounts,billing.customer_bindings,billing.usage_events,billing.usage_outbox TO onesa_billing_meter;
GRANT INSERT ON billing.usage_events,billing.usage_outbox TO onesa_billing_meter;
COMMIT;
