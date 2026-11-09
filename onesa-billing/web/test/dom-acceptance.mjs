import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mountBilling } from '../mount.mjs';

// Explicit, scratch-only harness. This is DOM acceptance, never a browser/layout substitute.
if (!process.env.BILLING_DOM_HARNESS) throw Error('BILLING_DOM_HARNESS must name the separately installed pinned jsdom harness');
const { JSDOM } = await import(pathToFileURL(join(process.env.BILLING_DOM_HARNESS, 'node_modules/jsdom/lib/api.js')).href);
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '20000000-0000-4000-8000-000000000001';
const INTENT = '30000000-0000-4000-8000-000000000001';
const CHECKOUT = '40000000-0000-4000-8000-000000000001';
const INVOICE = '40000000-0000-4000-8000-000000000002';
const PREFIX = '/api/v1/account/billing';
const account = { id: ACCOUNT, displayName: 'Example account', status: 'active', revision: 1, role: 'owner' };
const catalog = { mode: 'test', salesEnabled: true, items: [{ sku: 'support-session', title: 'Support session', version: 'v1',
  currency: 'eur', unitAmount: 12000, maxQuantity: 4, taxBehavior: 'exclusive' }] };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(action, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (action()) return; await pause(5); }
  throw Error(message);
}
function operation(overrides = {}) {
  return { id: CHECKOUT, accountId: ACCOUNT, commercialIntentId: INTENT, kind: 'checkout_create', state: 'succeeded',
    providerState: 'open.unpaid', reviewRequired: false, paymentConfirmed: false,
    redirectUrl: 'https://checkout.stripe.com/c/pay/synthetic', ...overrides };
}
function fixture(options = {}) {
  const state = { accounts: [account], operations: [], calls: [], navigations: [], sessionExpired: 0, creates: 0, submits: 0,
    failSubmit: false, expired: false, malicious: false, customerUnknown: false, catalog, ...options };
  let dom, mounted;
  const fetcher = async (url, init) => {
    assert.ok(url.startsWith(PREFIX + '/')); assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, undefined);
    const path = url.slice(PREFIX.length), body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ path, method: init.method, key: init.headers['Idempotency-Key'], body });
    const json = (value, status = 200) => Response.json(value, { status });
    if (state.expired) return json({ error: { code: 'AUTH_REQUIRED' } }, 401);
    if (init.method === 'POST') assert.equal(init.headers['X-CSRF-Token'], 'a'.repeat(64));
    if (path === '/catalog') return json(state.catalog);
    if (path === '/accounts' && init.method === 'GET') return json(state.accounts);
    if (path === '/accounts') { state.accounts = [{ ...account, displayName: body.displayName }]; return json(state.accounts[0], 201); }
    if (path === `/accounts/${ACCOUNT}/operations`) return json(state.operations);
    if (path === `/accounts/${ACCOUNT}/customer`) return json(operation({ id: CUSTOMER, commercialIntentId: ACCOUNT,
      kind: 'customer_create', state: state.customerUnknown ? 'unknown' : 'succeeded', providerState: state.customerUnknown ? null : 'created',
      reviewRequired: state.customerUnknown, redirectUrl: null }), 202);
    if (path === `/accounts/${ACCOUNT}/intents`) return json({ id: INTENT, accountId: ACCOUNT, kind: 'checkout', items: body.items }, 201);
    if (path === `/accounts/${ACCOUNT}/intents/${INTENT}/submit`) {
      state.submits++;
      if (!state.operations.some(value => value.id === CHECKOUT)) { state.creates++; state.operations.push(operation()); }
      if (state.failSubmit && state.submits === 1) return json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
      return json(operation({ redirectUrl: state.malicious ? 'https://evil.invalid/redirect' : 'https://checkout.stripe.com/c/pay/synthetic' }), 202);
    }
    if (path === `/operations/${CHECKOUT}`) return json(state.operations.find(value => value.id === CHECKOUT));
    if (path === `/operations/${INVOICE}`) return json(state.operations.find(value => value.id === INVOICE));
    throw Error('Unexpected synthetic route');
  };
  function open() {
    dom = new JSDOM('<!doctype html><html><body><main id="billing"></main></body></html>', { url: 'https://portal.onesa.eu/account/billing' });
    mounted = mountBilling(dom.window.document.querySelector('#billing'), { csrf: () => 'a'.repeat(64), fetch: fetcher,
      navigate: url => state.navigations.push(url), onSessionExpired: () => { state.sessionExpired++; } });
  }
  open();
  return {
    state,
    get document() { return dom.window.document; },
    async ready() { await until(() => dom.window.document.querySelector('.onesa-billing')?.getAttribute('aria-busy') === 'false', 'Mount did not settle'); },
    button(text) { return [...dom.window.document.querySelectorAll('button')].find(value => value.textContent === text); },
    async click(text) { const button = this.button(text); assert.ok(button && !button.disabled, 'Expected enabled ' + text); button.focus(); button.click(); await this.ready(); },
    async reload() { mounted.destroy(); dom.window.close(); open(); await this.ready(); },
    submit() { dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); },
    close() { mounted.destroy(); dom.window.close(); },
  };
}

test('DOM account creation and customer preparation lead to the exact hosted Checkout target', async () => {
  const f = fixture({ accounts: [] });
  try {
    await f.ready(); f.document.querySelector('input[name=displayName]').value = 'Example business'; f.submit(); await f.ready();
    assert.equal(f.document.querySelector('option').textContent, 'Example business');
    await f.click('Pay securely');
    assert.deepEqual(f.state.navigations, ['https://checkout.stripe.com/c/pay/synthetic']);
    assert.equal(f.state.calls.filter(value => value.method === 'POST' && value.path === '/accounts').length, 1);
    assert.equal(f.state.calls.filter(value => value.path.endsWith('/customer')).length, 1);
    assert.equal(f.state.creates, 1); assert.equal(f.state.submits, 1);
  } finally { f.close(); }
});

test('DOM unknown submit recovery adopts authenticated history with no duplicate POST', async () => {
  const f = fixture({ failSubmit: true });
  try {
    await f.ready(); await f.click('Pay securely');
    assert.match(f.document.querySelector('[role=alert]').textContent, /could not confirm/);
    assert.equal(f.button('Pay securely').disabled, true);
    await f.click('Check current purchase'); await f.click('Continue checkout');
    assert.equal(f.state.submits, 1); assert.equal(f.state.creates, 1);
    assert.equal(f.state.calls.filter(value => value.path.endsWith('/intents')).length, 1);
    assert.equal(f.state.navigations.length, 1);
  } finally { f.close(); }
});

test('DOM reload preserves unconfirmed history and cannot start another purchase', async () => {
  const f = fixture();
  try {
    await f.ready(); await f.click('Pay securely'); const posts = f.state.calls.filter(value => value.method === 'POST').length;
    await f.reload();
    assert.equal(f.button('Pay securely').disabled, true);
    assert.equal(f.state.calls.filter(value => value.method === 'POST').length, posts);
    assert.match(f.document.body.textContent, /already awaiting a result/);
  } finally { f.close(); }
});

test('DOM redirects reject foreign hosts and product text is rendered without HTML execution', async () => {
  const f = fixture({ malicious: true, catalog: { ...catalog, items: [{ ...catalog.items[0], title: '<img src=x onerror=alert(1)>' }] } });
  try {
    await f.ready(); assert.equal(f.document.querySelector('h3').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(f.document.querySelectorAll('img,script').length, 0);
    await f.click('Pay securely'); assert.deepEqual(f.state.navigations, []);
    assert.ok(f.document.querySelector('[role=alert]'));
  } finally { f.close(); }
});

test('DOM invoice navigation reads current state and Paid requires explicit verified confirmation', async () => {
  const invoice = operation({ id: INVOICE, kind: 'invoice_finalize', providerState: 'open', redirectUrl: 'https://invoice.stripe.com/i/synthetic' });
  const f = fixture({ operations: [invoice] });
  try {
    await f.ready(); await f.click('View invoice'); assert.deepEqual(f.state.navigations, ['https://invoice.stripe.com/i/synthetic']);
    assert.equal([...f.document.querySelectorAll('.onesa-billing-history p')].some(value => value.textContent === 'Paid'), false);
    f.state.operations[0] = { ...invoice, providerState: 'paid', paymentConfirmed: true, redirectUrl: null };
    await f.click('Check status');
    assert.equal([...f.document.querySelectorAll('.onesa-billing-history p')].some(value => value.textContent === 'Paid'), true);
  } finally { f.close(); }
});

test('DOM session expiry requests existing sign-in without credential or token input', async () => {
  const f = fixture({ expired: true });
  try {
    await f.ready(); assert.equal(f.state.sessionExpired, 1);
    assert.match(f.document.querySelector('[role=alert]').textContent, /session has ended/);
    assert.equal(f.document.querySelectorAll('input,textarea').length, 0);
  } finally { f.close(); }
});

test('DOM viewer, paused sales, unknown customer and unsupported display currencies cannot submit Checkout', async () => {
  for (const options of [{ accounts: [{ ...account, role: 'viewer' }] }, { catalog: { ...catalog, salesEnabled: false } },
    { catalog: { ...catalog, items: [{ ...catalog.items[0], currency: 'bhd' }] } }]) {
    const f = fixture(options);
    try { await f.ready(); assert.equal(f.button('Pay securely').disabled, true); assert.equal(f.state.submits, 0); }
    finally { f.close(); }
  }
  const f = fixture({ customerUnknown: true });
  try {
    await f.ready(); await f.click('Pay securely'); assert.equal(f.state.submits, 0);
    assert.equal(f.state.calls.some(value => value.path.endsWith('/intents')), false);
    assert.equal(f.button('Pay securely').disabled, true); assert.match(f.document.body.textContent, /billing review/);
  } finally { f.close(); }
});

test('DOM failure feedback keeps focus in the billing region for keyboard recovery', async () => {
  const f = fixture({ failSubmit: true });
  try {
    await f.ready(); await f.click('Pay securely');
    assert.equal(f.document.activeElement.getAttribute('role'), 'alert');
    assert.equal(f.document.activeElement.textContent, f.document.querySelector('[role=alert]').textContent);
  } finally { f.close(); }
});

test('DOM destruction aborts pending reads and clears mounted content', async () => {
  const dom = new JSDOM('<main></main>'), element = dom.window.document.querySelector('main');
  let aborted = 0;
  const mounted = mountBilling(element, { csrf: () => 'a'.repeat(64), navigate: () => {}, fetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted++; reject(Error('synthetic abort')); }, { once: true });
  }) });
  mounted.destroy(); await until(() => aborted === 2, 'Pending requests did not abort');
  assert.equal(element.childElementCount, 0); dom.window.close();
});
