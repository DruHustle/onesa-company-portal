import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderScope } from '../src/domain.js';
import { createMetronomeTransport, METRONOME_INGEST_URL, MetronomeTransportConfig } from '../src/metronome.js';
import { createUsageProducerAuthenticator, prepareUsageEvent, PreparedUsageEvent, UsageBinding } from '../src/usage.js';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const SCOPE: ProviderScope = { application: 'company', stripeAccountId: 'acct_companyTest', mode: 'test', configVersion: 'catalog-1' };
const CONFIG: MetronomeTransportConfig = { scope: SCOPE, metronomeProjectId: 'project-1', environment: 'sandbox' };
const SYNTHETIC_TOKEN = 'unused-synthetic-metronome-token';

async function event(sourceEventId = 'event-1', selectedScope = SCOPE, project = 'project-1'): Promise<PreparedUsageEvent> {
  const selected: UsageBinding = { accountId: 'account-1', scope: selectedScope, stripeCustomerId: 'cus_one',
    metronomeCustomerId: 'customer-1', metronomeProjectId: project, environment: selectedScope.mode === 'test' ? 'sandbox' : 'production',
    contractId: 'contract-1', meterId: 'api-requests', eventType: 'api_request', quantityKey: 'units', properties: { service: 'api' },
    periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', ingestUntil: '2026-12-02T00:00:00Z' };
  const principal = await createUsageProducerAuthenticator(async () => ({ actor: { issuer: 'synthetic', subject: 'producer-1' },
    accountId: selected.accountId, scope: selectedScope, allowedMeterIds: [selected.meterId], expiresAt: '2026-11-08T11:00:00Z',
  }))('unused-synthetic-producer-token');
  return prepareUsageEvent({ sourceEventId, meterId: selected.meterId, quantity: '9007199254740993.000001',
    occurredAt: '2026-11-08T09:59:00Z' }, principal, selected, NOW);
}

test('uses only the fixed ingest endpoint, a bare array and unchanged exact decimal payload', async () => {
  const item = await event();
  let calls = 0;
  const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async (url, init) => {
    calls++;
    assert.equal(url, METRONOME_INGEST_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${SYNTHETIC_TOKEN}`);
    assert.deepEqual(JSON.parse(String(init.body)), [item.payload]);
    assert.equal(JSON.parse(String(init.body))[0].properties.units, '9007199254740993.000001');
    assert.ok(!String(init.body).includes('stripeCustomerId'));
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await adapter.ingest([item], new AbortController().signal), { status: 'accepted' });
  assert.equal(calls, 1);
});

test('same recorded events produce byte-identical retry requests', async () => {
  const item = await event();
  const bodies: unknown[] = [];
  const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async (_url, init) => {
    bodies.push(init.body);
    return bodies.length === 1 ? new Response('private provider error', { status: 503 }) : new Response(null, { status: 200 });
  });
  assert.deepEqual(await adapter.ingest([item], new AbortController().signal), { status: 'retry', reason: 'provider_unavailable' });
  assert.deepEqual(await adapter.ingest([item], new AbortController().signal), { status: 'accepted' });
  assert.equal(bodies[0], bodies[1]);
});

test('account, mode, config and project mismatches refuse before HTTP', async () => {
  let calls = 0;
  const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async () => { calls++; return new Response(null, { status: 200 }); });
  const mismatches = [
    await event('event-1', { ...SCOPE, stripeAccountId: 'acct_other' }),
    await event('event-1', { ...SCOPE, mode: 'live' }),
    await event('event-1', { ...SCOPE, configVersion: 'catalog-2' }),
    await event('event-1', SCOPE, 'other-project'),
  ];
  for (const item of mismatches) assert.deepEqual(await adapter.ingest([item], new AbortController().signal),
    { status: 'quarantined', reason: 'provider_scope_mismatch' });
  assert.equal(calls, 0);
});

test('captures configured custody against later caller mutation', async () => {
  const config = { ...CONFIG, scope: { ...SCOPE } };
  let calls = 0;
  const adapter = createMetronomeTransport(config, SYNTHETIC_TOKEN, async () => { calls++; return new Response(null, { status: 200 }); });
  config.scope.stripeAccountId = 'acct_mutated';
  config.metronomeProjectId = 'mutated-project';
  assert.deepEqual(await adapter.ingest([await event()], new AbortController().signal), { status: 'accepted' });
  assert.equal(calls, 1);
});

test('batch size, duplicate IDs, tampered persisted data and missing token fail before HTTP', async () => {
  const item = await event();
  let calls = 0;
  const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async () => { calls++; return new Response(null, { status: 200 }); });
  await assert.rejects(adapter.ingest([], new AbortController().signal), /METRONOME_INVALID_BATCH/u);
  await assert.rejects(adapter.ingest(Array.from({ length: 101 }, () => item), new AbortController().signal), /METRONOME_INVALID_BATCH/u);
  await assert.rejects(adapter.ingest([item, item], new AbortController().signal), /METRONOME_DUPLICATE_BATCH/u);
  const altered = JSON.parse(JSON.stringify(item)) as PreparedUsageEvent;
  altered.payload = { ...altered.payload, customer_id: 'other' };
  await assert.rejects(adapter.ingest([altered], new AbortController().signal), /USAGE_PAYLOAD_INTEGRITY/u);
  assert.throws(() => createMetronomeTransport(CONFIG, ''), /METRONOME_NOT_CONFIGURED/u);
  assert.throws(() => createMetronomeTransport(CONFIG, 'bad\r\nheader'), /METRONOME_NOT_CONFIGURED/u);
  assert.equal(calls, 0);
});

test('rate limit,5xx,4xx and unexpected HTTP status have fixed bounded outcomes without response contents', async () => {
  const item = await event();
  const cases: [number, string, string][] = [[429, 'retry', 'rate_limited'], [500, 'retry', 'provider_unavailable'],
    [401, 'quarantined', 'provider_configuration'], [403, 'quarantined', 'provider_configuration'],
    [400, 'quarantined', 'provider_rejected'], [408, 'quarantined', 'provider_rejected'],
    [302, 'quarantined', 'provider_protocol'], [201, 'quarantined', 'provider_protocol']];
  for (const [status, expectedStatus, expectedReason] of cases) {
    const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async () => new Response('sensitive-response-never-retained',
      { status, headers: { 'retry-after': '99999999' } }));
    const outcome = await adapter.ingest([item], new AbortController().signal);
    assert.equal(outcome.status, expectedStatus);
    assert.ok('reason' in outcome && outcome.reason === expectedReason);
    assert.ok(!JSON.stringify(outcome).includes('sensitive-response'));
    if (status === 429) assert.deepEqual(outcome, { status: 'retry', reason: 'rate_limited', retryAfterMs: 3_600_000 });
  }
});

test('network failures are ambiguous retries; raw error and token never enter result', async () => {
  const adapter = createMetronomeTransport(CONFIG, SYNTHETIC_TOKEN, async () => { throw new Error(`sensitive ${SYNTHETIC_TOKEN}`); });
  const result = await adapter.ingest([await event()], new AbortController().signal);
  assert.deepEqual(result, { status: 'retry', reason: 'network_or_timeout' });
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_TOKEN));
});

test('pre-aborted calls do not send; nonresponding fetch has an independent deadline', async () => {
  let calls = 0;
  let observed: AbortSignal | undefined;
  const adapter = createMetronomeTransport({ ...CONFIG, requestTimeoutMs: 10 }, SYNTHETIC_TOKEN, async (_url, init) => {
    calls++; observed = init.signal ?? undefined; return new Promise<Response>(() => undefined);
  });
  const item = await event();
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await adapter.ingest([item], cancelled.signal), { status: 'retry', reason: 'network_or_timeout' });
  assert.equal(calls, 0);
  assert.deepEqual(await adapter.ingest([item], new AbortController().signal), { status: 'retry', reason: 'network_or_timeout' });
  assert.equal(observed?.aborted, true);
  assert.equal(calls, 1);
});
