import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import type { Actor, CatalogLine, ProviderScope, VerifiedWebhook } from '../src/domain.js';
import { BillingStore, verifyStorePoolRoles } from '../src/store.js';
import type { OperationLease, StorePools } from '../src/store.js';
import { createUsageProducerAuthenticator, prepareUsageEvent } from '../src/usage.js';
import type { PreparedUsageEvent, UsageBinding } from '../src/usage.js';

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const SCOPE: ProviderScope = { application: 'company', stripeAccountId: 'acct_storeSynthetic', mode: 'test', configVersion: 'catalog-1' };
const owner: Actor = { issuer: 'https://identity.example.invalid', subject: 'owner-fixture' };
const outsider: Actor = { issuer: 'https://identity.example.invalid', subject: 'other-fixture' };
const lines: CatalogLine[] = [{ item: { sku: 'service', title: 'Synthetic service', version: 'v1', kind: 'one_off',
  priceId: 'price_synthetic', currency: 'eur', unitAmount: 1200, taxBehavior: 'exclusive', maxQuantity: 10 }, quantity: 1 }];
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected);

test('isolated PostgreSQL ownership, concurrency and custody acceptance', { skip: !databaseUrl && 'BILLING_TEST_DATABASE_URL is absent; real PostgreSQL acceptance is not claimed', timeout: 120_000 }, async t => {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only an explicitly local disposable database is permitted');
  assert.match(decodeURIComponent(url.pathname), /_test$/u, 'Refuse any non-test database');
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
  const runtimePools: Pool[] = [], runtimeRoles: string[] = [];
  let migrated = false;
  try {
    const check = (await admin.query("SELECT current_database() AS name,to_regnamespace('billing') IS NULL AS empty")).rows[0];
    assert.equal(check.name, decodeURIComponent(url.pathname.slice(1)));
    assert.equal(check.empty, true, 'Refuse to replace a pre-existing billing schema; use a fresh disposable database');
    await admin.query(await readFile(new URL('../migrations/001_company_billing.sql', import.meta.url), 'utf8'));
    migrated = true;
    const pools = {} as StorePools;
    for (const [name, group] of Object.entries({ api: 'onesa_billing_api', dispatcher: 'onesa_billing_dispatcher', webhook: 'onesa_billing_webhook', meter: 'onesa_billing_meter' })) {
      const role = `billing_test_${name}_${randomBytes(4).toString('hex')}`, password = randomBytes(24).toString('hex');
      // Values are synthetic and generated from fixed alphabets, never credentials from another environment.
      await admin.query(`CREATE ROLE "${role}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}' IN ROLE "${group}"`);
      runtimeRoles.push(role);
      const runtimeUrl = new URL(databaseUrl); runtimeUrl.username = role; runtimeUrl.password = password;
      const pool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 6, connectionTimeoutMillis: 3000 });
      runtimePools.push(pool); pools[name as keyof StorePools] = pool;
    }
    const store = new BillingStore({ scope: SCOPE, pools });
    const freshAccount = () => store.createAccount(owner, { displayName: 'Synthetic customer' });
    async function customer(accountId: string) {
      const prepared = await store.prepareOperation(owner, { accountId, commercialIntentId: accountId, kind: 'customer_create', clientKey: 'customer-create', frozenRequest: { accountId } });
      const lease = await store.claimOperation({ operationId: prepared.operation.id }); assert.ok(lease);
      const binding = { accountId, customerId: id('cus'), scope: SCOPE };
      await store.bindCustomer(lease, binding); return binding;
    }
    async function checkout(accountId: string, key = randomUUID()) {
      const commercial = await store.createCommercialIntent(owner, { accountId, kind: 'checkout', clientKey: key, lines, frozenRequest: { automaticTaxEnabled: false } });
      const prepared = await store.prepareOperation(owner, { accountId, commercialIntentId: commercial.intent.id, kind: 'checkout_create', clientKey: key, frozenRequest: { catalog: commercial.intent.fingerprint } });
      return { commercial, prepared };
    }
    function event(objectId: string, objectType: VerifiedWebhook['objectType'], eventId = id('evt'), createdAt = new Date().toISOString()): VerifiedWebhook {
      return { stripeAccountId: SCOPE.stripeAccountId, mode: 'test', eventId, type: `${objectType}.updated`, objectId,
        objectType, createdAt, bodySha256: '1'.repeat(64), format: 'snapshot' };
    }
    async function usage(accountId: string, customerId: string, sourceEventId = id('business'), quantity = '12.345'): Promise<PreparedUsageEvent> {
      const now = new Date(), selected: UsageBinding = {
        accountId, scope: SCOPE, stripeCustomerId: customerId, metronomeCustomerId: `meter-${accountId}`,
        metronomeProjectId: 'project-test', environment: 'sandbox', contractId: 'contract-test', meterId: 'api-calls',
        eventType: 'api_call', quantityKey: 'units', properties: { service: 'company' },
        periodStart: new Date(now.getTime() - 86_400_000).toISOString(), periodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
        ingestUntil: new Date(now.getTime() + 172_800_000).toISOString(),
      };
      const principal = await createUsageProducerAuthenticator(async () => ({ actor: { issuer: owner.issuer, subject: 'meter-service' },
        accountId, scope: SCOPE, allowedMeterIds: ['api-calls'], expiresAt: new Date(now.getTime() + 3_600_000).toISOString() }))('synthetic-only');
      return prepareUsageEvent({ sourceEventId, meterId: 'api-calls', quantity, occurredAt: new Date(now.getTime() - 1000).toISOString() }, principal, selected, now);
    }

    await t.test('actual runtime logins have exactly the intended roles and no schema/owner authority', async () => {
      await store.verifyRoles();
      for (const pool of runtimePools) {
        await assert.rejects(pool.query('CREATE TABLE billing.forbidden(id integer)'), (e: unknown) => code('42501')(e));
        await assert.rejects(pool.query('DELETE FROM billing.operations'), (e: unknown) => code('42501')(e));
      }
      await assert.rejects(pools.api.query("UPDATE billing.operations SET state='prepared'"), code('42501'));
      await assert.rejects(pools.webhook.query('SELECT * FROM billing.customer_bindings'), code('42501'));
      await assert.rejects(pools.meter.query('SELECT * FROM billing.principals'), code('42501'));
      await assert.rejects(verifyStorePoolRoles({ api: admin, dispatcher: admin, webhook: admin, meter: admin }), code('BILLING_RUNTIME_ROLE_UNVERIFIED'));
      await admin.query(`GRANT onesa_billing_meter TO "${runtimeRoles[0]}"`);
      try { await assert.rejects(store.verifyRoles(), code('BILLING_RUNTIME_ROLE_UNVERIFIED')); }
      finally { await admin.query(`REVOKE onesa_billing_meter FROM "${runtimeRoles[0]}"`); }
    });

    await t.test('account membership uses issuer/subject and never leaks cross-account records', async () => {
      const a = await freshAccount(), b = await store.createAccount(outsider, { displayName: 'Other customer' });
      await assert.rejects(store.getAccountForActor(outsider, a.id), code('BILLING_NOT_FOUND'));
      await assert.rejects(store.getAccountForActor({ issuer: 'https://different.example.invalid', subject: owner.subject }, a.id), code('BILLING_NOT_FOUND'));
      assert.ok((await store.listAccounts(owner)).some(row => row.id === a.id));
      assert.ok(!(await store.listAccounts(owner)).some(row => row.id === b.id));
      await store.setMembership(owner, a.id, 1, { actor: outsider, role: 'viewer', status: 'active' });
      assert.equal((await store.getAccountForActor(outsider, a.id)).role, 'viewer');
      await assert.rejects(store.createCommercialIntent(outsider, { accountId: a.id, kind: 'checkout', clientKey: 'viewer', lines }), code('BILLING_FORBIDDEN'));
    });

    await t.test('competing identical requests create one intent and one immutable provider operation', async () => {
      const a = await freshAccount();
      const intents = await Promise.all(Array.from({ length: 8 }, () => store.createCommercialIntent(owner, { accountId: a.id, kind: 'checkout', clientKey: 'same-intent', lines })));
      assert.equal(intents.filter(row => row.created).length, 1); assert.equal(new Set(intents.map(row => row.intent.id)).size, 1);
      const input = { accountId: a.id, commercialIntentId: intents[0].intent.id, kind: 'checkout_create' as const, clientKey: 'same-operation', frozenRequest: { amountSource: 'catalog' } };
      const operations = await Promise.all(Array.from({ length: 8 }, () => store.prepareOperation(owner, input)));
      assert.equal(operations.filter(row => row.created).length, 1);
      assert.equal(new Set(operations.map(row => row.operation.idempotencyKey)).size, 1);
      const changedKey = await store.prepareOperation(owner, { ...input, clientKey: 'different-browser-key' });
      assert.equal(changedKey.created, false); assert.equal(changedKey.operation.id, operations[0].operation.id);
      await assert.rejects(store.prepareOperation(owner, { ...input, frozenRequest: { amountSource: 'changed' } }), code('BILLING_IDEMPOTENCY_CONFLICT'));
      await assert.rejects(store.createCommercialIntent(owner, { accountId: a.id, kind: 'checkout', clientKey: 'same-intent', lines: [{ ...lines[0], quantity: 2 }] }), code('BILLING_IDEMPOTENCY_CONFLICT'));
      const changed = new BillingStore({ scope: { ...SCOPE, configVersion: 'catalog-2' }, pools });
      await assert.rejects(changed.prepareOperation(owner, input), code('BILLING_SCOPE_MISMATCH'));
      await assert.rejects(admin.query("UPDATE billing.operations SET request_snapshot='{}' WHERE id=$1", [operations[0].operation.id]), code('P0001'));
    });

    await t.test('tenant substitution is refused both by authorization and the composite database FK', async () => {
      const a = await freshAccount(), b = await store.createAccount(outsider, { displayName: 'Other tenant' });
      const { commercial, prepared } = await checkout(a.id);
      await assert.rejects(store.prepareOperation(outsider, { accountId: b.id, commercialIntentId: commercial.intent.id, kind: 'checkout_create', clientKey: 'cross', frozenRequest: {} }), code('BILLING_INTENT_MISMATCH'));
      await assert.rejects(store.getOperation(outsider, prepared.operation.id), code('BILLING_NOT_FOUND'));
      await assert.rejects(pools.api.query("INSERT INTO billing.operations(id,account_id,commercial_intent_id,kind,client_key,idempotency_key,scope_ref,fingerprint,request_snapshot) SELECT $1,$2,commercial_intent_id,kind,'cross-db',$3,scope_ref,fingerprint,'{}' FROM billing.operations WHERE id=$4", [randomUUID(), b.id, id('key'), prepared.operation.id]), code('23503'));
    });

    await t.test('a concurrent owner change cannot remove the last owner', async () => {
      const a = await freshAccount();
      await store.setMembership(owner, a.id, 1, { actor: outsider, role: 'owner', status: 'active' });
      const results = await Promise.allSettled([
        store.setMembership(owner, a.id, 2, { actor: owner, role: 'viewer', status: 'revoked' }),
        store.setMembership(outsider, a.id, 2, { actor: outsider, role: 'viewer', status: 'revoked' }),
      ]);
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM billing.memberships WHERE account_id=$1 AND role='owner' AND status='active'", [a.id])).rows[0].count, 1);
      const remaining = results[0].status === 'fulfilled' ? outsider : owner;
      await assert.rejects(store.setMembership(remaining, a.id, 3, { actor: remaining, role: 'viewer', status: 'revoked' }), code('LAST_BILLING_OWNER'));
    });

    await t.test('one worker owns the dispatch; expiry preserves an unknown outcome and the original key', async () => {
      const a = await freshAccount();
      const prepared = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: a.id, kind: 'customer_create', clientKey: 'dispatch', frozenRequest: {} });
      const claims = await Promise.all([store.claimOperation({ operationId: prepared.operation.id }), store.claimOperation({ operationId: prepared.operation.id })]);
      assert.equal(claims.filter(Boolean).length, 1);
      const lease = claims.find(Boolean) as OperationLease;
      assert.equal((await store.getDispatchContext(lease)).customer, null);
      await admin.query("UPDATE billing.operations SET lease_until=now()-interval '1 second' WHERE id=$1", [prepared.operation.id]);
      await assert.rejects(store.bindCustomer(lease, { accountId: a.id, customerId: id('cus'), scope: SCOPE }), code('STALE_BILLING_LEASE'));
      assert.equal(await store.claimOperation({ operationId: prepared.operation.id }), null);
      const unknown = await store.getOperation(owner, prepared.operation.id);
      assert.equal(unknown.state, 'unknown'); assert.equal(unknown.firstAttemptAt, lease.operation.firstAttemptAt);
      const retry = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: a.id, kind: 'customer_create', clientKey: 'new-key-after-loss', frozenRequest: {} });
      assert.equal(retry.operation.idempotencyKey, prepared.operation.idempotencyKey); assert.equal(retry.operation.state, 'unknown');
    });

    await t.test('background dispatch excludes one-time portal sessions while their explicit caller can claim once', async () => {
      const portalStore = new BillingStore({ scope: { ...SCOPE, configVersion: 'portal-sync-only' }, pools });
      const account = await portalStore.createAccount(owner, { displayName: 'Synchronous portal fixture' });
      const commercial = await portalStore.createCommercialIntent(owner, { accountId: account.id, kind: 'portal', clientKey: 'portal', lines: [] });
      const prepared = await portalStore.prepareOperation(owner, { accountId: account.id, commercialIntentId: commercial.intent.id, kind: 'portal_create', clientKey: 'portal', frozenRequest: {} });
      assert.equal(await portalStore.claimOperation(), null);
      assert.equal((await portalStore.getOperation(owner, prepared.operation.id)).state, 'prepared');
      const explicit = await portalStore.claimOperation({ operationId: prepared.operation.id }); assert.ok(explicit);
      assert.equal(explicit.operation.kind, 'portal_create');
      assert.equal(await portalStore.claimOperation({ operationId: prepared.operation.id }), null);
      await portalStore.holdOperation(explicit, 'provider_timeout');
    });

    await t.test('lost customer response can reconcile from verified metadata without resetting the original failed attempt', async () => {
      const a = await freshAccount(), customerId = id('cus');
      const prepared = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: a.id, kind: 'customer_create', clientKey: 'lost', frozenRequest: { accountId: a.id } });
      const lease = await store.claimOperation({ operationId: prepared.operation.id }); assert.ok(lease);
      await store.holdOperation(lease, 'provider_timeout');
      const received = await store.acceptWebhook(event(customerId, 'customer'));
      const claim = await store.claimReconciliation(); assert.ok(claim); assert.equal(claim.eventRowId, received.eventRowId);
      await assert.rejects(store.getReconciliationContext(claim, prepared.operation.id, { accountId: randomUUID(), fingerprint: prepared.operation.fingerprint }), code('BILLING_RESOURCE_OWNERSHIP'));
      const context = await store.getReconciliationContext(claim, prepared.operation.id, { accountId: a.id, fingerprint: prepared.operation.fingerprint, customerId });
      assert.equal(context.operation.state, 'unknown'); assert.equal(context.customer, null);
      await store.completeReconciliation(claim, { operationId: prepared.operation.id, binding: { accountId: a.id, customerId, scope: SCOPE }, objectType: 'customer', objectId: customerId, state: 'created' });
      assert.equal((await store.getOperation(owner, prepared.operation.id)).state, 'succeeded');
      assert.equal((await store.getCustomer(owner, a.id))?.customerId, customerId);
      assert.equal((await admin.query('SELECT outcome FROM billing.operation_attempts WHERE operation_id=$1', [prepared.operation.id])).rows[0].outcome, 'unknown');
    });

    await t.test('competing account bindings cannot adopt the same provider checkout', async () => {
      const a = await freshAccount(), b = await freshAccount();
      const ca = await customer(a.id), cb = await customer(b.id);
      const pa = await checkout(a.id), pb = await checkout(b.id);
      const la = await store.claimOperation({ operationId: pa.prepared.operation.id }), lb = await store.claimOperation({ operationId: pb.prepared.operation.id });
      assert.ok(la); assert.ok(lb); const objectId = id('cs');
      const results = await Promise.allSettled([
        store.completeOperation(la, { binding: ca, objectId, objectType: 'checkout.session', state: 'open.unpaid', amountMinor: 1200, currency: 'eur' }),
        store.completeOperation(lb, { binding: cb, objectId, objectType: 'checkout.session', state: 'open.unpaid', amountMinor: 1200, currency: 'eur' }),
      ]);
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      const winner = results[0].status === 'fulfilled' ? a : b, losing = results[0].status === 'fulfilled' ? lb : la;
      assert.equal((await admin.query('SELECT account_id FROM billing.provider_resources WHERE object_id=$1', [objectId])).rows[0].account_id, winner.id);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.resource_observations WHERE object_id=$1', [objectId])).rows[0].count, 1);
      await store.holdOperation(losing, 'result_unverified');
    });

    await t.test('webhook dedupe and reordered observations preserve paid state and immutable event custody', async () => {
      const a = await freshAccount(), binding = await customer(a.id), selected = await checkout(a.id), objectId = id('cs');
      const lease = await store.claimOperation({ operationId: selected.prepared.operation.id }); assert.ok(lease);
      await store.completeOperation(lease, { binding, objectId, objectType: 'checkout.session', state: 'open.unpaid', amountMinor: 1200, currency: 'eur' });
      const newest = event(objectId, 'checkout.session');
      const duplicates = await Promise.all(Array.from({ length: 6 }, () => store.acceptWebhook(newest)));
      assert.equal(duplicates.filter(row => row.created).length, 1);
      await assert.rejects(store.acceptWebhook({ ...newest, bodySha256: '2'.repeat(64) }), code('BILLING_EVENT_CONFLICT'));
      const claim = await store.claimReconciliation(); assert.ok(claim);
      await store.getReconciliationContext(claim, selected.prepared.operation.id, { accountId: a.id, fingerprint: selected.prepared.operation.fingerprint, customerId: binding.customerId });
      await store.completeReconciliation(claim, { operationId: selected.prepared.operation.id, binding, objectId, objectType: 'checkout.session', state: 'complete.paid', amountMinor: 1200, currency: 'eur' });
      await store.acceptWebhook(event(objectId, 'checkout.session', id('evt'), new Date(Date.now() - 86_400_000).toISOString()));
      const older = await store.claimReconciliation(); assert.ok(older);
      // The adapter's fresh retrieval remains paid even when the triggering event is older.
      await store.completeReconciliation(older, { operationId: selected.prepared.operation.id, binding, objectId, objectType: 'checkout.session', state: 'complete.paid', amountMinor: 1200, currency: 'eur' });
      await store.acceptWebhook(event(objectId, 'checkout.session'));
      const stale = await store.claimReconciliation(); assert.ok(stale);
      await assert.rejects(store.completeReconciliation(stale, { operationId: selected.prepared.operation.id, binding, objectId, objectType: 'checkout.session', state: 'open.unpaid', amountMinor: 1200, currency: 'eur' }), code('BILLING_TERMINAL_STATE_CONFLICT'));
      await store.holdReconciliation(stale, 'ownership_mismatch');
      assert.equal((await admin.query('SELECT provider_state FROM billing.provider_resources WHERE object_id=$1', [objectId])).rows[0].provider_state, 'complete.paid');
      await assert.rejects(pools.dispatcher.query("UPDATE billing.provider_resources SET provider_state='open.unpaid' WHERE object_id=$1", [objectId]), code('P0001'));
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.reconciliation_jobs j JOIN billing.webhook_events e ON e.id=j.event_row_id WHERE e.event_id=$1', [newest.eventId])).rows[0].count, 1);
    });

    await t.test('transient provider GET outage retries the same immutable event and recovers without replaying a write', async () => {
      const a = await freshAccount(), binding = await customer(a.id), selected = await checkout(a.id), objectId = id('cs');
      const lease = await store.claimOperation({ operationId: selected.prepared.operation.id }); assert.ok(lease);
      await store.completeOperation(lease, { binding, objectId, objectType: 'checkout.session', state: 'open.unpaid', amountMinor: 1200, currency: 'eur' });
      const received = await store.acceptWebhook(event(objectId, 'checkout.session'));
      const before = (await admin.query('SELECT * FROM billing.webhook_events WHERE id=$1', [received.eventRowId])).rows[0];
      const first = await store.claimReconciliation(); assert.ok(first); assert.equal(first.attemptCount, 1);
      assert.equal(Date.parse(first.retryDeadline) - Date.parse(first.firstAttemptAt), 86_400_000);
      await store.retryReconciliation(first);
      assert.equal(await store.claimReconciliation(), null, 'A retry cannot run before its durable delay');
      const queued = (await admin.query('SELECT *,extract(epoch FROM (next_attempt_at-clock_timestamp()))*1000 AS remaining_ms FROM billing.reconciliation_jobs WHERE event_row_id=$1', [first.eventRowId])).rows[0];
      assert.equal(queued.state, 'pending'); assert.equal(queued.reason, 'provider_unavailable');
      assert.ok(Number(queued.remaining_ms) > 3000 && Number(queued.remaining_ms) <= 5000);
      assert.equal(await store.claimOperation({ operationId: selected.prepared.operation.id }), null);
      await admin.query('UPDATE billing.reconciliation_jobs SET next_attempt_at=clock_timestamp() WHERE event_row_id=$1', [first.eventRowId]);
      const second = await store.claimReconciliation(); assert.ok(second);
      assert.equal(second.eventRowId, first.eventRowId); assert.deepEqual(second.event, first.event);
      assert.equal(second.firstAttemptAt, first.firstAttemptAt); assert.equal(second.retryDeadline, first.retryDeadline);
      assert.equal(second.attemptCount, 2); assert.equal(second.fence, first.fence + 1);
      await assert.rejects(pools.dispatcher.query("UPDATE billing.reconciliation_jobs SET first_attempt_at=first_attempt_at+interval '1 second',retry_deadline=retry_deadline+interval '1 second' WHERE event_row_id=$1", [first.eventRowId]), code('P0001'));
      await store.completeReconciliation(second, { operationId: selected.prepared.operation.id, binding, objectId, objectType: 'checkout.session', state: 'complete.paid', amountMinor: 1200, currency: 'eur' });
      assert.equal((await admin.query('SELECT state,attempt_count FROM billing.reconciliation_jobs WHERE event_row_id=$1', [first.eventRowId])).rows[0].state, 'done');
      assert.deepEqual((await admin.query('SELECT * FROM billing.webhook_events WHERE id=$1', [received.eventRowId])).rows[0], before);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.operation_attempts WHERE operation_id=$1', [selected.prepared.operation.id])).rows[0].count, 1);
    });

    await t.test('expired reconciliation leases cannot schedule retries or release ownership holds', async () => {
      const received = await store.acceptWebhook(event(id('cs'), 'checkout.session'));
      const first = await store.claimReconciliation(100); assert.ok(first);
      await new Promise(resolve => setTimeout(resolve, 130));
      const second = await store.claimReconciliation(); assert.ok(second);
      assert.equal(second.eventRowId, received.eventRowId); assert.equal(second.fence, first.fence + 1);
      assert.equal(second.firstAttemptAt, first.firstAttemptAt); assert.equal(second.retryDeadline, first.retryDeadline);
      await assert.rejects(store.retryReconciliation(first), code('STALE_RECONCILIATION_LEASE'));
      await assert.rejects(store.retryReconciliation({ ...second, attemptCount: 1 }), code('STALE_RECONCILIATION_LEASE'));
      await store.holdReconciliation(second, 'ownership_mismatch');
      await assert.rejects(store.retryReconciliation(second), code('STALE_RECONCILIATION_LEASE'));
      await store.acceptWebhook(second.event);
      assert.equal(await store.claimReconciliation(), null, 'Duplicate delivery cannot release a nontransient hold');
      await assert.rejects(pools.dispatcher.query("UPDATE billing.reconciliation_jobs SET state='pending' WHERE event_row_id=$1", [second.eventRowId]), code('P0001'));
    });

    await t.test('GET reconciliation backoff caps at fifteen minutes and exhausted attempt/time budgets remain held', async () => {
      const attempts = await store.acceptWebhook(event(id('cs'), 'checkout.session'));
      await admin.query("UPDATE billing.reconciliation_jobs SET first_attempt_at=date_trunc('milliseconds',now()),retry_deadline=date_trunc('milliseconds',now())+interval '24 hours',attempt_count=38,fence=38 WHERE event_row_id=$1", [attempts.eventRowId]);
      const penultimate = await store.claimReconciliation(); assert.ok(penultimate); assert.equal(penultimate.attemptCount, 39);
      await store.retryReconciliation(penultimate);
      const delayed = (await admin.query('SELECT state,extract(epoch FROM (next_attempt_at-clock_timestamp()))*1000 AS remaining_ms FROM billing.reconciliation_jobs WHERE event_row_id=$1', [attempts.eventRowId])).rows[0];
      assert.equal(delayed.state, 'pending'); assert.ok(Number(delayed.remaining_ms) > 898_000 && Number(delayed.remaining_ms) <= 900_000);
      await admin.query('UPDATE billing.reconciliation_jobs SET next_attempt_at=clock_timestamp() WHERE event_row_id=$1', [attempts.eventRowId]);
      const last = await store.claimReconciliation(); assert.ok(last); assert.equal(last.attemptCount, 40);
      await store.retryReconciliation(last);
      const held = (await admin.query('SELECT state,reason,attempt_count FROM billing.reconciliation_jobs WHERE event_row_id=$1', [last.eventRowId])).rows[0];
      assert.deepEqual(held, { state: 'held', reason: 'attempt_limit_exceeded', attempt_count: 40 });
      const overdue = await store.acceptWebhook(event(id('cs'), 'checkout.session'));
      await admin.query("UPDATE billing.reconciliation_jobs SET first_attempt_at=date_trunc('milliseconds',now())-interval '25 hours',retry_deadline=date_trunc('milliseconds',now())-interval '1 hour',attempt_count=1,fence=1 WHERE event_row_id=$1", [overdue.eventRowId]);
      assert.equal(await store.claimReconciliation(), null);
      const expired = (await admin.query('SELECT state,reason,attempt_count FROM billing.reconciliation_jobs WHERE event_row_id=$1', [overdue.eventRowId])).rows[0];
      assert.deepEqual(expired, { state: 'held', reason: 'retry_deadline_exceeded', attempt_count: 1 });
      await store.acceptWebhook(last.event);
      assert.equal(await store.claimReconciliation(), null, 'A fresh duplicate signature cannot reset an exhausted budget');
    });

    await t.test('metered items cannot enter checkout/manual invoices and unattempted finalization is not completed by creation metadata', async () => {
      const a = await freshAccount(), binding = await customer(a.id);
      await assert.rejects(store.createCommercialIntent(owner, { accountId: a.id, kind: 'invoice', clientKey: 'metered', lines: [{ item: { ...lines[0].item, kind: 'metered' }, quantity: 1 }] }), code('METERED_MANUAL_BILLING_FORBIDDEN'));
      const commercial = await store.createCommercialIntent(owner, { accountId: a.id, kind: 'invoice', clientKey: 'draft', lines });
      const created = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: commercial.intent.id, kind: 'invoice_create', clientKey: 'draft', frozenRequest: {} });
      const lease = await store.claimOperation({ operationId: created.operation.id }); assert.ok(lease); const invoiceId = id('in');
      await store.completeOperation(lease, { binding, objectId: invoiceId, objectType: 'invoice', state: 'draft', amountMinor: 1200, currency: 'eur' });
      const finalize = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: commercial.intent.id, kind: 'invoice_finalize', clientKey: 'finalize', frozenRequest: { invoiceId, customerId: binding.customerId, draftOperationId: created.operation.id, draftFingerprint: created.operation.fingerprint } });
      await store.acceptWebhook(event(invoiceId, 'invoice'));
      const claim = await store.claimReconciliation(); assert.ok(claim);
      await store.getReconciliationContext(claim, created.operation.id, { accountId: a.id, fingerprint: created.operation.fingerprint, customerId: binding.customerId });
      await assert.rejects(store.getReconciliationContext(claim, finalize.operation.id, { accountId: a.id, fingerprint: finalize.operation.fingerprint, customerId: binding.customerId }), code('BILLING_UNBOUND_RESOURCE'));
      const recovery = await store.completeInvoiceReconciliation(claim, { operationId: created.operation.id, binding, objectId: invoiceId, objectType: 'invoice', state: 'open', amountMinor: 1200, currency: 'eur' },
        { commercialIntentId: commercial.intent.id, creationFingerprint: created.operation.fingerprint, intentFingerprint: commercial.intent.fingerprint });
      assert.equal(recovery.recoveredFinalizationId, null);
      assert.equal((await store.getOperation(owner, finalize.operation.id)).state, 'prepared');
    });

    await t.test('fresh exact invoice proof resolves only its attempted linked finalization and preserves uncertainty history', async () => {
      const a = await freshAccount(), binding = await customer(a.id);
      const commercial = await store.createCommercialIntent(owner, { accountId: a.id, kind: 'invoice', clientKey: 'recover-draft', lines });
      const created = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: commercial.intent.id, kind: 'invoice_create', clientKey: 'draft', frozenRequest: { customerId: binding.customerId } });
      const creationLease = await store.claimOperation({ operationId: created.operation.id }); assert.ok(creationLease); const invoiceId = id('in');
      await store.completeOperation(creationLease, { binding, objectId: invoiceId, objectType: 'invoice', state: 'draft', amountMinor: 1200, currency: 'eur' });
      const finalize = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: commercial.intent.id, kind: 'invoice_finalize', clientKey: 'finalize',
        frozenRequest: { invoiceId, customerId: binding.customerId, draftOperationId: created.operation.id, draftFingerprint: created.operation.fingerprint } });
      const finalizationLease = await store.claimOperation({ operationId: finalize.operation.id }); assert.ok(finalizationLease);
      await store.holdOperation(finalizationLease, 'provider_timeout');
      await store.acceptWebhook(event(invoiceId, 'invoice'));
      const claim = await store.claimReconciliation(); assert.ok(claim);
      const verified = { operationId: created.operation.id, binding, objectId: invoiceId, objectType: 'invoice' as const, state: 'open', amountMinor: 1200, currency: 'eur' };
      const proof = { commercialIntentId: commercial.intent.id, creationFingerprint: created.operation.fingerprint, intentFingerprint: commercial.intent.fingerprint };
      await assert.rejects(store.completeInvoiceReconciliation(claim, verified, { ...proof, creationFingerprint: '0'.repeat(64) }), code('BILLING_FINALIZATION_PROOF_MISMATCH'));
      assert.equal((await store.getOperation(owner, finalize.operation.id)).state, 'unknown');
      assert.deepEqual(await store.completeInvoiceReconciliation(claim, verified, proof), { recoveredFinalizationId: finalize.operation.id });
      const completed = await store.getOperation(owner, finalize.operation.id);
      assert.equal(completed.state, 'succeeded'); assert.equal(completed.firstAttemptAt, finalizationLease.operation.firstAttemptAt);
      assert.equal((await admin.query('SELECT outcome FROM billing.operation_attempts WHERE operation_id=$1', [finalize.operation.id])).rows[0].outcome, 'unknown');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.resource_observations WHERE event_row_id=$1', [claim.eventRowId])).rows[0].count, 2);
      assert.equal((await admin.query('SELECT operation_id FROM billing.provider_resources WHERE object_id=$1', [invoiceId])).rows[0].operation_id, created.operation.id);
    });

    await t.test('credit notes require the bound invoice/customer and append adjustments without changing payment commands', async () => {
      const a = await freshAccount(), binding = await customer(a.id);
      const commercial = await store.createCommercialIntent(owner, { accountId: a.id, kind: 'invoice', clientKey: 'credit-parent', lines });
      const created = await store.prepareOperation(owner, { accountId: a.id, commercialIntentId: commercial.intent.id, kind: 'invoice_create', clientKey: 'credit-parent', frozenRequest: {} });
      const lease = await store.claimOperation({ operationId: created.operation.id }); assert.ok(lease); const invoiceId = id('in'), noteId = id('cn');
      await store.completeOperation(lease, { binding, objectId: invoiceId, objectType: 'invoice', state: 'open', amountMinor: 1200, currency: 'eur' });
      const before = await store.getOperation(owner, created.operation.id);
      await store.acceptWebhook(event(noteId, 'credit_note'));
      const issued = await store.claimReconciliation(); assert.ok(issued);
      const observation = { binding, objectId: noteId, invoiceId, state: 'issued' as const, amountMinor: 300, currency: 'eur' };
      await assert.rejects(store.recordCreditNoteObservation(issued, { ...observation, binding: { ...binding, accountId: randomUUID() } }), code('BILLING_CREDIT_NOTE_OWNERSHIP'));
      await assert.rejects(store.recordCreditNoteObservation(issued, { ...observation, amountMinor: 1201 }), code('BILLING_CREDIT_NOTE_OWNERSHIP'));
      await store.recordCreditNoteObservation(issued, observation);
      assert.deepEqual(await store.getOperation(owner, created.operation.id), before);
      await store.acceptWebhook(event(noteId, 'credit_note'));
      const voided = await store.claimReconciliation(); assert.ok(voided);
      await store.recordCreditNoteObservation(voided, { ...observation, state: 'void' });
      await store.acceptWebhook(event(noteId, 'credit_note'));
      const stale = await store.claimReconciliation(); assert.ok(stale);
      await assert.rejects(store.recordCreditNoteObservation(stale, observation), code('BILLING_CREDIT_NOTE_CONFLICT'));
      await store.holdReconciliation(stale, 'ownership_mismatch');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.credit_note_observations WHERE credit_note_id=$1', [noteId])).rows[0].count, 2);
      await assert.rejects(admin.query('DELETE FROM billing.credit_note_observations WHERE credit_note_id=$1', [noteId]), code('P0001'));
    });

    await t.test('usage duplicates create one outbox item and cannot be rebound to another tenant', async () => {
      const a = await freshAccount(), binding = await customer(a.id), prepared = await usage(a.id, binding.customerId);
      const results = await Promise.all(Array.from({ length: 8 }, () => store.enqueueUsage(prepared)));
      assert.equal(results.filter(row => row.created).length, 1); assert.equal(new Set(results.map(row => row.eventId)).size, 1);
      await assert.rejects(store.enqueueUsage({ ...prepared, payloadFingerprint: '0'.repeat(64) }), code('USAGE_PAYLOAD_INTEGRITY'));
      const b = await freshAccount(), otherCustomer = await customer(b.id);
      const rebound = await usage(b.id, otherCustomer.customerId, prepared.sourceEventId);
      await assert.rejects(store.enqueueUsage(rebound), code('BILLING_USAGE_CONFLICT'));
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.usage_events WHERE source_event_id=$1', [prepared.sourceEventId])).rows[0].count, 1);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.usage_outbox WHERE event_id=$1', [results[0].eventId])).rows[0].count, 1);
    });

    await t.test('usage workers fence expired claims and keep the exact original transaction/first attempt across retries', async () => {
      const now = new Date(Date.now() + 10_000);
      const claims = await Promise.all([store.claimUsage(now, 1000), store.claimUsage(now, 1000)]);
      assert.equal(claims.filter(Boolean).length, 1); const first = claims.find(Boolean); assert.ok(first);
      const later = new Date(now.getTime() + 2000), second = await store.claimUsage(later, 1000); assert.ok(second);
      assert.equal(second.event.transactionId, first.event.transactionId); assert.equal(second.firstAttemptAt, first.firstAttemptAt);
      assert.equal(second.retryDeadline, first.retryDeadline); assert.equal(second.fence, first.fence + 1);
      await assert.rejects(store.settleUsage(first, { status: 'accepted', acceptedAt: later.toISOString() }, later), code('STALE_USAGE_LEASE'));
      const finish = new Date(later.getTime() + 1);
      await store.settleUsage(second, { status: 'accepted', acceptedAt: finish.toISOString() }, finish);
      assert.equal(await store.claimUsage(new Date(finish.getTime() + 1), 1000), null);
      assert.equal((await admin.query('SELECT state FROM billing.usage_outbox WHERE event_id=$1', [first.eventId])).rows[0].state, 'accepted');
      await assert.rejects(pools.dispatcher.query("UPDATE billing.usage_outbox SET first_attempt_at=first_attempt_at+interval '1 second' WHERE event_id=$1", [first.eventId]), code('P0001'));
      await assert.rejects(pools.dispatcher.query("UPDATE billing.usage_outbox SET state='pending' WHERE event_id=$1", [first.eventId]), code('P0001'));
      const oldAttempt = (await admin.query('SELECT outcome FROM billing.usage_attempts WHERE event_id=$1 AND fence=$2', [first.eventId, first.fence])).rows[0];
      assert.equal(oldAttempt.outcome, 'lease_expired');
      await assert.rejects(admin.query("UPDATE billing.usage_attempts SET outcome='accepted' WHERE event_id=$1 AND fence=$2", [first.eventId, first.fence]), code('P0001'));
    });

    await t.test('an event beyond its fixed period/deadline is quarantined without dispatch', async () => {
      const a = await freshAccount(), binding = await customer(a.id), prepared = await usage(a.id, binding.customerId);
      const queued = await store.enqueueUsage(prepared);
      assert.equal(await store.claimUsage(new Date(Date.parse(prepared.binding.ingestUntil) + 1), 1000), null);
      const row = (await admin.query('SELECT state,reason,first_attempt_at FROM billing.usage_outbox WHERE event_id=$1', [queued.eventId])).rows[0];
      assert.equal(row.state, 'quarantined'); assert.equal(row.reason, 'retry_deadline_exceeded'); assert.equal(row.first_attempt_at, null);
    });

    await t.test('closure preserves financial and unresolved records while preventing new operations', async () => {
      const a = await freshAccount(); const binding = await customer(a.id); const pending = await checkout(a.id);
      const queued = await store.enqueueUsage(await usage(a.id, binding.customerId));
      await store.closeAccount(owner, a.id, 1);
      assert.equal((await store.getAccountForActor(owner, a.id)).status, 'closed');
      assert.equal((await store.getOperation(owner, pending.prepared.operation.id)).state, 'prepared');
      assert.equal(await store.claimOperation({ operationId: pending.prepared.operation.id }), null);
      await assert.rejects(store.createCommercialIntent(owner, { accountId: a.id, kind: 'checkout', clientKey: 'closed', lines }), code('BILLING_ACCOUNT_INACTIVE'));
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.customer_bindings WHERE account_id=$1', [a.id])).rows[0].count, 1);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM billing.usage_events WHERE id=$1', [queued.eventId])).rows[0].count, 1);
      // PostgreSQL 17 reports this RESTRICT failure as 23503; PostgreSQL 18 uses 23001.
      await assert.rejects(admin.query('DELETE FROM billing.accounts WHERE id=$1', [a.id]),
        (error: unknown) => code('23001')(error) || code('23503')(error));
      assert.equal((await admin.query('SELECT status FROM billing.accounts WHERE id=$1', [a.id])).rows[0]?.status, 'closed');
    });
  } finally {
    for (const pool of runtimePools) await pool.end();
    if (migrated) await admin.query('DROP SCHEMA billing CASCADE');
    for (const role of runtimeRoles) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  }
});
