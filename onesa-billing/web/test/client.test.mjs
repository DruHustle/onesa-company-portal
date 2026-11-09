import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingClientError, blocksNewCheckout, createBillingClient, createCheckoutAttempt,
  operationStatus, trustedHostedUrl } from '../client.mjs';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const CUSTOMER = '20000000-0000-4000-8000-000000000001';
const INTENT = '30000000-0000-4000-8000-000000000001';
const CHECKOUT = '40000000-0000-4000-8000-000000000001';
const KEYS = ['50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002'];
const PREFIX = '/api/v1/account/billing';
const CSRF = 'a'.repeat(64);
const items = [{ sku: 'support-session', quantity: 2 }];
const catalog = { mode: 'test', salesEnabled: true, items: [{ sku: 'support-session', title: 'Support session',
  version: 'v1', currency: 'eur', unitAmount: 12000, maxQuantity: 4, taxBehavior: 'exclusive' }] };
const account = { id: ACCOUNT, displayName: 'Example account', status: 'active', revision: 1, role: 'owner' };
function operation(overrides = {}) {
  return { id: CHECKOUT, accountId: ACCOUNT, commercialIntentId: INTENT, kind: 'checkout_create',
    state: 'prepared', providerState: null, reviewRequired: false, ...overrides };
}
function customer(overrides = {}) {
  return operation({ id: CUSTOMER, commercialIntentId: ACCOUNT, kind: 'customer_create', state: 'succeeded',
    providerState: 'created', ...overrides });
}
function response(value, status = 200) { return Response.json(value, { status }); }
function harness(handler) {
  const calls = []; let nonce = 0;
  const client = createBillingClient({ csrf: () => CSRF, idFactory: () => KEYS[nonce++], fetch: async (url, options) => {
    const call = { url, ...options, parsedBody: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(call); return handler(call, calls);
  } });
  return { client, calls };
}
function normal(call) {
  if (call.url.endsWith('/customer')) return response(customer(), 202);
  if (call.url.endsWith('/intents')) return response({ id: INTENT, accountId: ACCOUNT, kind: 'checkout', items }, 201);
  if (call.url.endsWith('/submit')) return response(operation(), 202);
  if (call.url.endsWith('/operations/' + CHECKOUT)) return response(operation({ state: 'succeeded', providerState: 'open.unpaid',
    redirectUrl: 'https://checkout.stripe.com/c/pay/example', paymentConfirmed: false }));
  throw Error('Unexpected fake request');
}

test('browser transport has one same-origin prefix and carries only cookie/CSRF identity', async () => {
  const { client, calls } = harness(call => call.url.endsWith('/catalog') ? response(catalog) : response(account, 201));
  const observed = await client.catalog();
  assert.equal(observed.items[0].unitAmount, 12000);
  await client.createAccount('Example account');
  assert.equal(calls[0].url, PREFIX + '/catalog');
  assert.equal(calls[0].headers['X-CSRF-Token'], undefined);
  assert.equal(calls[1].headers['X-CSRF-Token'], CSRF);
  for (const call of calls) {
    assert.equal(call.credentials, 'same-origin'); assert.equal(call.redirect, 'error'); assert.equal(call.cache, 'no-store');
    assert.equal(call.headers.Authorization, undefined); assert.equal(call.headers.authorization, undefined);
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test('mutation refuses missing session proof and malformed route identifiers before transport', async () => {
  let calls = 0;
  const client = createBillingClient({ csrf: () => '', fetch: async () => { calls++; throw Error('must not call'); } });
  await assert.rejects(client.createAccount('Example'), error => error.code === 'SESSION_REQUIRED');
  await assert.rejects(client.operation('../../other', ACCOUNT), error => error.code === 'INVALID_IDENTIFIER');
  assert.equal(calls, 0);
});

test('owned account and operation identifiers must match every authenticated read', async () => {
  const { client } = harness(() => response(operation({ accountId: OTHER })));
  await assert.rejects(client.operation(CHECKOUT, ACCOUNT), error => error.code === 'ACCOUNT_MISMATCH');
  const wrongOperation = harness(() => response(operation({ id: CUSTOMER }))).client;
  await assert.rejects(wrongOperation.operation(CHECKOUT, ACCOUNT), error => error.code === 'OPERATION_MISMATCH');
  const wrongList = harness(() => response([operation({ accountId: OTHER })])).client;
  await assert.rejects(wrongList.operations(ACCOUNT), error => error.code === 'ACCOUNT_MISMATCH');
});

test('untrusted redirect hosts, credentials and protocols never become navigation targets', () => {
  assert.equal(trustedHostedUrl('https://checkout.stripe.com/c/pay/example', 'checkout_create'), 'https://checkout.stripe.com/c/pay/example');
  assert.equal(trustedHostedUrl('https://invoice.stripe.com/i/example', 'invoice_finalize'), 'https://invoice.stripe.com/i/example');
  for (const url of ['https://checkout.stripe.com.evil.example/a', 'https://evil.example/?next=https://checkout.stripe.com',
    'javascript:alert(1)', 'http://checkout.stripe.com/a', 'https://user:password@checkout.stripe.com/a',
    'https://checkout.stripe.com:444/a', 'https://billing.stripe.com/a']) {
    assert.throws(() => trustedHostedUrl(url, 'checkout_create'), error => error.code === 'INVALID_REDIRECT');
  }
  assert.equal(trustedHostedUrl(null, 'checkout_create'), null);
});

test('response bytes and list counts are bounded; arbitrary upstream exception text is not retained', async () => {
  const tooLarge = harness(() => new Response('x'.repeat(131073))).client;
  await assert.rejects(tooLarge.catalog(), error => error.code === 'INVALID_RESPONSE');
  const tooMany = harness(() => response(Array.from({ length: 101 }, () => account))).client;
  await assert.rejects(tooMany.accounts(), error => error.code === 'INVALID_RESPONSE');
  const secret = harness(() => { throw Error('https://private.invalid/?secret=DO_NOT_KEEP'); }).client;
  await assert.rejects(secret.prepareCustomer(ACCOUNT), error => {
    assert.equal(error.code, 'SERVICE_UNAVAILABLE'); assert.equal(error.uncertain, true);
    assert.equal(JSON.stringify(error).includes('DO_NOT_KEEP'), false); return true;
  });
});

test('HTTP errors expose only bounded fixed codes and mark uncertain server-side writes', async () => {
  const client = harness(() => response({ error: { code: 'UPSTREAM_DOWN', message: 'secret provider detail' } }, 503)).client;
  await assert.rejects(client.prepareCustomer(ACCOUNT), error => error.code === 'UPSTREAM_DOWN' && error.status === 503
    && error.uncertain && !JSON.stringify(error).includes('secret provider detail'));
  const unauthorized = harness(() => response({ error: { code: 'AUTH_REQUIRED' } }, 401)).client;
  await assert.rejects(unauthorized.accounts(), error => error.code === 'AUTH_REQUIRED' && error.status === 401 && !error.uncertain);
});

test('one Checkout attempt snapshots items and uses distinct stable intent and submit identities', async () => {
  const { client, calls } = harness(normal);
  const selection = [{ sku: 'support-session', quantity: 2 }];
  const attempt = createCheckoutAttempt(client, ACCOUNT, selection);
  selection[0].quantity = 4;
  const initial = await attempt.advance();
  assert.equal(initial.phase, 'checkout'); assert.equal(initial.operation.state, 'prepared');
  const next = await attempt.advance();
  assert.equal(next.operation.redirectUrl, 'https://checkout.stripe.com/c/pay/example');
  assert.equal(next.operation.paymentConfirmed, false);
  assert.deepEqual(calls[1].parsedBody, { kind: 'checkout', items });
  assert.equal(calls[1].headers['Idempotency-Key'], KEYS[0]);
  assert.equal(calls[2].headers['Idempotency-Key'], KEYS[1]);
  assert.equal(calls[3].method, 'GET');
  assert.equal(calls.filter(call => call.url.endsWith('/submit')).length, 1);
});

test('a lost submit response retries the exact intent and nonce without recreating the commercial event', async () => {
  let submitted = false;
  const { client, calls } = harness(call => {
    if (call.url.endsWith('/submit') && !submitted) { submitted = true; throw Error('lost after acceptance'); }
    if (call.url.endsWith('/operations')) return response([]);
    return normal(call);
  });
  const attempt = createCheckoutAttempt(client, ACCOUNT, items);
  await assert.rejects(attempt.advance(), error => error instanceof BillingClientError && error.uncertain);
  assert.equal(attempt.snapshot().intentId, INTENT);
  await attempt.advance();
  const submits = calls.filter(call => call.url.endsWith('/submit'));
  assert.equal(submits.length, 2);
  assert.equal(submits[0].headers['Idempotency-Key'], submits[1].headers['Idempotency-Key']);
  assert.equal(submits[0].body, submits[1].body);
  assert.equal(calls.filter(call => call.url.endsWith('/intents')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/customer')).length, 1);
});

test('an accepted submit with a lost response is recovered from authenticated history without another POST', async () => {
  const { client, calls } = harness(call => {
    if (call.url.endsWith('/submit')) throw Error('lost after acceptance');
    if (call.url.endsWith('/operations')) return response([operation()]);
    return normal(call);
  });
  const attempt = createCheckoutAttempt(client, ACCOUNT, items);
  await assert.rejects(attempt.advance(), error => error.uncertain);
  const recovered = await attempt.advance();
  assert.equal(recovered.operation.id, CHECKOUT);
  assert.equal(recovered.operation.state, 'succeeded');
  assert.equal(calls.filter(call => call.url.endsWith('/submit')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/intents')).length, 1);
});

test('a lost intent response reuses its original key, even after the caller mutates the selected quantity', async () => {
  let created = false;
  const { client, calls } = harness(call => {
    if (call.url.endsWith('/intents') && !created) { created = true; throw Error('lost after acceptance'); }
    return normal(call);
  });
  const selection = [{ sku: 'support-session', quantity: 2 }];
  const attempt = createCheckoutAttempt(client, ACCOUNT, selection);
  await assert.rejects(attempt.advance(), error => error.uncertain);
  selection[0].sku = 'different'; selection[0].quantity = 99;
  await attempt.advance();
  const intents = calls.filter(call => call.url.endsWith('/intents'));
  assert.equal(intents.length, 2); assert.equal(intents[0].body, intents[1].body);
  assert.equal(intents[0].headers['Idempotency-Key'], intents[1].headers['Idempotency-Key']);
});

test('concurrent browser actions share one in-flight attempt rather than creating duplicate writes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client, calls } = harness(async call => { if (call.url.endsWith('/customer')) await gate; return normal(call); });
  const attempt = createCheckoutAttempt(client, ACCOUNT, items);
  const first = attempt.advance(), second = attempt.advance();
  assert.equal(first, second); release(); await Promise.all([first, second]);
  assert.equal(calls.filter(call => call.method === 'POST').length, 3);
});

test('customer processing, unknown and failed outcomes cannot start a Checkout intent', async () => {
  for (const state of ['prepared', 'dispatched', 'unknown', 'failed']) {
    const { client, calls } = harness(() => response(customer({ state, reviewRequired: ['unknown', 'failed'].includes(state) })));
    const attempt = createCheckoutAttempt(client, ACCOUNT, items);
    const result = await attempt.advance();
    assert.equal(result.phase, 'customer'); assert.equal(calls.length, 1);
    await attempt.advance();
    assert.equal(calls.some(call => call.url.endsWith('/intents')), false);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('wrong intent echoes or an unexpected operation kind fail without navigating or changing nonce', async () => {
  const { client } = harness(call => call.url.endsWith('/intents')
    ? response({ id: INTENT, accountId: OTHER, kind: 'checkout', items }) : normal(call));
  await assert.rejects(createCheckoutAttempt(client, ACCOUNT, items).advance(), error => error.code === 'INTENT_MISMATCH');
  const wrong = harness(call => call.url.endsWith('/submit') ? response(operation({ kind: 'invoice_create' })) : normal(call));
  await assert.rejects(createCheckoutAttempt(wrong.client, ACCOUNT, items).advance(), error => error.code === 'OPERATION_MISMATCH');
});

test('payment is never inferred from redirect URLs, local completion or a provider state string', async () => {
  for (const value of [operation({ state: 'succeeded', providerState: 'complete.paid' }),
    operation({ state: 'prepared', paymentConfirmed: true })]) {
    const client = harness(() => response(value)).client;
    const result = await client.operation(CHECKOUT, ACCOUNT);
    assert.equal(result.paymentConfirmed, false); assert.notEqual(operationStatus(result), 'Paid');
  }
  const paid = operation({ state: 'succeeded', providerState: 'complete.paid', paymentConfirmed: true });
  assert.equal(operationStatus(paid), 'Paid'); assert.equal(blocksNewCheckout(paid), false);
});

test('history holds unconfirmed purchases through reload and releases only verified paid or expired outcomes', () => {
  for (const row of [operation(), operation({ state: 'unknown', reviewRequired: true }),
    operation({ state: 'succeeded', providerState: 'open.unpaid' }), operation({ state: 'succeeded', providerState: null }),
    operation({ state: 'succeeded', providerState: 'complete.paid' })]) assert.equal(blocksNewCheckout(row), true);
  assert.equal(blocksNewCheckout(operation({ state: 'succeeded', providerState: 'expired.unpaid' })), false);
  assert.equal(blocksNewCheckout(operation({ kind: 'invoice_create', state: 'succeeded', providerState: 'draft' })), false);
  assert.equal(blocksNewCheckout(operation({ state: 'unknown', providerState: 'expired.unpaid', reviewRequired: true })), true);
});
