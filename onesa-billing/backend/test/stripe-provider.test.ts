import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { BillingError, type CatalogLine, type CustomerBinding, type ProviderOperation, type ProviderScope } from '../src/domain.js';
import { StripeCompanyProvider, validateProjectionForIntent, STRIPE_API_VERSION, STRIPE_OPERATION_REPLAY_MS, type StripeProviderConfig, type ExternalInvoiceOwner } from '../src/stripe-provider.js';

// All secrets and provider identities below are deliberately synthetic. The SDK's HTTP client is replaced.
// Generate arbitrary dummy bytes here; no provider credential is embedded or read.
const syntheticKey = (mode: 'test' | 'live') => ['sk', mode, 'T'.repeat(32)].join('_');
const KEY = syntheticKey('test');
const WEBHOOK_SECRET = ['whsec', 'W'.repeat(32)].join('_');
const NOW = Date.parse('2026-11-08T10:00:00.000Z');
const scope: ProviderScope = { application: 'company', stripeAccountId: 'acct_SyntheticCompany123', mode: 'test', configVersion: 'company-v1' };
const binding: CustomerBinding = { accountId: 'company-account-a', customerId: 'cus_SyntheticA', scope };
const integrationIdentifier = 'onesa_company_abcdefgh';
const op = (id = 'operation-a', overrides: Partial<ProviderOperation> = {}): ProviderOperation => ({
  id, accountId: binding.accountId, commercialIntentId: 'intent-one-off-a', idempotencyKey: `request-${id}`,
  fingerprint: createHash('sha256').update(id).digest('hex'), createdAt: new Date(NOW - 1000).toISOString(), firstAttemptAt: new Date(NOW).toISOString(), scope, ...overrides,
});
const lines = (): CatalogLine[] => [{ item: { sku: 'consulting', title: 'Synthetic consulting', version: 'v1', kind: 'one_off', priceId: 'price_Consulting', currency: 'usd', unitAmount: 1000, taxBehavior: 'exclusive', maxQuantity: 10 }, quantity: 2 }];
const config = (overrides: Partial<StripeProviderConfig> = {}): StripeProviderConfig => ({ scope, secretKey: KEY, webhookSecret: WEBHOOK_SECRET,
  publicOrigin: 'https://www.onesa.eu', automaticTaxEnabled: true, integrationIdentifier, invoiceDaysUntilDue: 14,
  portalConfigurationId: 'bpc_SyntheticCompany', now: () => new Date(NOW), ...overrides });
function metadata(operation: ProviderOperation = op(), kind = 'customer') {
  return { onesa_application: 'company', onesa_account_id: operation.accountId, onesa_stripe_account: scope.stripeAccountId,
    onesa_config_version: scope.configVersion, onesa_integration_identifier: integrationIdentifier,
    onesa_operation_id: operation.id, onesa_intent_id: operation.commercialIntentId, onesa_fingerprint: operation.fingerprint, onesa_kind: kind };
}
type Request = { path: string; method: string; body: URLSearchParams; query: URLSearchParams; headers: Headers };
// The intentionally flexible fixture represents JSON from the transport, including malformed responses in adverse cases.
type Fixture = Record<string, any>;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function values(body: URLSearchParams, name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of body) { const m = key.match(new RegExp(`^${name}\\[([^\\]]+)\\]$`)); if (m) result[m[1]!] = value; }
  return result;
}
function fixture(overrides: Partial<StripeProviderConfig> = {}) {
  const requests: Request[] = [], accepted = new Map<string, { body: string; value: unknown }>();
  const state = {
    account: { object: 'account', id: scope.stripeAccountId, charges_enabled: true, details_submitted: true } as Fixture,
    customer: { object: 'customer', id: binding.customerId, livemode: false, metadata: metadata(), tax: { automatic_tax: 'supported' }, email: 'private-fixture@example.invalid' } as Fixture,
    prices: new Map<string, Fixture>([['price_Consulting', { object: 'price', id: 'price_Consulting', active: true, livemode: false, type: 'one_time', recurring: null, billing_scheme: 'per_unit', currency: 'usd', unit_amount: 1000, tax_behavior: 'exclusive', product: 'prod_Consulting' }]]),
    tax: { object: 'tax.settings', livemode: false, status: 'active', head_office: { address: { country: 'GB' } }, defaults: { tax_code: 'txcd_SyntheticOnly', tax_behavior: 'exclusive', provider: 'stripe' }, status_details: { active: {} } } as Fixture,
    registrations: { object: 'list', data: [{ object: 'tax.registration', id: 'taxreg_Synthetic', status: 'active', livemode: false, active_from: NOW / 1000 - 100, expires_at: null }], has_more: false, url: '/v1/tax/registrations' } as Fixture,
    session: null as Fixture | null, invoice: null as Fixture | null, items: [] as Fixture[],
    portal: { object: 'billing_portal.configuration', id: 'bpc_SyntheticCompany', active: true, livemode: false } as Fixture,
    charge: { object: 'charge', id: 'ch_SyntheticA', customer: binding.customerId, livemode: false, amount: 2000, amount_refunded: 500, currency: 'usd', paid: true, captured: true, disputed: false, receipt_email: 'private-fixture@example.invalid' } as Fixture,
    credit: { object: 'credit_note', id: 'cn_SyntheticA', invoice: 'in_SyntheticA', customer: binding.customerId, livemode: false, status: 'issued', amount: 500, currency: 'usd', memo: 'PRIVATE FIXTURE MEMO' } as Fixture,
    lineHasMore: false, createdCustomers: 0,
    before: undefined as ((request: Request) => void | Promise<void>) | undefined,
    failAfter: undefined as ((request: Request) => boolean) | undefined,
  };
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_SYNTHETIC' } });
  const sdk = new Stripe(KEY, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.stripe.com', 'all SDK requests must remain intercepted Stripe requests');
      const request: Request = { path: url.pathname, method: init?.method ?? 'GET', body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''), query: url.searchParams, headers: new Headers(init?.headers) };
      requests.push(request); await state.before?.(request);
      const key = request.headers.get('idempotency-key'), cacheKey = `${request.path}:${key}`, original = accepted.get(cacheKey);
      if (request.method === 'POST') {
        assert.ok(key && /^onesa-company-v1-[a-f0-9]{64}$/.test(key));
        if (original) { assert.equal(request.body.toString(), original.body, 'an idempotent step cannot change its request'); return json(original.value); }
      }
      let value: unknown;
      if (request.method === 'GET' && request.path === '/v1/account') value = state.account;
      else if (request.method === 'GET' && request.path === `/v1/customers/${binding.customerId}`) value = state.customer;
      else if (request.method === 'POST' && request.path === '/v1/customers') {
        state.createdCustomers++; state.customer = { ...state.customer, metadata: values(request.body, 'metadata') }; value = state.customer;
      } else if (request.method === 'GET' && request.path.startsWith('/v1/prices/')) {
        value = state.prices.get(request.path.split('/').at(-1)!); assert.ok(value, 'only the server catalog may be read');
      } else if (request.method === 'GET' && request.path === '/v1/tax/settings') value = state.tax;
      else if (request.method === 'GET' && request.path === '/v1/tax/registrations') value = state.registrations;
      else if (request.method === 'POST' && request.path === '/v1/checkout/sessions') {
        const entries: Fixture[] = [];
        for (let i = 0; request.body.has(`line_items[${i}][price]`); i++) {
          const price = state.prices.get(request.body.get(`line_items[${i}][price]`)!); assert.ok(price);
          const quantity = Number(request.body.get(`line_items[${i}][quantity]`));
          entries.push({ id: `li_checkout${i}`, object: 'item', currency: price.currency, quantity, price: clone(price), amount_subtotal: price.unit_amount * quantity, amount_total: price.unit_amount * quantity, amount_tax: 0, amount_discount: 0 });
        }
        const amount = entries.reduce((sum, item) => sum + item.amount_total, 0);
        state.session = { object: 'checkout.session', id: 'cs_test_SyntheticA', livemode: false, mode: 'payment', ui_mode: request.body.get('ui_mode'),
          customer: request.body.get('customer'), customer_account: null, integration_identifier: request.body.get('integration_identifier'), client_reference_id: request.body.get('client_reference_id'), metadata: values(request.body, 'metadata'),
          status: 'open', payment_status: 'unpaid', currency: 'usd', amount_subtotal: amount, amount_total: amount,
          total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
          automatic_tax: { enabled: request.body.get('automatic_tax[enabled]') === 'true', status: null }, expires_at: Math.floor(NOW / 1000) + 3600,
          url: 'https://checkout.stripe.com/c/pay/cs_test_SyntheticA#synthetic', line_items: { object: 'list', data: entries, has_more: false, url: '/synthetic' } };
        value = state.session;
      } else if (request.method === 'GET' && request.path === '/v1/checkout/sessions/cs_test_SyntheticA') value = state.session;
      else if (request.method === 'GET' && request.path === '/v1/checkout/sessions/cs_test_SyntheticA/line_items') value = { ...state.session!.line_items, has_more: state.lineHasMore };
      else if (request.method === 'POST' && request.path === '/v1/invoices') {
        state.invoice = { object: 'invoice', id: 'in_SyntheticA', livemode: false, customer: request.body.get('customer'), customer_account: null,
          metadata: values(request.body, 'metadata'), status: 'draft', auto_advance: request.body.get('auto_advance') === 'true', collection_method: request.body.get('collection_method'), currency: request.body.get('currency'),
          amount_due: 0, amount_paid: 0, amount_remaining: 0, total: 0, subtotal: 0, amount_shipping: 0, shipping_cost: null, discounts: [], total_discount_amounts: null, total_pretax_credit_amounts: null, total_taxes: null,
          automatic_tax: { enabled: request.body.get('automatic_tax[enabled]') === 'true', status: null },
          hosted_invoice_url: null, lines: { object: 'list', data: [], has_more: false, url: '/synthetic' }, customer_email: 'private-fixture@example.invalid' };
        value = state.invoice;
      } else if (request.method === 'POST' && request.path === '/v1/invoiceitems') {
        assert.ok(state.invoice); assert.equal(state.invoice.status, 'draft');
        const price = state.prices.get(request.body.get('pricing[price]')!); assert.ok(price);
        const quantity = Number(request.body.get('quantity')), amount = price.unit_amount * quantity;
        const item = { object: 'invoiceitem', id: `ii_Synthetic${state.items.length}`, livemode: false, customer: request.body.get('customer'), invoice: request.body.get('invoice'),
          metadata: values(request.body, 'metadata'), currency: price.currency, quantity, amount };
        state.items.push(item);
        state.invoice.lines.data.push({ object: 'line_item', id: `il_Synthetic${state.items.length}`, livemode: false, quantity, quantity_decimal: String(quantity), currency: price.currency, amount, discounts: [], discount_amounts: null, pretax_credit_amounts: null,
          pricing: { type: 'price_details', price_details: { price: price.id, product: price.product }, unit_amount_decimal: String(price.unit_amount) } });
        state.invoice.amount_due += amount; state.invoice.amount_remaining += amount; state.invoice.total += amount; state.invoice.subtotal += amount; value = item;
      } else if (request.method === 'GET' && request.path === '/v1/invoices/in_SyntheticA') value = state.invoice;
      else if (request.method === 'GET' && request.path === '/v1/invoices/in_SyntheticA/lines') value = { ...state.invoice!.lines, has_more: state.lineHasMore };
      else if (request.method === 'POST' && request.path === '/v1/invoices/in_SyntheticA/finalize') {
        assert.ok(state.invoice); state.invoice.status = 'open'; state.invoice.automatic_tax.status = state.invoice.automatic_tax.enabled ? 'complete' : null;
        state.invoice.hosted_invoice_url = 'https://invoice.stripe.com/i/acct_SyntheticCompany123/test_SyntheticA'; value = state.invoice;
      } else if (request.method === 'GET' && request.path === '/v1/billing_portal/configurations/bpc_SyntheticCompany') value = state.portal;
      else if (request.method === 'POST' && request.path === '/v1/billing_portal/sessions') value = { object: 'billing_portal.session', id: 'bps_SyntheticA',
        configuration: request.body.get('configuration'), customer: request.body.get('customer'), customer_account: null, return_url: request.body.get('return_url'), url: 'https://billing.stripe.com/p/session/test_SyntheticA' };
      else if (request.method === 'GET' && request.path === '/v1/credit_notes/cn_SyntheticA') value = state.credit;
      else if (request.method === 'GET' && request.path === '/v1/charges/ch_SyntheticA') value = state.charge;
      else assert.fail(`Unexpected fixture request ${request.method} ${request.path}`);
      assert.ok(value, 'fixture object must exist');
      if (request.method === 'POST') accepted.set(cacheKey, { body: request.body.toString(), value: clone(value) });
      if (state.failAfter?.(request)) throw new Error('SYNTHETIC_PRIVATE_PROVIDER_BODY_AND_KEY');
      return json(value);
    }),
  });
  const provider = new StripeCompanyProvider(config(overrides), sdk);
  const writes = () => requests.filter(request => request.method === 'POST');
  const signed = (body: unknown, when = NOW / 1000) => { const raw = Buffer.from(JSON.stringify(body)); return { raw, signature: sdk.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: WEBHOOK_SECRET, timestamp: when }) }; };
  return { provider, sdk, state, requests, writes, signed, accepted };
}

test('configuration is explicit, mode-bound, company-only and loopback is test-only', () => {
  for (const bad of [
    { secretKey: syntheticKey('live') }, { automaticTaxEnabled: undefined }, { invoiceDaysUntilDue: undefined },
    { invoiceDaysUntilDue: 0 }, { integrationIdentifier: 'unscoped' }, { publicOrigin: 'http://www.onesa.eu' },
    { publicOrigin: 'https://user:password@www.onesa.eu' }, { publicOrigin: 'https://www.onesa.eu/billing' },
    { scope: { ...scope, application: 'pasofi' } },
  ]) assert.throws(() => new StripeCompanyProvider(config(bad as Partial<StripeProviderConfig>)), BillingError);
  assert.throws(() => new StripeCompanyProvider(config({ scope: { ...scope, mode: 'live' }, secretKey: syntheticKey('live') })), { code: 'stripe_live_unqualified' });
  assert.throws(() => new StripeCompanyProvider(config({ scope: { ...scope, mode: 'live' }, secretKey: syntheticKey('live'), liveQualified: true, publicOrigin: 'http://127.0.0.1:8080' })), BillingError);
  assert.doesNotThrow(() => new StripeCompanyProvider(config({ publicOrigin: 'http://127.0.0.1:8080', automaticTaxEnabled: false })));
});

test('durably started operation, exact scope and replay budget are required before provider writes', async () => {
  for (const operation of [op('a', { firstAttemptAt: null }), op('b', { scope: { ...scope, configVersion: 'changed' } }),
    op('c', { firstAttemptAt: new Date(NOW - STRIPE_OPERATION_REPLAY_MS).toISOString(), createdAt: new Date(NOW - STRIPE_OPERATION_REPLAY_MS - 1).toISOString() }),
    op('d', { firstAttemptAt: new Date(NOW + 1).toISOString() })]) {
    const f = fixture(); await assert.rejects(f.provider.createCheckout(operation, binding, lines()), BillingError); assert.equal(f.requests.length, 0);
  }
});

test('wrong account or customer binding stops writes and mode-crossed objects are refused', async () => {
  const f = fixture(); f.state.account.id = 'acct_Other';
  await assert.rejects(f.provider.createCheckout(op(), binding, lines()), { code: 'stripe_account_mismatch' }); assert.equal(f.writes().length, 0);
  const g = fixture(); g.state.customer.metadata.onesa_account_id = 'company-account-other';
  await assert.rejects(g.provider.createCheckout(op(), binding, lines()), { code: 'stripe_customer_scope_mismatch' }); assert.equal(g.writes().length, 0);
  const h = fixture(); h.state.customer.livemode = true;
  await assert.rejects(h.provider.createCheckout(op(), binding, lines()), { code: 'stripe_object_mode_mismatch' }); assert.equal(h.writes().length, 0);
});

test('Customer creation is idempotent and never searches or binds by email', async () => {
  const f = fixture(), operation = op('customer-a');
  const a = await f.provider.ensureCustomer(operation, null, { name: 'Synthetic Company', email: 'billing@example.invalid' });
  const b = await f.provider.ensureCustomer(operation, null, { name: 'Synthetic Company', email: 'billing@example.invalid' });
  assert.deepEqual(a, b); assert.equal(f.state.createdCustomers, 1);
  await f.provider.ensureCustomer(op('later-a'), a);
  assert.equal(f.state.createdCustomers, 1);
  assert.equal(f.requests.some(request => request.path.includes('search') || request.query.has('email')), false);
  const writes = f.writes(); assert.equal(writes.length, 2); assert.equal(writes[0]!.headers.get('idempotency-key'), writes[1]!.headers.get('idempotency-key'));
  assert.equal(writes[0]!.body.get('metadata[onesa_integration_identifier]'), integrationIdentifier);
  assert.equal(JSON.stringify(a).includes('billing@example.invalid'), false);
});

test('hosted Checkout serializes the pinned SDK contract and returns no browser fulfillment authority', async () => {
  const f = fixture(), result = await f.provider.createCheckout(op(), binding, lines());
  const request = f.writes().find(item => item.path === '/v1/checkout/sessions')!;
  assert.equal(request.headers.get('stripe-version'), STRIPE_API_VERSION);
  for (const [key, value] of Object.entries({ ui_mode: 'hosted_page', mode: 'payment', integration_identifier: integrationIdentifier, customer: binding.customerId,
    'line_items[0][price]': 'price_Consulting', 'line_items[0][quantity]': '2', 'automatic_tax[enabled]': 'true',
    'invoice_creation[enabled]': 'false', 'adaptive_pricing[enabled]': 'false', 'allowed_payment_method_types[0]': 'card',
    'customer_update[address]': 'auto', 'tax_id_collection[enabled]': 'true' })) assert.equal(request.body.get(key), value, key);
  assert.equal(request.body.get('success_url'), 'https://www.onesa.eu/account/billing');
  assert.equal(request.body.get('cancel_url'), 'https://www.onesa.eu/account/billing');
  assert.equal([...request.body.keys()].some(key => key.includes('price_data') || key === 'amount' || key.includes('subscription')), false);
  assert.equal(result.paymentConfirmed, false); assert.equal(result.status, 'open');
  assert.equal(JSON.stringify(result).includes('client_secret'), false); assert.equal(JSON.stringify(result).includes('private-fixture'), false);
  f.state.session!.status = 'complete'; f.state.session!.payment_status = 'paid';
  assert.equal((await f.provider.retrieveCheckout(result.id)).paymentConfirmed, false, 'Tax completion remains part of the configured settlement contract');
  f.state.session!.automatic_tax.status = 'complete';
  assert.equal((await f.provider.retrieveCheckout(result.id)).paymentConfirmed, true);
});

test('Tax is never implicitly enabled and unconfigured settings cannot silently become zero tax', async () => {
  const disabled = fixture({ automaticTaxEnabled: false }); disabled.state.tax.status = 'pending';
  const checkout = await disabled.provider.createCheckout(op(), binding, lines());
  assert.equal(checkout.automaticTaxEnabled, false); assert.equal(disabled.requests.some(item => item.path === '/v1/tax/settings'), false);
  assert.equal(disabled.writes()[0]!.body.get('automatic_tax[enabled]'), 'false');
  const enabled = fixture(); enabled.state.tax.status = 'pending';
  await assert.rejects(enabled.provider.createCheckout(op(), binding, lines()), { code: 'stripe_tax_settings_incomplete' }); assert.equal(enabled.writes().length, 0);
});

test('Tax-enabled mutations require a complete current registration observation, not settings alone', async () => {
  for (const change of [
    (value: Fixture) => { value.data = []; },
    (value: Fixture) => { value.has_more = true; },
    (value: Fixture) => { value.data[0].active_from = NOW / 1000 + 1; },
    (value: Fixture) => { value.data[0].expires_at = NOW / 1000; },
  ]) {
    const f = fixture(); change(f.state.registrations);
    await assert.rejects(f.provider.createCheckout(op(), binding, lines()), { code: 'stripe_tax_registration_unqualified' });
    assert.equal(f.writes().length, 0);
  }
});

test('one-off handlers reject metered and mutated catalogs before a charge or draft is created', async () => {
  const metered = lines(); metered[0]!.item.kind = 'metered';
  for (const method of ['createCheckout', 'createDraftInvoice'] as const) {
    const f = fixture(); await assert.rejects(f.provider[method](op(), binding, metered), { code: 'stripe_metered_catalog_refused' }); assert.equal(f.requests.length, 0);
  }
  for (const field of ['active', 'unit_amount', 'currency', 'tax_behavior', 'livemode', 'type'] as const) {
    const f = fixture(); const price = f.state.prices.get('price_Consulting')!;
    price[field] = ({ active: false, unit_amount: 999, currency: 'eur', tax_behavior: 'inclusive', livemode: true, type: 'recurring' })[field];
    await assert.rejects(f.provider.createCheckout(op(), binding, lines()), BillingError); assert.equal(f.writes().length, 0, field);
  }
});

test('provider calls snapshot mutable arguments before awaiting account and catalog reads', async () => {
  const f = fixture(), operation = op(), customer = clone(binding), selected = lines(); let changed = false;
  f.state.before = request => {
    if (!changed && request.path === '/v1/account') { changed = true; customer.customerId = 'cus_Other'; operation.accountId = 'other'; selected[0]!.item.priceId = 'price_Other'; selected[0]!.quantity = 9; }
  };
  const result = await f.provider.createCheckout(operation, customer, selected);
  assert.equal(result.accountId, binding.accountId);
  assert.equal(f.writes()[0]!.body.get('customer'), binding.customerId); assert.equal(f.writes()[0]!.body.get('line_items[0][quantity]'), '2');
  assert.equal(f.writes()[0]!.body.get('line_items[0][price]'), 'price_Consulting');
});

test('stable step keys do not depend on JavaScript scope property insertion order', async () => {
  const a = fixture(), reordered: ProviderScope = { configVersion: scope.configVersion, mode: scope.mode, stripeAccountId: scope.stripeAccountId, application: scope.application };
  const b = fixture({ scope: reordered }); await a.provider.createCheckout(op(), binding, lines()); await b.provider.createCheckout(op(), binding, lines());
  assert.equal(a.writes()[0]!.headers.get('idempotency-key'), b.writes()[0]!.headers.get('idempotency-key'));
});

test('draft invoices exclude pending items and bind every line to the exact invoice without finalizing', async () => {
  const f = fixture(), result = await f.provider.createDraftInvoice(op(), binding, lines());
  const created = f.writes()[0]!, item = f.writes()[1]!;
  for (const [key, value] of Object.entries({ customer: binding.customerId, auto_advance: 'false', collection_method: 'send_invoice', days_until_due: '14', pending_invoice_items_behavior: 'exclude', 'automatic_tax[enabled]': 'true' })) assert.equal(created.body.get(key), value);
  assert.equal(item.body.get('invoice'), result.id); assert.equal(item.body.get('customer'), binding.customerId); assert.equal(item.body.get('pricing[price]'), 'price_Consulting');
  assert.notEqual(item.headers.get('idempotency-key'), created.headers.get('idempotency-key'));
  assert.equal(result.status, 'draft'); assert.equal(result.autoAdvance, false); assert.equal(result.hostedInvoiceUrl, null); assert.equal(result.linesComplete, true);
  assert.equal(f.requests.some(request => /\/(finalize|send|pay)$/.test(request.path)), false);
});

test('a lost response after a draft line was accepted replays the same steps without adding another line', async () => {
  const f = fixture(); let fail = true;
  f.state.failAfter = request => request.path === '/v1/invoiceitems' && fail && (fail = false, true);
  await assert.rejects(f.provider.createDraftInvoice(op(), binding, lines()), { code: 'stripe_outcome_unknown' });
  assert.equal(f.state.items.length, 1); assert.equal(f.state.invoice!.status, 'draft');
  const recovered = await f.provider.createDraftInvoice(op(), binding, lines());
  assert.equal(recovered.status, 'draft'); assert.equal(f.state.items.length, 1);
  const itemCalls = f.writes().filter(request => request.path === '/v1/invoiceitems'); assert.equal(itemCalls.length, 2);
  assert.equal(itemCalls[0]!.headers.get('idempotency-key'), itemCalls[1]!.headers.get('idempotency-key'));
});

test('draft finalization is a separate operation and never sends or pays the invoice', async () => {
  const f = fixture(), draft = await f.provider.createDraftInvoice(op(), binding, lines());
  const result = await f.provider.finalizeDraftInvoice(op('finalize-a'), binding, draft.id, lines());
  assert.equal(result.status, 'open'); assert.ok(result.hostedInvoiceUrl); assert.equal(result.autoAdvance, false);
  const finalized = f.writes().filter(request => request.path.endsWith('/finalize')); assert.equal(finalized.length, 1); assert.equal(finalized[0]!.body.get('auto_advance'), 'false');
  await f.provider.finalizeDraftInvoice(op('finalize-a'), binding, draft.id, lines()); assert.equal(f.writes().filter(request => request.path.endsWith('/finalize')).length, 1);
  assert.equal(f.requests.some(request => /\/(send|pay)$/.test(request.path)), false);
});

test('invoice line, customer and operation mismatches cannot be finalized', async () => {
  for (const mutation of [
    (invoice: Fixture) => { invoice.metadata.onesa_intent_id = 'other-intent'; },
    (invoice: Fixture) => { invoice.lines.data[0].pricing.price_details.price = 'price_Other'; },
    (invoice: Fixture) => { invoice.auto_advance = true; },
  ]) {
    const f = fixture(), draft = await f.provider.createDraftInvoice(op(), binding, lines()); mutation(f.state.invoice!);
    await assert.rejects(f.provider.finalizeDraftInvoice(op('finalize-a'), binding, draft.id, lines()), BillingError);
    assert.equal(f.requests.some(request => request.path.endsWith('/finalize')), false);
  }
});

test('manual finalization binds exact money even when genuine Price IDs, quantities and metadata remain', async () => {
  for (const mutation of [
    (invoice: Fixture) => { invoice.lines.data[0].amount = 2001; },
    (invoice: Fixture) => { invoice.lines.data[0].pricing.unit_amount_decimal = '1000.01'; },
    (invoice: Fixture) => { invoice.lines.data[0].quantity_decimal = '2.5'; },
    (invoice: Fixture) => { invoice.lines.data[0].discounts = ['di_Unexpected']; },
    (invoice: Fixture) => { invoice.discounts = ['di_Unexpected']; },
    (invoice: Fixture) => { invoice.total_pretax_credit_amounts = [{ amount: 1 }]; },
    (invoice: Fixture) => { invoice.amount_shipping = 1; },
    (invoice: Fixture) => { invoice.subtotal = 1999; },
    (invoice: Fixture) => { invoice.total = 2001; },
  ]) {
    const f = fixture(), draft = await f.provider.createDraftInvoice(op(), binding, lines()); mutation(f.state.invoice!);
    await assert.rejects(f.provider.finalizeDraftInvoice(op('finalize-a'), binding, draft.id, lines()), BillingError);
    assert.equal(f.requests.some(request => request.path.endsWith('/finalize')), false);
  }
});

test('Tax preflight is bounded/read-only and distinguishes settings from collection qualification', async () => {
  const f = fixture(); f.state.registrations.has_more = true;
  const result = await f.provider.taxPreflight();
  assert.equal(result.settingsStatus, 'active'); assert.equal(result.activeRegistrationCount, 1); assert.equal(result.registrationsComplete, false);
  assert.equal(result.collectionReadiness, 'not_determined_by_settings'); assert.equal(f.writes().length, 0);
  const list = f.requests.find(request => request.path === '/v1/tax/registrations')!; assert.equal(list.query.get('limit'), '100'); assert.equal(list.query.get('status'), 'active');
  f.state.registrations.data[0].livemode = true; await assert.rejects(f.provider.taxPreflight(), { code: 'stripe_object_mode_mismatch' });
});

test('portal sessions use only the owned customer, pinned mode-specific configuration and server return target', async () => {
  const f = fixture(), result = await f.provider.createPortal(op(), binding);
  const request = f.writes()[0]!; assert.equal(request.path, '/v1/billing_portal/sessions');
  assert.deepEqual([...request.body.entries()].sort(), [['configuration', 'bpc_SyntheticCompany'], ['customer', binding.customerId], ['return_url', 'https://www.onesa.eu/account/billing']].sort());
  assert.equal(result.hostedUrl, 'https://billing.stripe.com/p/session/test_SyntheticA');
  const wrong = fixture(); wrong.state.portal.livemode = true; await assert.rejects(wrong.provider.createPortal(op(), binding), BillingError); assert.equal(wrong.writes().length, 0);
});

function snapshot(changes: Fixture = {}): Fixture {
  return { object: 'event', id: 'evt_SyntheticSnapshot', type: 'checkout.session.completed', api_version: STRIPE_API_VERSION, created: NOW / 1000, livemode: false,
    data: { object: { object: 'checkout.session', id: 'cs_test_SyntheticA', customer_email: 'private-fixture@example.invalid', client_secret: 'SYNTHETIC-DO-NOT-PROJECT' } }, ...changes };
}
function thin(changes: Fixture = {}): Fixture {
  return { object: 'v2.core.event', id: 'evt_SyntheticThin', type: 'v1.invoice.paid', created: new Date(NOW).toISOString(), livemode: false,
    related_object: { id: 'in_SyntheticA', type: 'v1.invoice', url: '/v1/invoices/in_SyntheticA' }, ...changes };
}
test('snapshot verification preserves raw signatures/version and projects no customer or secret payload', () => {
  const f = fixture(), signed = f.signed(snapshot()), result = f.provider.parseSignedEvent(signed.raw, signed.signature)!;
  assert.deepEqual(Object.keys(result).sort(), ['stripeAccountId', 'mode', 'eventId', 'type', 'objectId', 'objectType', 'createdAt', 'bodySha256', 'format'].sort());
  assert.equal(result.format, 'snapshot'); assert.equal(result.objectId, 'cs_test_SyntheticA'); assert.equal(result.bodySha256, createHash('sha256').update(signed.raw).digest('hex'));
  assert.equal(JSON.stringify(result).includes('private-fixture'), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC-DO-NOT'), false); assert.equal(f.requests.length, 0);
  assert.throws(() => f.provider.parseSignedEvent(Buffer.concat([signed.raw, Buffer.from(' ')]), signed.signature), { code: 'stripe_webhook_invalid' });
  for (const changes of [{ api_version: '2025-01-27.acacia' }, { livemode: true }, { account: 'acct_Other' }, { context: 'acct_Other' }]) {
    const bad = f.signed(snapshot(changes)); assert.throws(() => f.provider.parseSignedEvent(bad.raw, bad.signature), BillingError);
  }
});

test('customer.created can recover the exact original lost-response operation without email ownership', async () => {
  const f = fixture(), signed = f.signed(snapshot({ type: 'customer.created', data: { object: { object: 'customer', id: binding.customerId } } }));
  const event = f.provider.parseSignedEvent(signed.raw, signed.signature)!;
  const result = await f.provider.retrieveVerifiedObject(event);
  assert.equal(result.accountId, binding.accountId);
  assert.equal('operationId' in result && result.operationId, op().id);
  assert.equal('commercialIntentId' in result && result.commercialIntentId, op().commercialIntentId);
  assert.equal('fingerprint' in result && result.fingerprint, op().fingerprint);
  assert.equal('customerId' in result && result.customerId, binding.customerId);
  assert.equal(JSON.stringify(result).includes('private-fixture'), false); assert.equal(f.writes().length, 0);
});

test('thin v1 notifications use SDK verification and a fixed resource mapping without following supplied URLs', () => {
  const f = fixture(), signed = f.signed(thin()), result = f.provider.parseSignedEvent(signed.raw, signed.signature)!;
  assert.equal(result.format, 'thin'); assert.equal(result.type, 'invoice.paid'); assert.equal(result.objectType, 'invoice'); assert.equal(result.objectId, 'in_SyntheticA'); assert.equal(f.requests.length, 0);
  for (const related of [
    { id: 'in_SyntheticA', type: 'v1.invoice', url: 'https://attacker.invalid/private' },
    { id: 'in_SyntheticA', type: 'v1.invoice', url: '/v1/invoices/in_Other' },
    { id: 'in_SyntheticA', type: 'v1.customer', url: '/v1/invoices/in_SyntheticA' },
    { id: '../private', type: 'v1.invoice', url: '/private' },
  ]) { const bad = f.signed(thin({ related_object: related })); assert.throws(() => f.provider.parseSignedEvent(bad.raw, bad.signature), BillingError); }
  assert.equal(f.requests.length, 0);
});

test('webhook payload bounds, past/future signatures and unsupported event types fail safely', () => {
  const f = fixture();
  for (const when of [NOW / 1000 - 301, NOW / 1000 + 301]) { const signed = f.signed(snapshot(), when); assert.throws(() => f.provider.parseSignedEvent(signed.raw, signed.signature), { code: 'stripe_webhook_invalid' }); }
  assert.throws(() => f.provider.parseSignedEvent(Buffer.alloc(256 * 1024 + 1), 'unused'), BillingError);
  for (const type of ['customer.source.created', '__proto__', 'toString', 'v2.core.account.created']) { const signed = f.signed(snapshot({ type })); assert.equal(f.provider.parseSignedEvent(signed.raw, signed.signature), null); }
  assert.equal(f.requests.length, 0);
});

test('fresh retrieval rejects a changed customer, foreign integration and incomplete manual line inventory', async () => {
  const f = fixture(); await f.provider.createCheckout(op(), binding, lines());
  f.state.session!.metadata.onesa_integration_identifier = 'onesa_company_zzzzzzzz';
  await assert.rejects(f.provider.retrieveCheckout('cs_test_SyntheticA'), { code: 'stripe_object_scope_mismatch' });
  f.state.session!.metadata.onesa_integration_identifier = integrationIdentifier; f.state.lineHasMore = true;
  await assert.rejects(f.provider.retrieveCheckout('cs_test_SyntheticA'), { code: 'stripe_line_inventory_incomplete' });
  f.state.lineHasMore = false; f.state.customer.metadata.onesa_account_id = 'other';
  await assert.rejects(f.provider.retrieveCheckout('cs_test_SyntheticA'), { code: 'stripe_customer_scope_mismatch' });
});

test('Metronome invoices require an exact server binding and retain honest partial line projections', async () => {
  const f = fixture(); await f.provider.createDraftInvoice(op(), binding, lines()); f.state.invoice!.metadata = {};
  await assert.rejects(f.provider.retrieveInvoice('in_SyntheticA'), { code: 'stripe_external_invoice_unbound' });
  const owner: ExternalInvoiceOwner = { source: 'metronome', invoiceId: 'in_SyntheticA', customerId: binding.customerId, accountId: binding.accountId, scope, integrationIdentifier };
  const g = fixture({ resolveExternalInvoiceOwner: async () => owner });
  await g.provider.createDraftInvoice(op(), binding, lines()); g.state.invoice!.metadata = {}; g.state.lineHasMore = true;
  g.state.invoice!.lines.data[0].pricing = null; g.state.invoice!.lines.data[0].quantity = null;
  const result = await g.provider.retrieveInvoice('in_SyntheticA'); assert.equal(result.origin, 'external'); assert.equal(result.linesComplete, false);
  assert.equal(result.lines[0]!.priceId, null); assert.equal(result.lines[0]!.quantity, null);
  owner.customerId = 'cus_Other'; await assert.rejects(g.provider.retrieveInvoice('in_SyntheticA'), { code: 'stripe_external_invoice_unbound' });
});

test('credit and charge projections are owned, mode-checked and omit raw provider private fields', async () => {
  const f = fixture(); await f.provider.createDraftInvoice(op(), binding, lines());
  const creditRaw = f.signed(snapshot({ type: 'credit_note.created', data: { object: { object: 'credit_note', id: 'cn_SyntheticA' } } }));
  const credit = await f.provider.retrieveVerifiedObject(f.provider.parseSignedEvent(creditRaw.raw, creditRaw.signature)!);
  assert.equal('invoiceId' in credit && credit.invoiceId, 'in_SyntheticA'); assert.equal(JSON.stringify(credit).includes('MEMO'), false);
  const chargeRaw = f.signed(snapshot({ type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_SyntheticA' } } }));
  const charge = await f.provider.retrieveVerifiedObject(f.provider.parseSignedEvent(chargeRaw.raw, chargeRaw.signature)!);
  assert.equal('amountRefunded' in charge && charge.amountRefunded, 500); assert.equal(JSON.stringify(charge).includes('private-fixture'), false);
  f.state.credit.customer = 'cus_Other'; await assert.rejects(f.provider.retrieveVerifiedObject(f.provider.parseSignedEvent(creditRaw.raw, creditRaw.signature)!), { code: 'stripe_credit_note_binding_mismatch' });
});

test('unknown write outcomes and read errors are redacted; provider serialization contains no credentials', async () => {
  const f = fixture(); f.state.failAfter = request => request.path === '/v1/checkout/sessions';
  await assert.rejects(f.provider.createCheckout(op(), binding, lines()), error => error instanceof BillingError && error.code === 'stripe_outcome_unknown' && error.message === 'stripe_outcome_unknown' && !('cause' in error));
  assert.ok(f.state.session, 'the ambiguous operation may have succeeded at the provider');
  const serialized = JSON.stringify(f.provider); assert.equal(serialized.includes(KEY), false); assert.equal(serialized.includes(WEBHOOK_SECRET), false);
  const g = fixture(); g.state.before = () => { throw Error('PRIVATE-DSN-OR-CUSTOMER-DATA'); };
  await assert.rejects(g.provider.verifyAccount(), error => error instanceof BillingError && error.message === 'stripe_unavailable');
});


test('pure intent validation refuses partial webhook drafts and changed checkout amounts without provider calls', async () => {
  const f = fixture(), selected = lines();
  const invoice = await f.provider.createDraftInvoice(op(), binding, selected);
  const checkout = await f.provider.createCheckout(op(), binding, selected);
  const count = f.requests.length;
  validateProjectionForIntent(invoice, selected); validateProjectionForIntent(checkout, selected);
  assert.throws(() => validateProjectionForIntent({ ...invoice, lines: [] }, selected), /stripe_invoice_lines_mismatch/u);
  assert.throws(() => validateProjectionForIntent({ ...invoice, linesComplete: false }, selected), /stripe_invoice_money_mismatch/u);
  for (const altered of [
    { ...checkout, lines: [] }, { ...checkout, amountTotal: checkout.amountTotal + 1 },
    { ...checkout, amountTax: 1 }, { ...checkout, amountShipping: 1 }, { ...checkout, amountDiscount: 1 },
    { ...checkout, amountSubtotal: checkout.amountSubtotal - 1, lines: checkout.lines.map(line => ({ ...line, amountSubtotal: line.amountSubtotal - 1 })) },
    { ...checkout, lines: checkout.lines.map(line => ({ ...line, unitAmount: line.unitAmount + 1 })) },
    { ...checkout, lines: checkout.lines.map(line => ({ ...line, amountTotal: line.amountTotal + 1 })) },
  ]) assert.throws(() => validateProjectionForIntent(altered, selected), BillingError);
  assert.equal(f.requests.length, count, 'pure reconciliation checks must never make provider requests');
});


test('pure money validation handles inclusive/exclusive tax and refuses Tax-disabled invoice adjustments', async () => {
  const f = fixture(), selected = lines();
  const invoice = await f.provider.createDraftInvoice(op(), binding, selected);
  const checkout = await f.provider.createCheckout(op(), binding, selected);
  const taxed = { ...checkout, amountTotal: 2400, amountTax: 400,
    lines: checkout.lines.map(line => ({ ...line, amountTotal: 2400, amountTax: 400 })) };
  validateProjectionForIntent(taxed, selected);
  const inclusiveLines = selected.map(line => ({ ...line, item: { ...line.item, taxBehavior: 'inclusive' as const } }));
  const inclusive = { ...checkout, amountSubtotal: 1600, amountTax: 400,
    lines: checkout.lines.map(line => ({ ...line, taxBehavior: 'inclusive' as const, amountSubtotal: 1600, amountTax: 400 })) };
  validateProjectionForIntent(inclusive, inclusiveLines);
  assert.throws(() => validateProjectionForIntent({ ...inclusive, amountSubtotal: 2000,
    lines: inclusive.lines.map(line => ({ ...line, amountSubtotal: 2000 })) }, inclusiveLines), /stripe_checkout_money_mismatch/u);
  for (const adjustment of [{ exclusiveTaxTotal: 400, totalTax: 400, total: 2400 }, { exclusiveTaxTotal: 0, totalTax: 400 }]) {
    assert.throws(() => validateProjectionForIntent({ ...invoice, automaticTaxEnabled: false, ...adjustment }, selected), /stripe_invoice_money_mismatch/u);
  }
});
