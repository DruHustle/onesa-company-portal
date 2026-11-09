import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderScope } from '../src/domain.js';
import {
  canonicalUsageQuantity, canonicalUsageTimestamp, createUsageProducerAuthenticator, exportNextUsage,
  prepareUsageEvent, PreparedUsageEvent, UsageBinding, UsageClaim, UsageDeliveryResult, UsageExportStore,
  UsageOutcome, usageRetryDeadline, USAGE_FUTURE_SKEW_MS, USAGE_MAX_ATTEMPTS, USAGE_SAFE_WINDOW_MS,
  validatePreparedUsageEvent, VerifiedUsageProducer,
} from '../src/usage.js';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const SCOPE: ProviderScope = { application: 'company', stripeAccountId: 'acct_companyTest', mode: 'test', configVersion: 'catalog-1' };

function binding(overrides: Partial<UsageBinding> = {}): UsageBinding {
  return {
    accountId: 'company-customer-1', scope: { ...SCOPE }, stripeCustomerId: 'cus_companyTest',
    metronomeCustomerId: 'meter-customer-1', metronomeProjectId: 'meter-project-1', environment: 'sandbox',
    contractId: 'contract-1', meterId: 'api-requests', eventType: 'api_request', quantityKey: 'units',
    properties: { service: 'api' }, periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z',
    ingestUntil: '2026-12-02T00:00:00.000Z', ...overrides,
  };
}

async function producer(selected = binding(), expiresAt = '2026-11-08T11:00:00.000Z'): Promise<VerifiedUsageProducer> {
  return createUsageProducerAuthenticator(async (credential) => credential === 'synthetic-producer-token' ? {
    actor: { issuer: 'https://issuer.example.invalid', subject: 'service-usage-1' },
    accountId: selected.accountId, scope: selected.scope, allowedMeterIds: [selected.meterId], expiresAt,
  } : null)('synthetic-producer-token');
}

async function event(overrides: Record<string, unknown> = {}, selected = binding(), now = NOW): Promise<PreparedUsageEvent> {
  return prepareUsageEvent({ sourceEventId: 'business-event-1', meterId: 'api-requests', quantity: '12.3400',
    occurredAt: '2026-11-08T09:59:00.000Z', ...overrides }, await producer(selected), selected, now);
}

function claim(eventValue: PreparedUsageEvent, now = NOW, overrides: Partial<UsageClaim> = {}): UsageClaim {
  return { eventId: 'usage-record-1', leaseToken: 'lease-1', fence: 1, expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    firstAttemptAt: NOW.toISOString(), retryDeadline: usageRetryDeadline(eventValue, NOW.toISOString()),
    attemptCount: 1, event: eventValue, ...overrides };
}

function fixtureStore(selected: UsageClaim, journal: string[] = []): UsageExportStore & { outcomes: UsageOutcome[] } {
  const outcomes: UsageOutcome[] = [];
  return {
    outcomes,
    async enqueueUsage(value) { validatePreparedUsageEvent(value); return { created: true, eventId: selected.eventId }; },
    async claimUsage() { journal.push('attempt-persisted'); return selected; },
    async settleUsage(actual, outcome) {
      assert.equal(actual.leaseToken, selected.leaseToken);
      assert.equal(actual.fence, selected.fence);
      journal.push('settled'); outcomes.push(outcome);
    },
  };
}

test('decimal validation preserves precision and rejects numeric/coercible or exponent input', () => {
  assert.equal(canonicalUsageQuantity('9007199254740993.123456789012345678'), '9007199254740993.123456789012345678');
  assert.equal(canonicalUsageQuantity('12.3400'), '12.34');
  assert.equal(canonicalUsageQuantity('0.000'), '0');
  for (const value of [1, NaN, Infinity, '-1', '+1', '1e3', '01', ' 1', '1.', '.1', '1.1234567890123456789', {}]) {
    assert.throws(() => canonicalUsageQuantity(value), /INVALID_USAGE_QUANTITY/u);
  }
  assert.equal(canonicalUsageTimestamp('2026-11-08T10:00:00Z'), NOW.toISOString());
  assert.throws(() => canonicalUsageTimestamp('2026-02-30T10:00:00Z'), /INVALID_USAGE_TIMESTAMP/u);
  assert.throws(() => canonicalUsageTimestamp('2026-11-08T10:00:00+00:00'), /INVALID_USAGE_TIMESTAMP/u);
});

test('producer identity is opaque, verified, scoped, expiring and not supplied by the request', async () => {
  const selected = binding();
  const input = { sourceEventId: 'event-1', meterId: 'api-requests', quantity: '1', occurredAt: NOW.toISOString() };
  assert.throws(() => prepareUsageEvent(input, {} as VerifiedUsageProducer, selected, NOW), /USAGE_PRODUCER_UNAUTHORIZED/u);
  await assert.rejects(createUsageProducerAuthenticator(async () => null)('synthetic'), /USAGE_PRODUCER_UNAUTHORIZED/u);
  const principal = await producer(selected);
  assert.deepEqual(Object.keys(principal), []);
  assert.throws(() => prepareUsageEvent({ ...input, accountId: 'other' }, principal, selected, NOW), /INVALID_USAGE/u);
  assert.throws(() => prepareUsageEvent(input, principal, binding({ accountId: 'other' }), NOW), /USAGE_PRODUCER_FORBIDDEN/u);
  assert.throws(() => prepareUsageEvent(input, principal, binding({ scope: { ...SCOPE, configVersion: 'catalog-2' } }), NOW), /USAGE_PRODUCER_FORBIDDEN/u);
  const expired = await producer(selected, NOW.toISOString());
  assert.throws(() => prepareUsageEvent(input, expired, selected, NOW), /USAGE_PRODUCER_EXPIRED/u);
});

test('stable transaction IDs survive retry/config changes and exact commercial fingerprints detect rebinding', async () => {
  const first = await event();
  const duplicate = await event({ quantity: '12.34' }, binding(), new Date(NOW.getTime() + 5_000));
  assert.equal(first.transactionId, duplicate.transactionId);
  assert.equal(first.payloadFingerprint, duplicate.payloadFingerprint);
  assert.notEqual(first.recordedAt, duplicate.recordedAt);
  assert.equal(first.transactionId.length, 70);
  assert.ok(!first.transactionId.includes(first.sourceEventId));
  const quantityChanged = await event({ quantity: '13' });
  assert.equal(first.transactionId, quantityChanged.transactionId);
  assert.notEqual(first.payloadFingerprint, quantityChanged.payloadFingerprint);
  const configChanged = await event({}, binding({ scope: { ...SCOPE, configVersion: 'catalog-2' } }));
  assert.equal(first.transactionId, configChanged.transactionId);
  assert.notEqual(first.payloadFingerprint, configChanged.payloadFingerprint);
  assert.equal(first.payload.properties.units, '12.34');
  assert.equal(first.payload.customer_id, binding().metronomeCustomerId);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.payload.properties));
});

test('explicit mapping, service period, future skew, age and closed cutoff all gate recording', async () => {
  await assert.rejects(event({}, binding({ environment: 'production' })), /USAGE_ENVIRONMENT_MISMATCH/u);
  await assert.rejects(event({ meterId: 'another-meter' }), /USAGE_METER_MISMATCH/u);
  await assert.rejects(event({ occurredAt: new Date(NOW.getTime() + USAGE_FUTURE_SKEW_MS + 1).toISOString() }), /USAGE_TIME_WINDOW/u);
  await assert.rejects(event({ occurredAt: new Date(NOW.getTime() - USAGE_SAFE_WINDOW_MS).toISOString() }), /USAGE_TIME_WINDOW/u);
  await assert.rejects(event({}, binding({ periodStart: '2026-11-08T10:00:00.000Z' })), /USAGE_PERIOD_MISMATCH/u);
  await assert.rejects(event({ occurredAt: '2026-11-08T08:00:00Z' }, binding({
    periodEnd: '2026-11-08T09:00:00Z', ingestUntil: NOW.toISOString(),
  })), /USAGE_PERIOD_CLOSED/u);
  await assert.rejects(event({}, binding({ properties: { units: '999' } })), /INVALID_USAGE_PROPERTIES/u);
});

test('persisted event validation detects changed body, customer, provider and forged fingerprints', async () => {
  const original = await event();
  assert.deepEqual(validatePreparedUsageEvent(JSON.parse(JSON.stringify(original))), original);
  for (const mutate of [
    (e: PreparedUsageEvent) => { e.payload = { ...e.payload, customer_id: 'other-customer' }; },
    (e: PreparedUsageEvent) => { e.binding.metronomeCustomerId = 'other-customer'; },
    (e: PreparedUsageEvent) => { e.scope.stripeAccountId = 'acct_other'; },
    (e: PreparedUsageEvent) => { e.payloadFingerprint = '0'.repeat(64); },
    (e: PreparedUsageEvent) => { e.transactionId = 'ones a'; },
    (e: PreparedUsageEvent) => { e.payload = { ...e.payload, properties: { units: '999' } }; },
  ]) {
    const changed = JSON.parse(JSON.stringify(original)) as PreparedUsageEvent;
    mutate(changed);
    assert.throws(() => validatePreparedUsageEvent(changed));
  }
  const cyclic = JSON.parse(JSON.stringify(original)) as PreparedUsageEvent;
  (cyclic.payload as unknown as Record<string, unknown>).extra = cyclic;
  assert.throws(() => validatePreparedUsageEvent(cyclic), /USAGE_PAYLOAD_INTEGRITY/u);
});

test('claim is persisted before transport and ingestion200 is only accepted, never invoiced/paid', async () => {
  const journal: string[] = [];
  const item = await event();
  const store = fixtureStore(claim(item), journal);
  const result = await exportNextUsage(store, { async ingest(events) {
    assert.deepEqual(journal, ['attempt-persisted']);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.transactionId, item.transactionId);
    journal.push('sent');
    return { status: 'accepted' };
  } }, { clock: () => NOW });
  assert.deepEqual(journal, ['attempt-persisted', 'sent', 'settled']);
  assert.deepEqual(result?.outcome, { status: 'accepted', acceptedAt: NOW.toISOString() });
  assert.ok(!JSON.stringify(result).includes('invoice'));
});

test('ambiguous crash after provider success recovers with the same ID and retained first attempt', async () => {
  const item = await event();
  const requests: string[] = [];
  const transport = { async ingest(events: readonly PreparedUsageEvent[]): Promise<UsageDeliveryResult> {
    requests.push(JSON.stringify(events.map((e) => e.payload))); return { status: 'accepted' };
  } };
  const firstStore = fixtureStore(claim(item));
  firstStore.settleUsage = async () => { throw new Error('synthetic process interruption before acknowledgement'); };
  await assert.rejects(exportNextUsage(firstStore, transport, { clock: () => NOW }), /synthetic process/u);
  const later = new Date(NOW.getTime() + 60_000);
  const secondClaim = claim(item, later, { leaseToken: 'lease-2', fence: 2, attemptCount: 2 });
  await exportNextUsage(fixtureStore(secondClaim), transport, { clock: () => later });
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(secondClaim.firstAttemptAt, NOW.toISOString());
});

test('retry delay is bounded and preserves immutable event identity; terminal4xx is not retried', async () => {
  const item = await event();
  const retryStore = fixtureStore(claim(item));
  const retried = await exportNextUsage(retryStore, { async ingest() {
    return { status: 'retry', reason: 'rate_limited', retryAfterMs: Number.MAX_SAFE_INTEGER };
  } }, { clock: () => NOW });
  assert.deepEqual(retried?.outcome, { status: 'retry', reason: 'rate_limited', nextAttemptAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
  const rejected = await exportNextUsage(fixtureStore(claim(item)), { async ingest() {
    return { status: 'quarantined', reason: 'provider_rejected' };
  } }, { clock: () => NOW });
  assert.deepEqual(rejected?.outcome, { status: 'quarantined', reason: 'provider_rejected' });
});

test('expired dedup/cutoff, wrong deadline, expired lease and attempt limit prevent any send', async () => {
  const item = await event();
  const cutoff = new Date(item.binding.ingestUntil);
  let calls = 0;
  const transport = { async ingest(): Promise<UsageDeliveryResult> { calls++; return { status: 'accepted' }; } };
  const cases: [UsageClaim, Date, string][] = [
    [claim(item, cutoff), cutoff, 'retry_deadline_exceeded'],
    [claim(item, NOW, { retryDeadline: '2027-01-01T00:00:00.000Z' }), NOW, 'invalid_claim'],
    [claim(item, NOW, { expiresAt: new Date(NOW.getTime() + 500).toISOString() }), NOW, 'invalid_claim'],
    [claim(item, NOW, { attemptCount: USAGE_MAX_ATTEMPTS + 1 }), NOW, 'attempt_limit_exceeded'],
  ];
  for (const [selected, time, reason] of cases) {
    const result = await exportNextUsage(fixtureStore(selected), transport, { clock: () => time });
    assert.deepEqual(result?.outcome, { status: 'quarantined', reason });
  }
  assert.equal(calls, 0);
});

test('timeout aborts bounded request and retains retry semantics without raw provider error', async () => {
  const item = await event();
  let observedSignal: AbortSignal | undefined;
  const result = await exportNextUsage(fixtureStore(claim(item)), { async ingest(_events, signal) {
    observedSignal = signal; return new Promise<UsageDeliveryResult>(() => undefined);
  } }, { clock: () => NOW, leaseMs: 3_000, requestTimeoutMs: 10 });
  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(result?.outcome, { status: 'retry', reason: 'network_or_timeout', nextAttemptAt: new Date(NOW.getTime() + 1_000).toISOString() });
});

test('safe deadline is capped by original event age and first attempt, independently of recent retries', async () => {
  const selected = binding({ periodEnd: '2026-12-15T00:00:00.000Z', ingestUntil: '2026-12-16T00:00:00.000Z' });
  const item = await event({}, selected);
  assert.equal(usageRetryDeadline(item, NOW.toISOString()), new Date(Date.parse(item.occurredAt) + USAGE_SAFE_WINDOW_MS).toISOString());
  assert.equal(usageRetryDeadline(item, new Date(NOW.getTime() + 10 * 86_400_000).toISOString()), usageRetryDeadline(item, NOW.toISOString()));
  assert.throws(() => usageRetryDeadline(item, new Date(NOW.getTime() - 1).toISOString()), /INVALID_USAGE_ATTEMPT/u);
});
