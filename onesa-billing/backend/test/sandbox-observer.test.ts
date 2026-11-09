import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Stripe from 'stripe';
import { getOnlyTransport, observeExistingCheckout, type ObserverInput } from '../scripts/sandbox-observe-existing.js';
import { STRIPE_API_VERSION } from '../src/stripe-provider.js';

const NOW = new Date('2026-11-08T15:00:00Z');
const RUN = 'observer-synthetic-fixture-20261108';
const ACCOUNT = 'acct_SyntheticObserver', CUSTOMER = 'cus_SyntheticObserver', CHECKOUT = 'cs_test_SyntheticObserver';
const KEY = ['sk', 'test', 'T'.repeat(32)].join('_');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Reproduce the original smoke fixture's identity contract independently of the observer.
function originalMetadata(kind: 'customer' | 'checkout') {
  const uuid = (label: string) => {
    const value = digest(RUN + ':' + label);
    return value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16) + '-a' + value.slice(17, 20) + '-' + value.slice(20, 32);
  };
  return {
    onesa_application: 'company', onesa_stripe_account: ACCOUNT, onesa_config_version: RUN,
    onesa_integration_identifier: 'onesa_company_' + [...createHash('sha256').update(RUN).digest().subarray(0, 8)]
      .map(value => String.fromCharCode(97 + value % 26)).join(''),
    onesa_account_id: uuid('account'), onesa_operation_id: uuid(kind), onesa_intent_id: uuid(kind),
    onesa_fingerprint: digest(RUN + ':payload:' + kind), onesa_kind: kind,
  };
}
type Fixture = Record<string, any>;
function fixture(paid = true) {
  const directory = mkdtempSync(join(tmpdir(), 'onesa-existing-checkout-'));
  const receiptPath = join(directory, 'original.json'), observationPath = join(directory, 'observation.json');
  const original = {
    runId: RUN, startedAt: '2026-11-08T10:00:00Z', completedAt: '2026-11-08T10:01:00Z', mode: 'test',
    paymentConfirmed: false, emailsSent: false,
    checks: [
      { name: 'account-and-sandbox', status: 'passed', accountId: ACCOUNT, mode: 'test' },
      { name: 'hosted-checkout-and-idempotency', status: 'passed', duplicateCheckoutCreated: false, paymentConfirmed: false },
    ],
    resources: { customer: CUSTOMER, checkout: CHECKOUT, price: 'price_SyntheticObserver', product: 'prod_SyntheticObserver' },
  };
  const bytes = Buffer.from(JSON.stringify(original) + '\n');
  writeFileSync(receiptPath, bytes, { mode: 0o600 });
  const expected = originalMetadata('checkout');
  const state: Record<string, Fixture> = {
    account: { object: 'account', id: ACCOUNT },
    balance: { object: 'balance', livemode: false },
    checkout: { id: CHECKOUT, object: 'checkout.session', livemode: false, mode: 'payment',
      customer: CUSTOMER, customer_account: null, metadata: expected, client_reference_id: expected.onesa_intent_id,
      integration_identifier: expected.onesa_integration_identifier, currency: 'eur', amount_subtotal: 100, amount_total: 100,
      automatic_tax: { enabled: false }, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
      payment_method_types: ['card'], success_url: 'https://portal.onesa.eu/account/billing',
      cancel_url: 'https://portal.onesa.eu/account/billing', status: paid ? 'complete' : 'open',
      payment_status: paid ? 'paid' : 'unpaid', payment_intent: paid ? 'pi_SyntheticObserver' : null,
      client_secret: 'PRIVATE_CLIENT_SECRET', customer_details: { email: 'private@example.invalid' }, url: 'PRIVATE_CAPABILITY_URL' },
    customer: { id: CUSTOMER, object: 'customer', livemode: false, metadata: originalMetadata('customer'), email: 'private@example.invalid' },
    lines: { object: 'list', has_more: false, data: [{ quantity: 1, currency: 'eur', amount_subtotal: 100, amount_total: 100, amount_tax: 0, amount_discount: 0,
      price: { id: 'price_SyntheticObserver', object: 'price', livemode: false, currency: 'eur', unit_amount: 100,
        type: 'one_time', tax_behavior: 'exclusive', product: 'prod_SyntheticObserver' } }] },
    intent: { id: 'pi_SyntheticObserver', object: 'payment_intent', livemode: false, customer: CUSTOMER, currency: 'eur',
      amount: 100, amount_received: 100, status: 'succeeded', metadata: expected, client_secret: 'PRIVATE_PAYMENT_SECRET' },
  };
  const requests: { method: string; path: string; redirect: RequestRedirect | undefined }[] = [];
  let before: (() => void) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? '', path: url.pathname, redirect: init?.redirect });
    before?.();
    const key = url.pathname === '/v1/account' ? 'account' : url.pathname === '/v1/balance' ? 'balance'
      : url.pathname === '/v1/checkout/sessions/' + CHECKOUT ? 'checkout'
      : url.pathname === '/v1/customers/' + CUSTOMER ? 'customer'
      : url.pathname === '/v1/checkout/sessions/' + CHECKOUT + '/line_items' ? 'lines'
      : url.pathname === '/v1/payment_intents/pi_SyntheticObserver' ? 'intent' : null;
    assert.ok(key, 'a foreign path must never reach the mocked provider');
    return new Response(JSON.stringify(state[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const input: ObserverInput = { receiptPath, observationPath, receiptSha256: digest(bytes), runId: RUN, accountId: ACCOUNT, secretKey: KEY };
  return { directory, input, bytes, state, requests, fetcher, before: (fn: () => void) => { before = fn; },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('paid and unpaid observations preserve original bytes and project no private provider fields', async () => {
  for (const paid of [false, true]) {
    const f = fixture(paid);
    try {
      const result = await observeExistingCheckout(f.input, f.fetcher, NOW);
      assert.equal(result.payment_confirmed, paid);
      assert.equal(result.bound_payment_intent_status, paid ? 'succeeded' : null);
      assert.equal(result.provider_get_requests, paid ? 6 : 5);
      assert.equal(result.original_receipt_sha256, digest(f.bytes));
      assert.equal(result.application_reconciliation_verified, false);
      assert.equal(result.release_authorized, false);
      assert.deepEqual(readFileSync(f.input.receiptPath), f.bytes);
      assert.equal(statSync(f.input.observationPath).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(f.input.observationPath, 'utf8')), result);
      assert.ok(f.requests.every(request => request.method === 'GET' && request.redirect === 'error'));
      const saved = JSON.stringify(result);
      for (const value of [ACCOUNT, CUSTOMER, CHECKOUT, 'pi_SyntheticObserver', RUN, KEY, 'PRIVATE_CLIENT_SECRET',
        'PRIVATE_PAYMENT_SECRET', 'PRIVATE_CAPABILITY_URL', 'private@example.invalid']) assert.equal(saved.includes(value), false);
    } finally { f.close(); }
  }
});

test('foreign identities, fixture metadata, price, amount, mode, return target and inconsistent payment states are refused', async () => {
  const mutations: ((state: Record<string, Fixture>) => void)[] = [
    state => { state.account.id = 'acct_Other'; },
    state => { state.balance.livemode = true; },
    state => { state.checkout.id = 'cs_test_Other'; },
    state => { state.checkout.customer = 'cus_Other'; },
    state => { state.checkout.livemode = true; },
    state => { state.checkout.client_reference_id = 'other'; },
    state => { state.checkout.integration_identifier = 'onesa_company_zzzzzzzz'; },
    state => { state.checkout.metadata = { ...state.checkout.metadata, onesa_operation_id: 'other' }; },
    state => { state.checkout.metadata = { ...state.checkout.metadata, extra: 'unreviewed' }; },
    state => { state.checkout.amount_total = 101; },
    state => { state.checkout.automatic_tax.enabled = true; },
    state => { state.checkout.success_url = 'https://attacker.invalid/account/billing'; },
    state => { state.checkout.cancel_url = 'https://portal.onesa.eu/account/billing?secret=PRIVATE'; },
    state => { state.customer.id = 'cus_Other'; },
    state => { state.customer.metadata = { ...state.customer.metadata, onesa_account_id: 'other' }; },
    state => { state.lines.has_more = true; },
    state => { state.lines.data[0].price.id = 'price_Other'; },
    state => { state.lines.data[0].price.product = 'prod_Other'; },
    state => { state.lines.data[0].quantity = 2; },
    state => { state.intent.customer = 'cus_Other'; },
    state => { state.intent.livemode = true; },
    state => { state.intent.amount = 101; },
    state => { state.intent.amount_received = 0; },
    state => { state.intent.status = 'processing'; },
    state => { state.intent.metadata = { ...state.intent.metadata, onesa_fingerprint: '0'.repeat(64) }; },
    state => { state.checkout.payment_intent = null; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      mutate(f.state);
      await assert.rejects(observeExistingCheckout(f.input, f.fetcher, NOW));
      assert.equal(existsSync(f.input.observationPath), false);
      assert.deepEqual(readFileSync(f.input.receiptPath), f.bytes);
      assert.ok(f.requests.every(request => request.method === 'GET' && request.redirect === 'error'));
    } finally { f.close(); }
  }
});

test('the actual SDK cannot issue mutations through the observer transport', async () => {
  let calls = 0;
  const transport = getOnlyTransport(new Map([['/v1/customers', []]]), async () => { calls++; throw new Error('unexpected provider call'); });
  const sdk = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(transport.fetch) });
  await assert.rejects(sdk.customers.create({ name: 'Must not be created' }));
  assert.equal(calls, 0); assert.equal(transport.count(), 0);
});

test('transport rejects foreign hosts/paths, body/query changes, retries and excess request count', async () => {
  let calls = 0;
  const responder: typeof fetch = async () => { calls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  const transport = getOnlyTransport(new Map([['/v1/account', []]]), responder);
  for (const [url, init] of [
    ['https://other.invalid/v1/account', { method: 'GET' }],
    ['https://api.stripe.com/v1/customers/cus_Other', { method: 'GET' }],
    ['https://api.stripe.com/v1/account?expand=secret', { method: 'GET' }],
    ['https://api.stripe.com/v1/account#fragment', { method: 'GET' }],
    ['https://user:password@api.stripe.com/v1/account', { method: 'GET' }],
    ['https://api.stripe.com/v1/account', { method: 'GET', body: 'unapproved' }],
  ] as const) await assert.rejects(transport.fetch(url, init));
  assert.equal(calls, 0);
  await transport.fetch('https://api.stripe.com/v1/account', { method: 'GET' });
  await assert.rejects(transport.fetch('https://api.stripe.com/v1/account', { method: 'GET' }));
  assert.equal(calls, 1);
  const budget = getOnlyTransport(new Map(Array.from({ length: 7 }, (_, i) => ['/v1/example' + i, []])), responder);
  for (let i = 0; i < 6; i++) await budget.fetch('https://api.stripe.com/v1/example' + i, { method: 'GET' });
  await assert.rejects(budget.fetch('https://api.stripe.com/v1/example6', { method: 'GET' }));
  assert.equal(budget.count(), 6);
});

test('redirect responses and redirect-followed responses fail closed; oversized streams are bounded', async () => {
  for (const kind of ['redirect', 'followed', 'oversized']) {
    const f = fixture(); let calls = 0;
    try {
      const fetcher: typeof fetch = async (_url, init) => {
        calls++; assert.equal(init?.redirect, 'error');
        if (kind === 'redirect') return new Response('{}', { status: 302, headers: { 'content-type': 'application/json', location: 'https://attacker.invalid/' } });
        if (kind === 'oversized') return new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
        const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'redirected', { value: true });
        Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/' });
        return response;
      };
      await assert.rejects(observeExistingCheckout(f.input, fetcher, NOW));
      assert.equal(calls, 1); assert.equal(existsSync(f.input.observationPath), false);
    } finally { f.close(); }
  }
});

test('unsafe inputs and any existing or aliased output are refused before provider reads', async () => {
  for (const kind of ['hash', 'input-mode', 'parent-mode', 'same-path', 'output-existing', 'output-symlink', 'input-symlink', 'input-hardlink']) {
    const f = fixture();
    try {
      if (kind === 'hash') f.input.receiptSha256 = '0'.repeat(64);
      if (kind === 'input-mode') chmodSync(f.input.receiptPath, 0o644);
      if (kind === 'parent-mode') chmodSync(f.directory, 0o755);
      if (kind === 'same-path') f.input.observationPath = f.input.receiptPath;
      if (kind === 'output-existing') writeFileSync(f.input.observationPath, 'PRESERVE', { mode: 0o600 });
      if (kind === 'output-symlink') symlinkSync(f.input.receiptPath, f.input.observationPath);
      if (kind === 'input-symlink') { const alias = join(f.directory, 'alias.json'); symlinkSync(f.input.receiptPath, alias); f.input.receiptPath = alias; }
      if (kind === 'input-hardlink') linkSync(f.input.receiptPath, join(f.directory, 'alias.json'));
      await assert.rejects(observeExistingCheckout(f.input, f.fetcher, NOW));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(readFileSync(f.input.receiptPath), f.bytes);
      if (kind === 'output-existing') assert.equal(readFileSync(f.input.observationPath, 'utf8'), 'PRESERVE');
    } finally { f.close(); }
  }
});

test('a changed original receipt prevents publication of an observation', async () => {
  const f = fixture();
  try {
    f.before(() => writeFileSync(f.input.receiptPath, Buffer.concat([f.bytes, Buffer.from('\n')]), { mode: 0o600 }));
    await assert.rejects(observeExistingCheckout(f.input, f.fetcher, NOW), /ORIGINAL_RECEIPT_CHANGED/);
    assert.equal(existsSync(f.input.observationPath), false);
  } finally { f.close(); }
});

test('provider error text is never projected and zero retries are performed', async () => {
  const f = fixture(); let calls = 0;
  try {
    const fetcher: typeof fetch = async () => {
      calls++; return new Response(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_TEXT', type: 'api_error' } }),
        { status: 500, headers: { 'content-type': 'application/json', 'stripe-should-retry': 'true' } });
    };
    await assert.rejects(observeExistingCheckout(f.input, fetcher, NOW), error => {
      assert.equal(error instanceof Error && error.message, 'PROVIDER_READ_FAILED'); return true;
    });
    assert.equal(calls, 1); assert.equal(existsSync(f.input.observationPath), false);
  } finally { f.close(); }
});

test('CLI refusals expose only a closed code and never input paths or credentials', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sandbox-observe-existing.ts'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { PATH: process.env.PATH, BILLING_SANDBOX_OBSERVE: 'true', STRIPE_SECRET_KEY: 'PRIVATE_SENTINEL',
      BILLING_SMOKE_REPORT: '/private/DO_NOT_PRINT', BILLING_OBSERVATION_REPORT: '/private/DO_NOT_PRINT_OUTPUT' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'REFUSED', code: 'OBSERVER_CONFIGURATION_INVALID' });
});
