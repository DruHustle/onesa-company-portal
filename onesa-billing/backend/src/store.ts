import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { BillingError, ensure } from './domain.js';
import type { Actor, BillingRole, CatalogLine, CustomerBinding, Json, ProviderOperation, ProviderScope, VerifiedWebhook } from './domain.js';
import { USAGE_MAX_ATTEMPTS, usageRetryDeadline, validatePreparedUsageEvent } from './usage.js';
import type { PreparedUsageEvent, UsageClaim, UsageExportStore, UsageOutcome } from './usage.js';

export interface StorePools { api: Pool; dispatcher: Pool; webhook: Pool; meter: Pool }
export interface StoreOptions { scope: ProviderScope; pools: StorePools }
export type OperationKind = 'customer_create' | 'checkout_create' | 'invoice_create' | 'invoice_finalize' | 'portal_create';
export type OperationState = 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';
export type OperationReason = 'provider_timeout' | 'provider_error' | 'lease_expired' | 'configuration_changed' | 'result_unverified' | 'provider_rejected';
export type ReconciliationReason = 'unbound_resource' | 'provider_unavailable' | 'configuration_changed' | 'ownership_mismatch' | 'unsupported_event' | 'lease_expired' | 'retry_deadline_exceeded' | 'attempt_limit_exceeded';
export interface BillingAccount { id: string; displayName: string; status: 'active' | 'suspended' | 'closed'; revision: number; role: BillingRole }
export interface CommercialIntent {
  id: string; accountId: string; kind: 'customer' | 'checkout' | 'invoice' | 'portal';
  fingerprint: string; scope: ProviderScope; lines: CatalogLine[]; frozenRequest: Record<string, Json>; createdAt: string;
}
export interface PrepareCommercialIntent {
  accountId: string; kind: 'checkout' | 'invoice' | 'portal'; clientKey: string;
  lines: CatalogLine[]; frozenRequest?: Record<string, Json>;
}
export interface PrepareOperation {
  accountId: string; commercialIntentId: string; kind: OperationKind; clientKey: string; frozenRequest: Record<string, Json>;
}
export interface StoredOperation extends ProviderOperation {
  kind: OperationKind; state: OperationState; frozenRequest: Record<string, Json>;
  providerObjectId: string | null; providerObjectType: string | null; providerState: string | null;
  reason: OperationReason | null; fence: number;
}
export interface OperationLease { operation: StoredOperation; leaseToken: string; fence: number; expiresAt: string }
export type ProviderObjectType = VerifiedWebhook['objectType'] | 'billing_portal.session';
/** Construct only after the provider adapter has verified resource/customer/account/mode. */
export interface VerifiedOperationResult {
  binding: CustomerBinding; objectId: string; objectType: ProviderObjectType; state: string;
  amountMinor?: number; currency?: string;
}
export interface ReconciliationClaim {
  eventRowId: string; leaseToken: string; fence: number; expiresAt: string; event: VerifiedWebhook;
  firstAttemptAt: string; retryDeadline: string; attemptCount: number;
}
export interface DispatchContext { operation: StoredOperation; intent: CommercialIntent; customer: CustomerBinding | null }
export interface VerifiedResourceMetadata { accountId: string; fingerprint: string; customerId?: string }
/** The service supplies this only after checking the fresh invoice against every frozen catalog/tax field. */
export interface VerifiedInvoiceIntent { commercialIntentId: string; creationFingerprint: string; intentFingerprint: string }
export interface VerifiedCreditNoteObservation {
  binding: CustomerBinding; objectId: string; invoiceId: string; state: 'issued' | 'void'; amountMinor: number; currency: string;
}

const operationKinds = new Set<OperationKind>(['customer_create', 'checkout_create', 'invoice_create', 'invoice_finalize', 'portal_create']);
const operationReasons = new Set<OperationReason>(['provider_timeout', 'provider_error', 'lease_expired', 'configuration_changed', 'result_unverified', 'provider_rejected']);
const reconciliationReasons = new Set<ReconciliationReason>(['unbound_resource', 'provider_unavailable', 'configuration_changed', 'ownership_mismatch', 'unsupported_event', 'lease_expired', 'retry_deadline_exceeded', 'attempt_limit_exceeded']);
const reconciliationMaxAttempts = 40;
const reconciliationWindowMs = 86_400_000;
const usageReasons = new Set(['invalid_claim', 'payload_integrity', 'provider_scope_mismatch', 'provider_configuration', 'provider_rejected', 'provider_protocol', 'network_or_timeout', 'rate_limited', 'provider_unavailable', 'retry_deadline_exceeded', 'attempt_limit_exceeded']);
const expectedObject: Record<OperationKind, ProviderObjectType> = {
  customer_create: 'customer', checkout_create: 'checkout.session', invoice_create: 'invoice',
  invoice_finalize: 'invoice', portal_create: 'billing_portal.session',
};
const expectedIntent: Record<OperationKind, CommercialIntent['kind']> = {
  customer_create: 'customer', checkout_create: 'checkout', invoice_create: 'invoice', invoice_finalize: 'invoice', portal_create: 'portal',
};
type Row = QueryResultRow;

function text(value: unknown, max = 200, code = 'INVALID_BILLING_INPUT'): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value), code);
  return value;
}
function uuid(value: unknown): string {
  const result = text(value, 36);
  ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(result), 'INVALID_BILLING_ID');
  return result;
}
function actor(value: Actor): Actor { return { issuer: text(value.issuer, 2048), subject: text(value.subject, 256) }; }
function scope(value: ProviderScope): ProviderScope {
  ensure(value.application === 'company' && ['test', 'live'].includes(value.mode), 'INVALID_BILLING_SCOPE');
  ensure(/^acct_[A-Za-z0-9]+$/u.test(text(value.stripeAccountId)), 'INVALID_BILLING_SCOPE');
  return Object.freeze({ application: 'company', stripeAccountId: value.stripeAccountId, mode: value.mode, configVersion: text(value.configVersion) });
}
function date(value: unknown): string {
  const stamp = value instanceof Date ? value : new Date(String(value));
  ensure(Number.isFinite(stamp.getTime()), 'INVALID_BILLING_TIME');
  return stamp.toISOString();
}
function duration(value: number): number {
  ensure(Number.isSafeInteger(value) && value >= 100 && value <= 300_000, 'INVALID_BILLING_LEASE');
  return value;
}
function jsonValue(value: unknown, depth = 0): Json {
  ensure(depth <= 12, 'INVALID_BILLING_SNAPSHOT');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'INVALID_BILLING_SNAPSHOT'); return value; }
  if (typeof value === 'string') {
    ensure(value.length <= 4096 && !/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|-----BEGIN .*PRIVATE KEY/u.test(value), 'SECRET_IN_BILLING_SNAPSHOT');
    return value;
  }
  ensure(value !== undefined && typeof value === 'object', 'INVALID_BILLING_SNAPSHOT');
  if (Array.isArray(value)) { ensure(value.length <= 64, 'INVALID_BILLING_SNAPSHOT'); return value.map(v => jsonValue(v, depth + 1)); }
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'INVALID_BILLING_SNAPSHOT');
  const entries = Object.entries(value as Record<string, unknown>);
  ensure(entries.length <= 64, 'INVALID_BILLING_SNAPSHOT');
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const [key, item] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    ensure(!/^(?:__proto__|prototype|constructor|authorization|password|secret|api_?key|client_?secret|card|cvc|cvv)$/iu.test(key), 'SECRET_IN_BILLING_SNAPSHOT');
    result[key] = jsonValue(item, depth + 1);
  }
  return result;
}
export function canonicalBillingJson(value: unknown): string {
  const result = JSON.stringify(jsonValue(value));
  ensure(Buffer.byteLength(result) <= 32_768, 'BILLING_SNAPSHOT_TOO_LARGE');
  return result;
}
export function billingFingerprint(value: unknown): string { return createHash('sha256').update(canonicalBillingJson(value)).digest('hex'); }
function snapshot(value: unknown): Record<string, Json> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_BILLING_SNAPSHOT');
  return JSON.parse(canonicalBillingJson(value)) as Record<string, Json>;
}
function scopeFromRow(row: Row): ProviderScope {
  return scope({ application: 'company', stripeAccountId: String(row.stripe_account_id), mode: row.mode, configVersion: String(row.config_version) });
}
function operation(row: Row): StoredOperation {
  return {
    id: row.id, accountId: row.account_id, commercialIntentId: row.commercial_intent_id,
    idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, createdAt: date(row.created_at),
    firstAttemptAt: row.first_attempt_at ? date(row.first_attempt_at) : null, scope: scopeFromRow(row),
    kind: row.kind, state: row.state, frozenRequest: row.request_snapshot,
    providerObjectId: row.provider_object_id, providerObjectType: row.provider_object_type,
    providerState: row.provider_state, reason: row.reason, fence: row.fence,
  };
}
function intent(row: Row): CommercialIntent {
  return { id: row.id, accountId: row.account_id, kind: row.kind, fingerprint: row.fingerprint,
    scope: scopeFromRow(row), lines: row.catalog_snapshot, frozenRequest: row.request_snapshot, createdAt: date(row.created_at) };
}
function webhook(row: Row): VerifiedWebhook {
  return { stripeAccountId: row.stripe_account_id, mode: row.mode, eventId: row.event_id,
    type: row.event_type, objectId: row.object_id, objectType: row.object_type,
    createdAt: date(row.provider_created_at), bodySha256: row.body_sha256, format: row.format };
}
const operationSelect = 'SELECT o.*,s.stripe_account_id,s.mode,s.config_version FROM billing.operations o JOIN billing.scope_refs s ON s.ref=o.scope_ref';
const intentSelect = 'SELECT i.*,s.stripe_account_id,s.mode,s.config_version FROM billing.commercial_intents i JOIN billing.scope_refs s ON s.ref=i.scope_ref';

export async function verifyStorePoolRoles(pools: StorePools): Promise<void> {
  const groups = { api: 'onesa_billing_api', dispatcher: 'onesa_billing_dispatcher', webhook: 'onesa_billing_webhook', meter: 'onesa_billing_meter' } as const;
  await Promise.all(Object.entries(groups).map(async ([name, group]) => {
    let row: Row;
    try {
      row = (await pools[name as keyof StorePools].query("SELECT current_user=session_user AS direct_login,r.rolcanlogin, NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS restricted,pg_has_role(current_user,$1,'USAGE') AS expected_group, NOT pg_has_role(current_user,'onesa_billing_owner','MEMBER') AS not_owner, NOT has_schema_privilege(current_user,'billing','CREATE') AS no_billing_ddl, NOT has_schema_privilege(current_user,'public','CREATE') AS no_public_ddl, NOT EXISTS(SELECT 1 FROM pg_roles other WHERE (other.rolsuper OR other.rolcreatedb OR other.rolcreaterole OR other.rolreplication OR other.rolbypassrls) AND pg_has_role(current_user,other.oid,'MEMBER')) AS no_elevated_membership, NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname=ANY($2::text[]) AND other.rolname<>$1 AND pg_has_role(current_user,other.oid,'MEMBER')) AS single_runtime_group, NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='billing' AND pg_has_role(current_user,t.relowner,'MEMBER')) AS no_relation_ownership FROM pg_roles r WHERE r.rolname=current_user", [group, Object.values(groups)])).rows[0];
    } catch { throw new BillingError('BILLING_RUNTIME_ROLE_UNVERIFIED', 503); }
    ensure(row && Object.values(row).every(value => value === true), 'BILLING_RUNTIME_ROLE_UNVERIFIED', 503);
    const extra = (await pools[name as keyof StorePools].query("SELECT NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname<>current_user AND other.rolname<>$1 AND pg_has_role(current_user,other.oid,'MEMBER')) AS only_expected_memberships", [group])).rows[0];
    ensure(extra?.only_expected_memberships === true, 'BILLING_RUNTIME_ROLE_UNVERIFIED', 503);
  }));
}

/** Each pool must use its separately provisioned least-privilege runtime role. */
export class BillingStore implements UsageExportStore {
  readonly scope: ProviderScope;
  private readonly scopeRef: string;
  private readonly pools: StorePools;
  constructor(options: StoreOptions) {
    this.scope = scope(options.scope);
    this.scopeRef = billingFingerprint(this.scope);
    this.pools = options.pools;
  }
  async verifyRoles(): Promise<void> { await verifyStorePoolRoles(this.pools); }

  private async transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='3s'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // SQL text, constraint details and provider request values never escape this boundary.
      if (error instanceof BillingError) throw error;
      const code = (error as { code?: string })?.code;
      if (['23001', '23505', '23503', '23514', 'P0001'].includes(code ?? '')) throw new BillingError('BILLING_CONFLICT', 409);
      throw new BillingError('BILLING_STORE_UNAVAILABLE', 503);
    } finally { client.release(); }
  }
  private assertScope(value: ProviderScope): void { ensure(billingFingerprint(scope(value)) === this.scopeRef, 'BILLING_SCOPE_MISMATCH', 409); }
  private async rememberScope(c: PoolClient): Promise<void> {
    await c.query('INSERT INTO billing.scope_refs(ref,application,stripe_account_id,mode,config_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [this.scopeRef, 'company', this.scope.stripeAccountId, this.scope.mode, this.scope.configVersion]);
    const existing = (await c.query('SELECT * FROM billing.scope_refs WHERE ref=$1', [this.scopeRef])).rows[0];
    ensure(existing && billingFingerprint(scopeFromRow(existing)) === this.scopeRef, 'BILLING_CONFIGURATION_CONFLICT', 409);
  }
  private async principal(c: PoolClient, identity: Actor): Promise<string> {
    const checked = actor(identity);
    await c.query('INSERT INTO billing.principals(id,issuer,subject) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO NOTHING', [randomUUID(), checked.issuer, checked.subject]);
    return (await c.query('SELECT id FROM billing.principals WHERE issuer=$1 AND subject=$2', [checked.issuer, checked.subject])).rows[0].id;
  }
  private async accountLock(c: PoolClient, accountId: string): Promise<void> {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('onesa-billing-account:'||$1,0))", [uuid(accountId)]);
  }
  private async authorized(c: PoolClient, identity: Actor, accountId: string, role: BillingRole = 'viewer', writing = false): Promise<BillingAccount> {
    ensure(['owner', 'payer', 'viewer'].includes(role), 'INVALID_BILLING_CAPABILITY');
    const checked = actor(identity);
    if (writing) await this.accountLock(c, accountId);
    const row = (await c.query('SELECT a.*,m.role FROM billing.accounts a JOIN billing.memberships m ON m.account_id=a.id JOIN billing.principals p ON p.id=m.principal_id WHERE a.id=$1 AND a.application=\'company\' AND m.status=\'active\' AND p.issuer=$2 AND p.subject=$3', [uuid(accountId), checked.issuer, checked.subject])).rows[0];
    ensure(row, 'BILLING_NOT_FOUND', 404);
    const allowed = role === 'viewer' || row.role === 'owner' || (role === 'payer' && row.role === 'payer');
    ensure(allowed, 'BILLING_FORBIDDEN', 403);
    if (writing) ensure(row.status === 'active', 'BILLING_ACCOUNT_INACTIVE', 409);
    return { id: row.id, displayName: row.display_name, status: row.status, revision: row.revision, role: row.role };
  }

  async createAccount(identity: Actor, input: { displayName: string }): Promise<BillingAccount> {
    const name = text(input.displayName);
    return this.transaction(this.pools.api, async c => {
      await this.rememberScope(c);
      const principalId = await this.principal(c, identity), id = randomUUID();
      await c.query('INSERT INTO billing.accounts(id,display_name) VALUES($1,$2)', [id, name]);
      await c.query("INSERT INTO billing.memberships(account_id,principal_id,role) VALUES($1,$2,'owner')", [id, principalId]);
      await c.query("INSERT INTO billing.account_events(id,account_id,actor_principal_id,affected_principal_id,action,revision,role,membership_status) VALUES($1,$2,$3,$3,'account_created',1,'owner','active')", [randomUUID(), id, principalId]);
      const frozen = { accountId: id, scope: this.scope, kind: 'customer', lines: [], request: {} };
      await c.query("INSERT INTO billing.commercial_intents(id,account_id,kind,client_key,scope_ref,fingerprint,catalog_snapshot,request_snapshot) VALUES($1,$1,'customer','account-customer',$2,$3,'[]','{}')", [id, this.scopeRef, billingFingerprint(frozen)]);
      return { id, displayName: name, status: 'active', revision: 1, role: 'owner' };
    });
  }
  async getAccountForActor(identity: Actor, accountId: string, capability: BillingRole = 'viewer'): Promise<BillingAccount> {
    return this.transaction(this.pools.api, c => this.authorized(c, identity, accountId, capability));
  }
  async listAccounts(identity: Actor): Promise<BillingAccount[]> {
    const checked = actor(identity);
    return this.transaction(this.pools.api, async c => {
      const rows = (await c.query("SELECT a.*,m.role FROM billing.accounts a JOIN billing.memberships m ON m.account_id=a.id JOIN billing.principals p ON p.id=m.principal_id WHERE a.application='company' AND m.status='active' AND p.issuer=$1 AND p.subject=$2 ORDER BY a.created_at,a.id LIMIT 101", [checked.issuer, checked.subject])).rows;
      ensure(rows.length <= 100, 'BILLING_ACCOUNT_LIST_LIMIT', 409);
      return rows.map(row => ({ id: row.id, displayName: row.display_name, status: row.status, revision: row.revision, role: row.role }));
    });
  }
  async setMembership(identity: Actor, accountId: string, expectedRevision: number, change: { actor: Actor; role: BillingRole; status: 'active' | 'revoked' }): Promise<number> {
    ensure(Number.isSafeInteger(expectedRevision) && expectedRevision > 0 && ['owner', 'payer', 'viewer'].includes(change.role)
      && ['active', 'revoked'].includes(change.status), 'INVALID_MEMBERSHIP');
    return this.transaction(this.pools.api, async c => {
      const account = await this.authorized(c, identity, accountId, 'owner', true);
      ensure(account.revision === expectedRevision, 'BILLING_REVISION_CONFLICT', 409);
      const principalId = await this.principal(c, change.actor);
      const old = (await c.query('SELECT role,status FROM billing.memberships WHERE account_id=$1 AND principal_id=$2', [accountId, principalId])).rows[0];
      if (old?.role === 'owner' && old.status === 'active' && (change.role !== 'owner' || change.status !== 'active')) {
        const count = (await c.query("SELECT count(*)::integer AS count FROM billing.memberships WHERE account_id=$1 AND role='owner' AND status='active'", [accountId])).rows[0].count;
        ensure(count > 1, 'LAST_BILLING_OWNER', 409);
      }
      await c.query('INSERT INTO billing.memberships(account_id,principal_id,role,status) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,principal_id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,revision=billing.memberships.revision+1,updated_at=now()', [accountId, principalId, change.role, change.status]);
      const revision = (await c.query('UPDATE billing.accounts SET revision=revision+1 WHERE id=$1 RETURNING revision', [accountId])).rows[0].revision;
      const actorId = await this.principal(c, identity);
      await c.query("INSERT INTO billing.account_events(id,account_id,actor_principal_id,affected_principal_id,action,revision,role,membership_status) VALUES($1,$2,$3,$4,'membership_changed',$5,$6,$7)", [randomUUID(), accountId, actorId, principalId, revision, change.role, change.status]);
      return revision;
    });
  }
  async closeAccount(identity: Actor, accountId: string, expectedRevision: number): Promise<void> {
    await this.transaction(this.pools.api, async c => {
      const account = await this.authorized(c, identity, accountId, 'owner', true);
      ensure(account.revision === expectedRevision, 'BILLING_REVISION_CONFLICT', 409);
      await c.query("UPDATE billing.accounts SET status='closed',closed_at=now(),revision=revision+1 WHERE id=$1", [accountId]);
      const actorId = await this.principal(c, identity);
      await c.query("INSERT INTO billing.account_events(id,account_id,actor_principal_id,action,revision) VALUES($1,$2,$3,'account_closed',$4)", [randomUUID(), accountId, actorId, account.revision + 1]);
    });
  }

  async createCommercialIntent(identity: Actor, input: PrepareCommercialIntent): Promise<{ created: boolean; intent: CommercialIntent }> {
    ensure(['checkout', 'invoice', 'portal'].includes(input.kind), 'INVALID_COMMERCIAL_INTENT');
    text(input.clientKey, 128);
    ensure(Array.isArray(input.lines) && input.lines.length <= 32 && (input.kind === 'portal' ? input.lines.length === 0 : input.lines.length > 0), 'INVALID_CATALOG');
    for (const line of input.lines) {
      ensure(line.item.kind === 'one_off', 'METERED_MANUAL_BILLING_FORBIDDEN', 409);
      ensure(Number.isSafeInteger(line.quantity) && line.quantity > 0 && Number.isSafeInteger(line.item.maxQuantity)
        && line.quantity <= line.item.maxQuantity && Number.isSafeInteger(line.item.unitAmount) && line.item.unitAmount >= 0,
      'INVALID_CATALOG');
      ensure(/^price_[A-Za-z0-9]+$/u.test(line.item.priceId) && /^[a-z]{3}$/u.test(line.item.currency)
        && ['inclusive', 'exclusive'].includes(line.item.taxBehavior), 'INVALID_CATALOG');
      text(line.item.sku); text(line.item.title); text(line.item.version);
    }
    ensure(new Set(input.lines.map(line => line.item.currency)).size <= 1, 'MIXED_CURRENCY');
    const request = snapshot(input.frozenRequest ?? {}), lines = JSON.parse(canonicalBillingJson(input.lines)) as CatalogLine[];
    const fingerprint = billingFingerprint({ accountId: input.accountId, scope: this.scope, kind: input.kind, lines, request });
    return this.transaction(this.pools.api, async c => {
      await this.authorized(c, identity, input.accountId, 'payer', true);
      await this.rememberScope(c);
      const old = (await c.query(`${intentSelect} WHERE i.account_id=$1 AND i.kind=$2 AND i.client_key=$3`, [input.accountId, input.kind, input.clientKey])).rows[0];
      if (old) { ensure(old.fingerprint === fingerprint, 'BILLING_IDEMPOTENCY_CONFLICT', 409); return { created: false, intent: intent(old) }; }
      const id = randomUUID();
      await c.query('INSERT INTO billing.commercial_intents(id,account_id,kind,client_key,scope_ref,fingerprint,catalog_snapshot,request_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, input.accountId, input.kind, input.clientKey, this.scopeRef, fingerprint, JSON.stringify(lines), JSON.stringify(request)]);
      return { created: true, intent: intent((await c.query(`${intentSelect} WHERE i.id=$1`, [id])).rows[0]) };
    });
  }
  async getCommercialIntent(identity: Actor, accountId: string, id: string): Promise<CommercialIntent> {
    return this.transaction(this.pools.api, async c => {
      await this.authorized(c, identity, accountId);
      const row = (await c.query(`${intentSelect} WHERE i.account_id=$1 AND i.id=$2`, [accountId, uuid(id)])).rows[0];
      ensure(row, 'BILLING_NOT_FOUND', 404); return intent(row);
    });
  }
  async prepareOperation(identity: Actor, input: PrepareOperation): Promise<{ created: boolean; operation: StoredOperation }> {
    ensure(operationKinds.has(input.kind), 'INVALID_BILLING_OPERATION'); text(input.clientKey, 128);
    const request = snapshot(input.frozenRequest);
    return this.transaction(this.pools.api, async c => {
      await this.authorized(c, identity, input.accountId, 'payer', true);
      const commercial = (await c.query(`${intentSelect} WHERE i.account_id=$1 AND i.id=$2`, [input.accountId, uuid(input.commercialIntentId)])).rows[0];
      ensure(commercial && commercial.kind === expectedIntent[input.kind], 'BILLING_INTENT_MISMATCH', 409);
      this.assertScope(scopeFromRow(commercial));
      const fingerprint = billingFingerprint({ accountId: input.accountId, scope: this.scope, kind: input.kind,
        commercialIntentId: input.commercialIntentId, commercialFingerprint: commercial.fingerprint, request });
      const existing = (await c.query(`${operationSelect} WHERE o.account_id=$1 AND o.kind=$2 AND (o.client_key=$3 OR o.commercial_intent_id=$4)`, [input.accountId, input.kind, input.clientKey, input.commercialIntentId])).rows;
      if (existing.length) {
        ensure(existing.length === 1 && existing[0].fingerprint === fingerprint, 'BILLING_IDEMPOTENCY_CONFLICT', 409);
        return { created: false, operation: operation(existing[0]) };
      }
      const id = randomUUID(), idempotencyKey = `onesa-company-${id}`;
      await c.query('INSERT INTO billing.operations(id,account_id,commercial_intent_id,kind,client_key,idempotency_key,scope_ref,fingerprint,request_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, input.accountId, input.commercialIntentId, input.kind, input.clientKey, idempotencyKey, this.scopeRef, fingerprint, JSON.stringify(request)]);
      return { created: true, operation: operation((await c.query(`${operationSelect} WHERE o.id=$1`, [id])).rows[0]) };
    });
  }
  async getOperation(identity: Actor, id: string): Promise<StoredOperation> {
    return this.transaction(this.pools.api, async c => {
      const row = (await c.query(`${operationSelect} WHERE o.id=$1`, [uuid(id)])).rows[0];
      ensure(row, 'BILLING_NOT_FOUND', 404);
      await this.authorized(c, identity, row.account_id);
      return operation(row);
    });
  }
  async listOperations(identity: Actor, accountId: string, limit = 50): Promise<StoredOperation[]> {
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 50, 'INVALID_BILLING_LIMIT');
    return this.transaction(this.pools.api, async c => {
      await this.authorized(c, identity, accountId);
      const rows = (await c.query(`${operationSelect} WHERE o.account_id=$1 AND s.stripe_account_id=$2 AND s.mode=$3 ORDER BY o.created_at DESC,o.id DESC LIMIT $4`, [accountId, this.scope.stripeAccountId, this.scope.mode, limit])).rows;
      return rows.map(operation);
    });
  }
  async getCustomer(identity: Actor, accountId: string): Promise<CustomerBinding | null> {
    return this.transaction(this.pools.api, async c => {
      await this.authorized(c, identity, accountId);
      const row = (await c.query('SELECT b.*,s.config_version FROM billing.customer_bindings b JOIN billing.scope_refs s ON s.ref=b.scope_ref WHERE b.account_id=$1 AND b.stripe_account_id=$2 AND b.mode=$3', [accountId, this.scope.stripeAccountId, this.scope.mode])).rows[0];
      if (!row) return null;
      const boundScope = scopeFromRow(row); this.assertScope(boundScope);
      return { accountId, customerId: row.customer_id, scope: boundScope };
    });
  }

  async claimOperation(options: { operationId?: string; leaseMs?: number } = {}): Promise<OperationLease | null> {
    const leaseMs = duration(options.leaseMs ?? 30_000);
    if (options.operationId) uuid(options.operationId);
    return this.transaction(this.pools.dispatcher, async c => {
      // Submission is never replayed merely because its worker lease expired.
      const expired = (await c.query("WITH stale AS (SELECT id FROM billing.operations WHERE state='dispatched' AND lease_until<=now() AND scope_ref=$1 ORDER BY lease_until,id LIMIT 32 FOR UPDATE SKIP LOCKED) UPDATE billing.operations o SET state='unknown',reason='lease_expired',lease_token=NULL,lease_until=NULL FROM stale WHERE o.id=stale.id RETURNING o.id,o.fence", [this.scopeRef])).rows;
      for (const row of expired) await c.query("UPDATE billing.operation_attempts SET ended_at=now(),outcome='unknown',reason='lease_expired' WHERE operation_id=$1 AND fence=$2 AND ended_at IS NULL", [row.id, row.fence]);
      // One-time portal URLs belong to their synchronous caller, never the background worker.
      const row = (await c.query(`${operationSelect} JOIN billing.accounts a ON a.id=o.account_id WHERE o.state='prepared' AND o.scope_ref=$1 AND a.status='active' AND (($2::uuid IS NULL AND o.kind<>'portal_create') OR o.id=$2) ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, [this.scopeRef, options.operationId ?? null])).rows[0];
      if (!row) return null;
      await this.accountLock(c, row.account_id);
      ensure((await c.query('SELECT status FROM billing.accounts WHERE id=$1', [row.account_id])).rows[0]?.status === 'active', 'BILLING_ACCOUNT_INACTIVE', 409);
      const leaseToken = randomUUID();
      const claimed = (await c.query("UPDATE billing.operations SET state='dispatched',first_attempt_at=now(),lease_token=$2,lease_until=now()+$3::bigint*interval '1 millisecond',fence=fence+1 WHERE id=$1 RETURNING *", [row.id, leaseToken, leaseMs])).rows[0];
      await c.query('INSERT INTO billing.operation_attempts(operation_id,fence,lease_token) VALUES($1,$2,$3)', [row.id, claimed.fence, leaseToken]);
      return { operation: operation({ ...row, ...claimed }), leaseToken, fence: claimed.fence, expiresAt: date(claimed.lease_until) };
    });
  }
  private async ownedOperation(c: PoolClient, lease: OperationLease, mustBeLive = true): Promise<Row> {
    const row = (await c.query(`${operationSelect} WHERE o.id=$1 FOR UPDATE OF o`, [uuid(lease.operation.id)])).rows[0];
    ensure(row && row.state === 'dispatched' && row.lease_token === lease.leaseToken && row.fence === lease.fence
      && row.scope_ref === this.scopeRef && row.fingerprint === lease.operation.fingerprint, 'STALE_BILLING_LEASE', 409);
    if (mustBeLive) ensure((await c.query('SELECT $1::timestamptz>clock_timestamp() AS live', [row.lease_until])).rows[0].live, 'STALE_BILLING_LEASE', 409);
    return row;
  }
  private async context(c: PoolClient, row: Row): Promise<DispatchContext> {
    this.assertScope(scopeFromRow(row));
    const commercial = (await c.query(`${intentSelect} WHERE i.account_id=$1 AND i.id=$2`, [row.account_id, row.commercial_intent_id])).rows[0];
    ensure(commercial && commercial.scope_ref === this.scopeRef && commercial.kind === expectedIntent[row.kind as OperationKind], 'BILLING_INTENT_MISMATCH', 409);
    const bound = (await c.query('SELECT b.*,s.config_version FROM billing.customer_bindings b JOIN billing.scope_refs s ON s.ref=b.scope_ref WHERE b.account_id=$1 AND b.stripe_account_id=$2 AND b.mode=$3', [row.account_id, this.scope.stripeAccountId, this.scope.mode])).rows[0];
    if (bound) this.assertScope(scopeFromRow(bound));
    ensure(row.kind === 'customer_create' || bound, 'BILLING_CUSTOMER_REQUIRED', 409);
    return { operation: operation(row), intent: intent(commercial),
      customer: bound ? { accountId: row.account_id, customerId: bound.customer_id, scope: scopeFromRow(bound) } : null };
  }
  async getDispatchContext(lease: OperationLease): Promise<DispatchContext> {
    return this.transaction(this.pools.dispatcher, async c => this.context(c, await this.ownedOperation(c, lease)));
  }
  private validateResult(row: Row, result: VerifiedOperationResult): void {
    this.assertScope(result.binding.scope);
    ensure(result.binding.accountId === row.account_id && result.objectType === expectedObject[row.kind as OperationKind], 'BILLING_RESOURCE_OWNERSHIP', 409);
    text(result.objectId); text(result.state, 100);
    ensure(/^[A-Za-z][A-Za-z0-9_.-]+$/u.test(result.objectId) && /^[a-z][a-z0-9_.-]*$/u.test(result.state), 'INVALID_PROVIDER_RESULT');
    ensure(/^cus_[A-Za-z0-9]+$/u.test(result.binding.customerId), 'INVALID_PROVIDER_RESULT');
    if (result.amountMinor !== undefined) ensure(Number.isSafeInteger(result.amountMinor) && result.amountMinor >= 0, 'INVALID_PROVIDER_RESULT');
    if (result.currency !== undefined) ensure(/^[a-z]{3}$/u.test(result.currency), 'INVALID_PROVIDER_RESULT');
    if (row.kind === 'customer_create') ensure(result.objectId === result.binding.customerId, 'BILLING_RESOURCE_OWNERSHIP', 409);
  }
  private async bindResult(c: PoolClient, row: Row, result: VerifiedOperationResult, eventRowId: string | null = null): Promise<void> {
    this.validateResult(row, result);
    const params = [row.account_id, this.scope.stripeAccountId, this.scope.mode];
    const customer = (await c.query('SELECT * FROM billing.customer_bindings WHERE account_id=$1 AND stripe_account_id=$2 AND mode=$3', params)).rows[0];
    if (row.kind === 'customer_create') {
      if (customer) ensure(customer.customer_id === result.binding.customerId && customer.scope_ref === this.scopeRef, 'BILLING_CUSTOMER_CONFLICT', 409);
      else await c.query('INSERT INTO billing.customer_bindings(account_id,stripe_account_id,mode,customer_id,scope_ref,operation_id) VALUES($1,$2,$3,$4,$5,$6)', [...params, result.binding.customerId, this.scopeRef, row.id]);
    } else ensure(customer && customer.customer_id === result.binding.customerId && customer.scope_ref === this.scopeRef, 'BILLING_RESOURCE_OWNERSHIP', 409);
    const prior = (await c.query('SELECT r.account_id,r.operation_id,r.provider_state,o.kind,o.commercial_intent_id FROM billing.provider_resources r JOIN billing.operations o ON o.id=r.operation_id WHERE r.stripe_account_id=$1 AND r.mode=$2 AND r.object_type=$3 AND r.object_id=$4', [this.scope.stripeAccountId, this.scope.mode, result.objectType, result.objectId])).rows[0];
    ensure(!prior || prior.account_id === row.account_id, 'BILLING_RESOURCE_OWNERSHIP', 409);
    if (prior) ensure(prior.operation_id === row.id || (row.kind === 'invoice_finalize' && prior.kind === 'invoice_create'
      && prior.commercial_intent_id === row.commercial_intent_id), 'BILLING_RESOURCE_OWNERSHIP', 409);
    if (row.kind === 'invoice_finalize') ensure(prior, 'BILLING_UNBOUND_INVOICE', 409);
    if (prior && result.objectType === 'invoice' && ['paid', 'void'].includes(prior.provider_state)) {
      ensure(result.state === prior.provider_state, 'BILLING_TERMINAL_STATE_CONFLICT', 409);
    }
    if (prior && result.objectType === 'checkout.session') {
      if (String(prior.provider_state).startsWith('complete.')) ensure(result.state.startsWith('complete.'), 'BILLING_TERMINAL_STATE_CONFLICT', 409);
      if (String(prior.provider_state).endsWith('.paid')) ensure(result.state.endsWith('.paid'), 'BILLING_TERMINAL_STATE_CONFLICT', 409);
      if (String(prior.provider_state).startsWith('expired.')) ensure(result.state === prior.provider_state, 'BILLING_TERMINAL_STATE_CONFLICT', 409);
    }
    const bound = await c.query('INSERT INTO billing.provider_resources(stripe_account_id,mode,object_type,object_id,account_id,operation_id,scope_ref,provider_state,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(stripe_account_id,mode,object_type,object_id) DO UPDATE SET provider_state=EXCLUDED.provider_state,amount_minor=COALESCE(EXCLUDED.amount_minor,billing.provider_resources.amount_minor),currency=COALESCE(EXCLUDED.currency,billing.provider_resources.currency),verified_at=now() WHERE billing.provider_resources.account_id=EXCLUDED.account_id AND (billing.provider_resources.operation_id=EXCLUDED.operation_id OR $11::boolean) RETURNING account_id',
      [this.scope.stripeAccountId, this.scope.mode, result.objectType, result.objectId, row.account_id, row.id, this.scopeRef, result.state, result.amountMinor ?? null, result.currency ?? null, row.kind === 'invoice_finalize' && Boolean(prior)]);
    ensure(bound.rowCount === 1, 'BILLING_RESOURCE_OWNERSHIP', 409);
    await c.query('INSERT INTO billing.resource_observations(id,account_id,operation_id,event_row_id,object_type,object_id,provider_state,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(), row.account_id, row.id, eventRowId, result.objectType, result.objectId, result.state, result.amountMinor ?? null, result.currency ?? null]);
  }
  private async finishOperation(c: PoolClient, row: Row, result: VerifiedOperationResult): Promise<void> {
    await c.query("UPDATE billing.operations SET state='succeeded',provider_object_id=$2,provider_object_type=$3,provider_state=$4,completed_at=COALESCE(completed_at,now()),lease_token=NULL,lease_until=NULL,reason=NULL WHERE id=$1", [row.id, result.objectId, result.objectType, result.state]);
    await c.query("UPDATE billing.operation_attempts SET ended_at=now(),outcome='succeeded',reason=NULL WHERE operation_id=$1 AND fence=$2 AND ended_at IS NULL", [row.id, row.fence]);
  }
  async completeOperation(lease: OperationLease, result: VerifiedOperationResult): Promise<void> {
    await this.transaction(this.pools.dispatcher, async c => { const row = await this.ownedOperation(c, lease); await this.bindResult(c, row, result); await this.finishOperation(c, row, result); });
  }
  async bindCustomer(lease: OperationLease, binding: CustomerBinding): Promise<void> {
    ensure(lease.operation.kind === 'customer_create', 'BILLING_OPERATION_KIND', 409);
    await this.completeOperation(lease, { binding, objectType: 'customer', objectId: binding.customerId, state: 'created' });
  }
  async holdOperation(lease: OperationLease, reason: OperationReason): Promise<void> {
    ensure(operationReasons.has(reason) && reason !== 'provider_rejected', 'INVALID_BILLING_REASON');
    await this.endOperation(lease, 'unknown', reason);
  }
  async rejectOperation(lease: OperationLease): Promise<void> { await this.endOperation(lease, 'failed', 'provider_rejected'); }
  private async endOperation(lease: OperationLease, state: 'unknown' | 'failed', reason: OperationReason): Promise<void> {
    await this.transaction(this.pools.dispatcher, async c => {
      const row = await this.ownedOperation(c, lease, false);
      await c.query('UPDATE billing.operations SET state=$2,reason=$3,lease_token=NULL,lease_until=NULL,completed_at=CASE WHEN $2=\'failed\' THEN now() ELSE NULL END WHERE id=$1', [row.id, state, reason]);
      await c.query('UPDATE billing.operation_attempts SET ended_at=now(),outcome=$3,reason=$4 WHERE operation_id=$1 AND fence=$2', [row.id, row.fence, state, reason]);
    });
  }

  async acceptWebhook(event: VerifiedWebhook): Promise<{ created: boolean; eventRowId: string }> {
    ensure(event.stripeAccountId === this.scope.stripeAccountId && event.mode === this.scope.mode, 'BILLING_SCOPE_MISMATCH', 409);
    ensure(/^evt_[A-Za-z0-9_]+$/u.test(text(event.eventId)) && /^[a-f0-9]{64}$/u.test(event.bodySha256)
      && ['snapshot', 'thin'].includes(event.format), 'INVALID_VERIFIED_WEBHOOK');
    text(event.type, 100); text(event.objectId); date(event.createdAt);
    const fingerprint = billingFingerprint(event);
    return this.transaction(this.pools.webhook, async c => {
      const id = randomUUID();
      const inserted = await c.query('INSERT INTO billing.webhook_events(id,stripe_account_id,mode,event_id,event_type,object_id,object_type,provider_created_at,body_sha256,format) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(stripe_account_id,mode,event_id) DO NOTHING RETURNING id', [id, event.stripeAccountId, event.mode, event.eventId, event.type, event.objectId, event.objectType, event.createdAt, event.bodySha256, event.format]);
      const row = (await c.query('SELECT * FROM billing.webhook_events WHERE stripe_account_id=$1 AND mode=$2 AND event_id=$3', [event.stripeAccountId, event.mode, event.eventId])).rows[0];
      ensure(billingFingerprint(webhook(row)) === fingerprint, 'BILLING_EVENT_CONFLICT', 409);
      await c.query('INSERT INTO billing.reconciliation_jobs(event_row_id) VALUES($1) ON CONFLICT DO NOTHING', [row.id]);
      return { created: Boolean(inserted.rowCount), eventRowId: row.id };
    });
  }
  async claimReconciliation(leaseMs = 30_000): Promise<ReconciliationClaim | null> {
    duration(leaseMs);
    return this.transaction(this.pools.dispatcher, async c => {
      // A bounded sweep retires exhausted jobs without allowing them to block a later due event.
      for (let inspected = 0; inspected < 32; inspected += 1) {
        const row = (await c.query("SELECT j.*,e.*,clock_timestamp() AS observed_now FROM billing.reconciliation_jobs j JOIN billing.webhook_events e ON e.id=j.event_row_id WHERE e.stripe_account_id=$1 AND e.mode=$2 AND ((j.state='pending' AND j.next_attempt_at<=clock_timestamp()) OR (j.state='leased' AND j.lease_until<=clock_timestamp())) ORDER BY j.next_attempt_at,e.received_at,e.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED", [this.scope.stripeAccountId, this.scope.mode])).rows[0];
        if (!row) return null;
        const now = new Date(date(row.observed_now));
        const first = row.first_attempt_at ? date(row.first_attempt_at) : now.toISOString();
        const deadline = row.retry_deadline ? date(row.retry_deadline) : new Date(now.getTime() + reconciliationWindowMs).toISOString();
        if (row.attempt_count >= reconciliationMaxAttempts || Date.parse(deadline) <= now.getTime()) {
          await c.query("UPDATE billing.reconciliation_jobs SET state='held',reason=$2,lease_token=NULL,lease_until=NULL WHERE event_row_id=$1", [row.event_row_id, row.attempt_count >= reconciliationMaxAttempts ? 'attempt_limit_exceeded' : 'retry_deadline_exceeded']);
          continue;
        }
        const token = randomUUID(), expiresAt = new Date(Math.min(now.getTime() + leaseMs, Date.parse(deadline))).toISOString();
        const claimed = (await c.query("UPDATE billing.reconciliation_jobs SET state='leased',first_attempt_at=$2,retry_deadline=$3,lease_token=$4,lease_until=$5,fence=fence+1,attempt_count=attempt_count+1,reason=NULL WHERE event_row_id=$1 RETURNING *", [row.event_row_id, first, deadline, token, expiresAt])).rows[0];
        return { eventRowId: row.event_row_id, leaseToken: token, fence: claimed.fence, expiresAt, event: webhook(row),
          firstAttemptAt: first, retryDeadline: deadline, attemptCount: claimed.attempt_count };
      }
      return null;
    });
  }
  private async ownedReconciliation(c: PoolClient, claim: ReconciliationClaim): Promise<Row> {
    const row = (await c.query('SELECT j.*,e.*,(j.lease_until>clock_timestamp()) AS live,clock_timestamp() AS observed_now FROM billing.reconciliation_jobs j JOIN billing.webhook_events e ON e.id=j.event_row_id WHERE j.event_row_id=$1 FOR UPDATE OF j', [uuid(claim.eventRowId)])).rows[0];
    ensure(row && row.state === 'leased' && row.live && row.lease_token === claim.leaseToken && row.fence === claim.fence
      && row.stripe_account_id === this.scope.stripeAccountId && row.mode === this.scope.mode
      && date(row.lease_until) === claim.expiresAt && row.attempt_count === claim.attemptCount
      && date(row.first_attempt_at) === claim.firstAttemptAt && date(row.retry_deadline) === claim.retryDeadline
      && billingFingerprint(webhook(row)) === billingFingerprint(claim.event), 'STALE_RECONCILIATION_LEASE', 409);
    return row;
  }
  /** operationId must come from the adapter's verified provider metadata, never an HTTP body ID. */
  async getReconciliationContext(claim: ReconciliationClaim, operationId: string, metadata: VerifiedResourceMetadata): Promise<DispatchContext> {
    return this.transaction(this.pools.dispatcher, async c => {
      const event = await this.ownedReconciliation(c, claim);
      const row = (await c.query(`${operationSelect} WHERE o.id=$1 FOR UPDATE OF o`, [uuid(operationId)])).rows[0];
      ensure(row && row.scope_ref === this.scopeRef && row.first_attempt_at && row.state !== 'failed'
        && expectedObject[row.kind as OperationKind] === event.object_type, 'BILLING_UNBOUND_RESOURCE', 409);
      ensure(row.account_id === metadata.accountId && row.fingerprint === metadata.fingerprint, 'BILLING_RESOURCE_OWNERSHIP', 409);
      if (row.provider_object_id) ensure(row.provider_object_id === event.object_id, 'BILLING_RESOURCE_OWNERSHIP', 409);
      const known = (await c.query('SELECT account_id,operation_id FROM billing.provider_resources WHERE stripe_account_id=$1 AND mode=$2 AND object_type=$3 AND object_id=$4', [this.scope.stripeAccountId, this.scope.mode, event.object_type, event.object_id])).rows[0];
      if (known) ensure(known.account_id === row.account_id && known.operation_id === row.id, 'BILLING_RESOURCE_OWNERSHIP', 409);
      const result = await this.context(c, row);
      if (row.kind !== 'customer_create') ensure(result.customer?.customerId === metadata.customerId, 'BILLING_RESOURCE_OWNERSHIP', 409);
      return result;
    });
  }
  async completeReconciliation(claim: ReconciliationClaim, input: VerifiedOperationResult & { operationId: string }): Promise<void> {
    await this.transaction(this.pools.dispatcher, c => this.completeReconciliationTransaction(c, claim, input));
  }
  async completeInvoiceReconciliation(claim: ReconciliationClaim, input: VerifiedOperationResult & { operationId: string }, proof: VerifiedInvoiceIntent): Promise<{ recoveredFinalizationId: string | null }> {
    ensure(input.objectType === 'invoice' && ['open', 'paid'].includes(input.state), 'BILLING_FINALIZATION_NOT_OBSERVED', 409);
    return this.transaction(this.pools.dispatcher, async c => ({ recoveredFinalizationId: await this.completeReconciliationTransaction(c, claim, input, proof) }));
  }
  private async completeReconciliationTransaction(c: PoolClient, claim: ReconciliationClaim, input: VerifiedOperationResult & { operationId: string }, proof?: VerifiedInvoiceIntent): Promise<string | null> {
      const event = await this.ownedReconciliation(c, claim);
      ensure(input.objectId === event.object_id && input.objectType === event.object_type, 'BILLING_EVENT_RESOURCE_MISMATCH', 409);
      const row = (await c.query(`${operationSelect} WHERE o.id=$1 FOR UPDATE OF o`, [uuid(input.operationId)])).rows[0];
      ensure(row && row.scope_ref === this.scopeRef && row.first_attempt_at && row.state !== 'failed', 'BILLING_UNBOUND_RESOURCE', 409);
      if (row.provider_object_id) ensure(row.provider_object_id === input.objectId, 'BILLING_RESOURCE_OWNERSHIP', 409);
      let finalization: Row | undefined;
      if (proof) {
        ensure(row.kind === 'invoice_create' && row.commercial_intent_id === proof.commercialIntentId
          && row.fingerprint === proof.creationFingerprint, 'BILLING_FINALIZATION_PROOF_MISMATCH', 409);
        const commercial = (await c.query('SELECT fingerprint FROM billing.commercial_intents WHERE account_id=$1 AND id=$2 AND scope_ref=$3', [row.account_id, row.commercial_intent_id, this.scopeRef])).rows[0];
        ensure(commercial?.fingerprint === proof.intentFingerprint, 'BILLING_FINALIZATION_PROOF_MISMATCH', 409);
        // Lock before touching the shared resource so an in-flight finalizer has a consistent lock order.
        finalization = (await c.query(`${operationSelect} WHERE o.account_id=$1 AND o.commercial_intent_id=$2 AND o.kind='invoice_finalize' AND o.scope_ref=$3 AND o.first_attempt_at IS NOT NULL AND o.state IN ('dispatched','unknown') FOR UPDATE OF o`, [row.account_id, row.commercial_intent_id, this.scopeRef])).rows[0];
        if (finalization) {
          ensure(finalization.request_snapshot.invoiceId === input.objectId
            && finalization.request_snapshot.draftOperationId === row.id
            && finalization.request_snapshot.draftFingerprint === row.fingerprint
            && finalization.request_snapshot.customerId === input.binding.customerId,
          'BILLING_FINALIZATION_PROOF_MISMATCH', 409);
          this.validateResult(finalization, input);
        }
      }
      await this.bindResult(c, row, input, event.id);
      await this.finishOperation(c, row, input);
      if (finalization) {
        await this.finishOperation(c, finalization, input);
        await c.query('INSERT INTO billing.resource_observations(id,account_id,operation_id,event_row_id,object_type,object_id,provider_state,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [randomUUID(), row.account_id, finalization.id, event.id, input.objectType, input.objectId, input.state, input.amountMinor ?? null, input.currency ?? null]);
      }
      await c.query("UPDATE billing.reconciliation_jobs SET state='done',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE event_row_id=$1", [claim.eventRowId]);
      return finalization?.id ?? null;
  }
  async holdReconciliation(claim: ReconciliationClaim, reason: ReconciliationReason): Promise<void> {
    ensure(reconciliationReasons.has(reason), 'INVALID_RECONCILIATION_REASON');
    await this.transaction(this.pools.dispatcher, async c => { await this.ownedReconciliation(c, claim); await c.query("UPDATE billing.reconciliation_jobs SET state='held',reason=$2,lease_token=NULL,lease_until=NULL WHERE event_row_id=$1", [claim.eventRowId, reason]); });
  }
  /** Called only for a transient provider GET failure; this never replays a provider write. */
  async retryReconciliation(claim: ReconciliationClaim): Promise<void> {
    await this.transaction(this.pools.dispatcher, async c => {
      const row = await this.ownedReconciliation(c, claim);
      const delay = Math.min(900_000, 5_000 * 2 ** Math.min(row.attempt_count - 1, 20));
      const next = new Date(new Date(date(row.observed_now)).getTime() + delay);
      const reason = row.attempt_count >= reconciliationMaxAttempts ? 'attempt_limit_exceeded'
        : next.getTime() >= Date.parse(claim.retryDeadline) ? 'retry_deadline_exceeded' : null;
      await c.query("UPDATE billing.reconciliation_jobs SET state=$2,next_attempt_at=$3,reason=$4,lease_token=NULL,lease_until=NULL WHERE event_row_id=$1",
        [claim.eventRowId, reason ? 'held' : 'pending', next.toISOString(), reason ?? 'provider_unavailable']);
    });
  }
  async recordCreditNoteObservation(claim: ReconciliationClaim, input: VerifiedCreditNoteObservation): Promise<void> {
    this.assertScope(input.binding.scope);
    ensure(/^cn_[A-Za-z0-9]+$/u.test(input.objectId) && /^in_[A-Za-z0-9]+$/u.test(input.invoiceId)
      && ['issued', 'void'].includes(input.state) && Number.isSafeInteger(input.amountMinor) && input.amountMinor >= 0
      && /^[a-z]{3}$/u.test(input.currency), 'INVALID_CREDIT_NOTE');
    await this.transaction(this.pools.dispatcher, async c => {
      const event = await this.ownedReconciliation(c, claim);
      ensure(event.object_type === 'credit_note' && event.object_id === input.objectId, 'BILLING_EVENT_RESOURCE_MISMATCH', 409);
      const parent = (await c.query("SELECT r.*,b.customer_id FROM billing.provider_resources r JOIN billing.customer_bindings b ON b.account_id=r.account_id AND b.stripe_account_id=r.stripe_account_id AND b.mode=r.mode WHERE r.stripe_account_id=$1 AND r.mode=$2 AND r.object_type='invoice' AND r.object_id=$3", [this.scope.stripeAccountId, this.scope.mode, input.invoiceId])).rows[0];
      ensure(parent && parent.account_id === input.binding.accountId && parent.customer_id === input.binding.customerId
        && parent.scope_ref === this.scopeRef && ['open', 'paid', 'uncollectible'].includes(parent.provider_state)
        && parent.currency === input.currency && parent.amount_minor !== null && BigInt(input.amountMinor) <= BigInt(parent.amount_minor),
      'BILLING_CREDIT_NOTE_OWNERSHIP', 409);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('onesa-credit-note:'||$1||':'||$2||':'||$3,0))", [this.scope.stripeAccountId, this.scope.mode, input.objectId]);
      const old = (await c.query('SELECT * FROM billing.credit_note_observations WHERE stripe_account_id=$1 AND mode=$2 AND credit_note_id=$3 ORDER BY observed_at DESC,event_row_id DESC LIMIT 1', [this.scope.stripeAccountId, this.scope.mode, input.objectId])).rows[0];
      if (old) ensure(old.account_id === input.binding.accountId && old.invoice_id === input.invoiceId
        && old.currency === input.currency && BigInt(old.amount_minor) === BigInt(input.amountMinor)
        && (old.provider_state !== 'void' || input.state === 'void'), 'BILLING_CREDIT_NOTE_CONFLICT', 409);
      await c.query('INSERT INTO billing.credit_note_observations(event_row_id,account_id,parent_operation_id,stripe_account_id,mode,scope_ref,invoice_id,credit_note_id,provider_state,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [claim.eventRowId, input.binding.accountId, parent.operation_id, this.scope.stripeAccountId, this.scope.mode, this.scopeRef, input.invoiceId, input.objectId, input.state, input.amountMinor, input.currency]);
      await c.query("UPDATE billing.reconciliation_jobs SET state='done',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE event_row_id=$1", [claim.eventRowId]);
    });
  }
  async findResourceForReconciliation(event: VerifiedWebhook): Promise<{ accountId: string; operationId: string } | null> {
    ensure(event.stripeAccountId === this.scope.stripeAccountId && event.mode === this.scope.mode, 'BILLING_SCOPE_MISMATCH', 409);
    return this.transaction(this.pools.dispatcher, async c => {
      const row = (await c.query('SELECT account_id,operation_id FROM billing.provider_resources WHERE stripe_account_id=$1 AND mode=$2 AND object_type=$3 AND object_id=$4', [event.stripeAccountId, event.mode, event.objectType, event.objectId])).rows[0];
      return row ? { accountId: row.account_id, operationId: row.operation_id } : null;
    });
  }

  async enqueueUsage(input: PreparedUsageEvent): Promise<{ created: boolean; eventId: string }> {
    const event = validatePreparedUsageEvent(input); this.assertScope(event.scope);
    const body = canonicalBillingJson(event);
    return this.transaction(this.pools.meter, async c => {
      await this.accountLock(c, event.accountId);
      const account = (await c.query('SELECT status FROM billing.accounts WHERE id=$1 AND application=\'company\'', [uuid(event.accountId)])).rows[0];
      ensure(account?.status === 'active', 'BILLING_ACCOUNT_INACTIVE', 409);
      const customer = (await c.query('SELECT customer_id,scope_ref FROM billing.customer_bindings WHERE account_id=$1 AND stripe_account_id=$2 AND mode=$3', [event.accountId, this.scope.stripeAccountId, this.scope.mode])).rows[0];
      ensure(customer?.customer_id === event.binding.stripeCustomerId && customer.scope_ref === this.scopeRef, 'BILLING_USAGE_CUSTOMER_MISMATCH', 409);
      await this.rememberScope(c);
      const id = randomUUID();
      const inserted = await c.query('INSERT INTO billing.usage_events(id,account_id,stripe_account_id,mode,producer_issuer,producer_subject,source_event_id,transaction_id,scope_ref,payload_fingerprint,prepared_event) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(stripe_account_id,mode,producer_issuer,producer_subject,source_event_id) DO NOTHING RETURNING id',
        [id, event.accountId, this.scope.stripeAccountId, this.scope.mode, event.producer.issuer, event.producer.subject, event.sourceEventId, event.transactionId, this.scopeRef, event.payloadFingerprint, body]);
      const old = (await c.query('SELECT id,payload_fingerprint,transaction_id FROM billing.usage_events WHERE stripe_account_id=$1 AND mode=$2 AND producer_issuer=$3 AND producer_subject=$4 AND source_event_id=$5', [this.scope.stripeAccountId, this.scope.mode, event.producer.issuer, event.producer.subject, event.sourceEventId])).rows[0];
      ensure(old.payload_fingerprint === event.payloadFingerprint && old.transaction_id === event.transactionId, 'BILLING_USAGE_CONFLICT', 409);
      await c.query('INSERT INTO billing.usage_outbox(event_id) VALUES($1) ON CONFLICT DO NOTHING', [old.id]);
      return { created: Boolean(inserted.rowCount), eventId: old.id };
    });
  }
  async claimUsage(now: Date, leaseMs: number): Promise<UsageClaim | null> {
    const timestamp = date(now); duration(leaseMs);
    return this.transaction(this.pools.dispatcher, async c => {
      const row = (await c.query("SELECT o.*,e.prepared_event FROM billing.usage_outbox o JOIN billing.usage_events e ON e.id=o.event_id WHERE e.stripe_account_id=$1 AND e.mode=$2 AND ((o.state='pending' AND o.next_attempt_at<=$3) OR (o.state='leased' AND o.lease_until<=$3)) ORDER BY o.next_attempt_at,o.event_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED", [this.scope.stripeAccountId, this.scope.mode, timestamp])).rows[0];
      if (!row) return null;
      const event = validatePreparedUsageEvent(row.prepared_event);
      const first = row.first_attempt_at ? date(row.first_attempt_at) : timestamp;
      const deadline = row.retry_deadline ? date(row.retry_deadline) : usageRetryDeadline(event, first);
      ensure(deadline === usageRetryDeadline(event, first), 'BILLING_USAGE_CUSTODY', 409);
      if (row.state === 'leased') await c.query("UPDATE billing.usage_attempts SET ended_at=$3,outcome='lease_expired',reason='network_or_timeout' WHERE event_id=$1 AND fence=$2 AND ended_at IS NULL", [row.event_id, row.fence, timestamp]);
      if (Date.parse(deadline) <= now.getTime() || row.attempt_count >= USAGE_MAX_ATTEMPTS) {
        await c.query("UPDATE billing.usage_outbox SET state='quarantined',reason=$2,lease_token=NULL,lease_until=NULL WHERE event_id=$1", [row.event_id, row.attempt_count >= USAGE_MAX_ATTEMPTS ? 'attempt_limit_exceeded' : 'retry_deadline_exceeded']);
        return null;
      }
      const token = randomUUID(), expiresAt = new Date(Math.min(now.getTime() + leaseMs, Date.parse(deadline))).toISOString();
      const updated = (await c.query("UPDATE billing.usage_outbox SET state='leased',first_attempt_at=$2,retry_deadline=$3,lease_token=$4,lease_until=$5,fence=fence+1,attempt_count=attempt_count+1,reason=NULL WHERE event_id=$1 RETURNING *", [row.event_id, first, deadline, token, expiresAt])).rows[0];
      await c.query('INSERT INTO billing.usage_attempts(event_id,fence,lease_token,started_at) VALUES($1,$2,$3,$4)', [row.event_id, updated.fence, token, timestamp]);
      return { eventId: row.event_id, leaseToken: token, fence: updated.fence, expiresAt, firstAttemptAt: first, retryDeadline: deadline, attemptCount: updated.attempt_count, event };
    });
  }
  async settleUsage(claim: UsageClaim, outcome: UsageOutcome, now: Date): Promise<void> {
    const timestamp = date(now);
    if (outcome.status !== 'accepted') ensure(usageReasons.has(outcome.reason), 'INVALID_USAGE_OUTCOME');
    await this.transaction(this.pools.dispatcher, async c => {
      const row = (await c.query('SELECT o.*,e.prepared_event FROM billing.usage_outbox o JOIN billing.usage_events e ON e.id=o.event_id WHERE o.event_id=$1 FOR UPDATE OF o', [uuid(claim.eventId)])).rows[0];
      ensure(row && row.state === 'leased' && row.lease_token === claim.leaseToken && row.fence === claim.fence
        && date(row.lease_until) === claim.expiresAt && Date.parse(date(row.lease_until)) > now.getTime()
        && date(row.first_attempt_at) === claim.firstAttemptAt && date(row.retry_deadline) === claim.retryDeadline,
      'STALE_USAGE_LEASE', 409);
      const event = validatePreparedUsageEvent(row.prepared_event);
      ensure(event.payloadFingerprint === claim.event.payloadFingerprint && event.transactionId === claim.event.transactionId
        && event.scope.stripeAccountId === this.scope.stripeAccountId && event.scope.mode === this.scope.mode, 'BILLING_USAGE_CUSTODY', 409);
      if (outcome.status === 'accepted') {
        const acceptedAt = date(outcome.acceptedAt);
        ensure(Date.parse(acceptedAt) >= Date.parse(claim.firstAttemptAt) && Date.parse(acceptedAt) <= now.getTime(), 'INVALID_USAGE_OUTCOME');
        await c.query("UPDATE billing.usage_outbox SET state='accepted',accepted_at=$2,lease_token=NULL,lease_until=NULL,reason=NULL WHERE event_id=$1", [claim.eventId, acceptedAt]);
      } else if (outcome.status === 'retry') {
        const next = date(outcome.nextAttemptAt);
        ensure(Date.parse(next) > now.getTime() && Date.parse(next) < Date.parse(claim.retryDeadline), 'INVALID_USAGE_RETRY');
        await c.query("UPDATE billing.usage_outbox SET state='pending',next_attempt_at=$2,reason=$3,lease_token=NULL,lease_until=NULL WHERE event_id=$1", [claim.eventId, next, outcome.reason]);
      } else {
        await c.query("UPDATE billing.usage_outbox SET state='quarantined',reason=$2,lease_token=NULL,lease_until=NULL WHERE event_id=$1", [claim.eventId, outcome.reason]);
      }
      await c.query('UPDATE billing.usage_attempts SET ended_at=$3,outcome=$4,reason=$5 WHERE event_id=$1 AND fence=$2', [claim.eventId, claim.fence, timestamp, outcome.status, outcome.status === 'accepted' ? null : outcome.reason]);
    });
  }
}
