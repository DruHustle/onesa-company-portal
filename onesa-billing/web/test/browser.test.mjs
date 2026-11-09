import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHROMIUM = process.env.BILLING_CHROMIUM_EXECUTABLE || '/usr/bin/chromium';
if (!isAbsolute(CHROMIUM) || CHROMIUM.includes('\0')) throw Error('BILLING_CHROMIUM_EXECUTABLE must be an absolute executable path');
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const CUSTOMER = '20000000-0000-4000-8000-000000000001';
const INTENT = '30000000-0000-4000-8000-000000000001';
const CHECKOUT = '40000000-0000-4000-8000-000000000001';
const INVOICE = '40000000-0000-4000-8000-000000000002';
const PREFIX = '/api/v1/account/billing';
const PROOF = 'a'.repeat(64);
const account = { id: ACCOUNT, displayName: 'Example account', status: 'active', revision: 1, role: 'owner' };
const catalog = { mode: 'test', salesEnabled: true, items: [{ sku: 'support-session', title: 'Support session', version: 'v1',
  currency: 'eur', unitAmount: 12000, maxQuantity: 4, taxBehavior: 'exclusive' }] };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function operation(overrides = {}) {
  return { id: CHECKOUT, accountId: ACCOUNT, commercialIntentId: INTENT, kind: 'checkout_create', state: 'prepared',
    providerState: null, reviewRequired: false, ...overrides };
}
async function until(action, message, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { last = await action(); if (last) return last; } catch { /* bounded startup/DOM convergence */ }
    await delay(40);
  }
  throw Error(message);
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 1; this.pending = new Map(); this.external = [];
    this.bootstrap = { runtimeExceptions: 0, consoleErrors: 0, scriptLoadFailures: 0 };
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const waiter = this.pending.get(value.id);
        if (waiter) { clearTimeout(waiter.timer); this.pending.delete(value.id); value.error ? waiter.reject(Error('CDP command failed')) : waiter.resolve(value.result); }
      } else if (value.method === 'Network.requestWillBeSent') {
        const url = value.params.request.url;
        if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('data:') && url !== 'about:blank') this.external.push(new URL(url).origin);
      } else if (value.method === 'Runtime.exceptionThrown') {
        this.bootstrap.runtimeExceptions = Math.min(1024, this.bootstrap.runtimeExceptions + 1);
      } else if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') {
        this.bootstrap.consoleErrors = Math.min(1024, this.bootstrap.consoleErrors + 1);
      } else if ((value.method === 'Network.loadingFailed' && value.params.type === 'Script')
          || (value.method === 'Network.responseReceived' && value.params.type === 'Script' && value.params.response.status >= 400)) {
        this.bootstrap.scriptLoadFailures = Math.min(1024, this.bootstrap.scriptLoadFailures + 1);
      }
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP deadline')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error('Browser evaluation failed');
    return result.result.value;
  }
  async key(key, code, windowsVirtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  }
  close() { for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(Error('CDP closed')); } this.pending.clear(); this.socket.close(); }
}

test('real Chromium billing journey uses only synthetic same-origin APIs', { timeout: 120000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'onesa-billing-chromium-'));
  const assets = new Map();
  for (const name of ['client.mjs', 'mount.mjs', 'money.mjs', 'billing.css']) assets.set('/' + name, await readFile(join(ROOT, name)));
  assets.set('/foundation.css', await readFile(new URL('../../../onesa-company-portal-frontend/src/styles/onesa-foundation.css', import.meta.url)));
  const script = `import {mountBilling} from '/mount.mjs';window.fixture={expired:0,navigations:[],navigation:location.search};window.fixture.mount=mountBilling(document.querySelector('#billing'),{csrf:()=>${JSON.stringify(PROOF)},onSessionExpired:()=>{window.fixture.expired++},navigate:url=>{window.fixture.navigations.push(url)}});`;
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<link rel="stylesheet" href="/foundation.css"><link rel="stylesheet" href="/billing.css"><style>body{margin:0;background:var(--onesa-surface)}</style></head>'
    + '<body><main id="billing"></main><script type="module">' + script + '</script></body></html>';
  let state;
  const reset = (options = {}) => { state = { accounts: [account], operations: [], calls: [], expired: false, failSubmit: false,
    malicious: false, submits: 0, createdCheckouts: 0, ...options }; };
  reset();
  const receivedRequests = { document: 0, module: 0, stylesheet: 0, api: 0, other: 0 };
  const server = createServer(async (request, reply) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const category = path === '/fixture' ? 'document' : assets.has(path) ? (path.endsWith('.css') ? 'stylesheet' : 'module')
      : path.startsWith(PREFIX + '/') ? 'api' : 'other';
    receivedRequests[category] = Math.min(1024, receivedRequests[category] + 1);
    const send = (value, status = 200) => { reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); reply.end(JSON.stringify(value)); };
    if (path === '/fixture') { reply.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); reply.end(html); return; }
    if (assets.has(path)) {
      reply.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' }); reply.end(assets.get(path)); return;
    }
    if (path === '/favicon.ico') { reply.writeHead(204); reply.end(); return; }
    if (!path.startsWith(PREFIX + '/')) { send({}, 404); return; }
    let body = '', input;
    for await (const chunk of request) { body += chunk; if (body.length > 65536) { send({}, 413); return; } }
    try { input = body ? JSON.parse(body) : undefined; } catch { send({}, 400); return; }
    state.calls.push({ path, method: request.method, key: request.headers['idempotency-key'] ?? null, body: input,
      csrfPresent: request.headers['x-csrf-token'] === PROOF, authorizationPresent: Boolean(request.headers.authorization) });
    if (state.expired) { send({ error: { code: 'AUTH_REQUIRED' } }, 401); return; }
    if (request.method !== 'GET' && request.headers['x-csrf-token'] !== PROOF) { send({ error: { code: 'CSRF' } }, 403); return; }
    const suffix = path.slice(PREFIX.length);
    if (suffix === '/catalog') { send(catalog); return; }
    if (suffix === '/accounts' && request.method === 'GET') { send(state.accounts); return; }
    if (suffix === '/accounts' && request.method === 'POST') { state.accounts = [{ ...account, displayName: input.displayName }]; send(state.accounts[0], 201); return; }
    if (suffix === `/accounts/${ACCOUNT}/operations`) { send(state.operations); return; }
    if (suffix === `/accounts/${ACCOUNT}/customer`) {
      send(operation({ id: CUSTOMER, commercialIntentId: ACCOUNT, kind: 'customer_create', state: 'succeeded', providerState: 'created' }), 202); return;
    }
    if (suffix === `/accounts/${ACCOUNT}/intents`) { send({ id: INTENT, accountId: ACCOUNT, kind: 'checkout', items: input.items }, 201); return; }
    if (suffix === `/accounts/${ACCOUNT}/intents/${INTENT}/submit`) {
      state.submits++;
      if (!state.operations.some(value => value.id === CHECKOUT)) { state.createdCheckouts++; state.operations.push(operation()); }
      if (state.failSubmit && state.submits === 1) { send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503); return; }
      send(operation(), 202); return;
    }
    if (suffix === `/operations/${CHECKOUT}`) {
      const current = operation({ state: 'succeeded', providerState: 'open.unpaid', paymentConfirmed: false,
        redirectUrl: state.malicious ? 'https://checkout.stripe.com.evil.invalid/steal' : 'https://checkout.stripe.com/c/pay/synthetic',
        amountMinor: 12000, currency: 'eur' });
      state.operations = [current, ...state.operations.filter(value => value.id !== CHECKOUT)]; send(current); return;
    }
    if (suffix === `/operations/${INVOICE}`) { send(state.operations.find(value => value.id === INVOICE)); return; }
    send({}, 404);
  });
  let chromium, cdp, chromiumError = '';
  const observations = { schema: 1, providerCalls: false, realCredentials: false, browser: null, cases: [],
    bootstrap: { navigationRequests: 0, navigationFailures: 0, nameResolutionFailures: 0, receivedRequests,
      runtimeExceptions: 0, consoleErrors: 0, scriptLoadFailures: 0 },
    sourcePins: Object.fromEntries([...assets].filter(([name]) => name !== '/foundation.css').map(([name, bytes]) =>
      [name.slice(1), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) };
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    chromium = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-extensions', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    chromium.stderr.on('data', value => { if (chromiumError.length < 8192) chromiumError += String(value).slice(0, 8192 - chromiumError.length); });
    chromium.once('error', () => {});
    let port;
    try { port = await until(async () => {
      const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); return Number(content.split('\n')[0]);
    }, 'Chromium did not start'); } catch {
      throw Error(`Chromium startup failed (exit=${chromium.exitCode}, signal=${chromium.signalCode}): ${chromiumError}`);
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); observations.browser = version.Browser;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(value => value.type === 'page'); assert.ok(target);
    const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open'); cdp = new Cdp(socket);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const ready = () => until(() => cdp.evaluate("Boolean(document.querySelector('.onesa-billing')) && document.querySelector('.onesa-billing').getAttribute('aria-busy') === 'false'"), 'Billing did not settle');
    let navigation = 0;
    const visit = async () => {
      const query = '?case=' + (++navigation);
      observations.bootstrap.navigationRequests++;
      const result = await cdp.send('Page.navigate', { url: origin + '/fixture' + query });
      if (result.errorText) {
        observations.bootstrap.navigationFailures++;
        if (result.errorText === 'net::ERR_NAME_NOT_RESOLVED') observations.bootstrap.nameResolutionFailures++;
        throw Error('Fixture navigation reported a transport error');
      }
      await until(() => cdp.evaluate(`window.fixture?.navigation === ${JSON.stringify(query)}`), 'Fixture navigation did not complete');
      await ready();
    };
    const click = async text => { await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(v=>v.textContent===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button');b.focus();b.click()})()`); };
    const hasText = text => until(() => cdp.evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`), 'Expected billing state did not appear');

    await t.test('creates an account and reaches hosted Checkout using keyboard input', async () => {
      reset({ accounts: [] }); await visit();
      await cdp.evaluate("document.querySelector('input[name=displayName]').value='Example business';document.querySelector('input[name=displayName]').focus()");
      await cdp.key('Enter', 'Enter', 13); await hasText('Your billing account is ready.'); await ready();
      assert.equal(state.calls.filter(value => value.method === 'POST' && value.path.endsWith('/accounts')).length, 1);
      await cdp.evaluate("document.querySelector('input[type=number]').focus()"); await cdp.key('Tab', 'Tab', 9);
      assert.equal(await cdp.evaluate('document.activeElement.textContent'), 'Pay securely');
      assert.equal(await cdp.evaluate("getComputedStyle(document.activeElement).outlineWidth"), '3px');
      await cdp.key('Enter', 'Enter', 13);
      await until(() => cdp.evaluate('window.fixture.navigations.length === 1'), 'Checkout URL was not reached'); await ready();
      assert.equal(await cdp.evaluate('window.fixture.navigations[0]'), 'https://checkout.stripe.com/c/pay/synthetic');
      assert.equal(state.calls.filter(value => value.path.endsWith('/customer')).length, 1);
      assert.equal(state.createdCheckouts, 1); assert.equal(state.submits, 1);
      assert.ok(state.calls.every(value => !value.authorizationPresent));
      assert.ok(state.calls.filter(value => value.method === 'POST').every(value => value.csrfPresent));
      observations.cases.push({ name: 'account_customer_checkout_keyboard', pass: true, checkoutPosts: state.submits, createdCheckouts: state.createdCheckouts });
    });

    await t.test('lost accepted response recovers from history without a second submit', async () => {
      reset({ failSubmit: true }); await visit(); await click('Pay securely'); await hasText('We could not confirm the last request.'); await ready();
      assert.equal(await cdp.evaluate("[...document.querySelectorAll('button')].find(v=>v.textContent==='Pay securely').disabled"), true);
      assert.equal(await cdp.evaluate("document.activeElement.getAttribute('role')"), 'alert');
      await click('Check current purchase'); await hasText('Your secure checkout is ready.'); await ready();
      assert.equal(state.submits, 1); assert.equal(state.createdCheckouts, 1);
      await click('Continue checkout'); await until(() => cdp.evaluate('window.fixture.navigations.length === 1'), 'Recovered checkout was not available'); await ready();
      observations.cases.push({ name: 'unknown_response_history_recovery', pass: true, checkoutPosts: state.submits, createdCheckouts: state.createdCheckouts });
    });

    await t.test('a browser reload reads held history and prevents a duplicate purchase', async () => {
      const before = state.submits; await visit();
      assert.equal(await cdp.evaluate("[...document.querySelectorAll('button')].find(v=>v.textContent==='Pay securely').disabled"), true);
      assert.equal(state.submits, before);
      assert.equal(await cdp.evaluate('window.fixture.navigations.length'), 0);
      observations.cases.push({ name: 'reload_hold_no_duplicate_post', pass: true, checkoutPosts: state.submits });
    });

    await t.test('only an allowlisted hosted URL is available to navigation', async () => {
      reset({ malicious: true }); await visit(); await click('Pay securely'); await hasText('Billing is temporarily unavailable.'); await ready();
      assert.equal(await cdp.evaluate('window.fixture.navigations.length'), 0);
      assert.equal(state.createdCheckouts, 1);
      observations.cases.push({ name: 'malicious_redirect_refused', pass: true, navigations: 0 });
    });

    await t.test('invoice links use a fresh read and only verified paid state displays Paid', async () => {
      reset({ operations: [operation({ id: INVOICE, kind: 'invoice_finalize', state: 'succeeded', providerState: 'open',
        redirectUrl: 'https://invoice.stripe.com/i/synthetic', paymentConfirmed: false, amountMinor: 12000, currency: 'eur' })] });
      await visit(); await click('View invoice'); await until(() => cdp.evaluate('window.fixture.navigations.length === 1'), 'Invoice URL missing'); await ready();
      assert.equal(await cdp.evaluate('window.fixture.navigations[0]'), 'https://invoice.stripe.com/i/synthetic');
      assert.equal(await cdp.evaluate("[...document.querySelectorAll('.onesa-billing-history p')].some(v=>v.textContent==='Paid')"), false);
      state.operations[0] = { ...state.operations[0], paymentConfirmed: true, providerState: 'paid', redirectUrl: null };
      await click('Check status'); await hasText('Payment confirmed.'); await ready();
      assert.equal(await cdp.evaluate("[...document.querySelectorAll('.onesa-billing-history p')].some(v=>v.textContent==='Paid')"), true);
      observations.cases.push({ name: 'invoice_fresh_link_and_paid', pass: true });
    });

    await t.test('expired login requests reauthentication without displaying credentials', async () => {
      reset({ expired: true }); await visit(); await hasText('Your session has ended.');
      assert.equal(await cdp.evaluate('window.fixture.expired'), 1);
      assert.equal(await cdp.evaluate("document.querySelectorAll('input[type=password],textarea').length"), 0);
      observations.cases.push({ name: 'session_expiry', pass: true });
    });

    await t.test('mobile layout and OS appearance stay readable without horizontal overflow', async () => {
      reset(); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await visit();
      const measurements = await cdp.evaluate(`(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,
        buttonHeight:[...document.querySelectorAll('button')].find(v=>v.textContent==='Pay securely').getBoundingClientRect().height,
        color:getComputedStyle(document.querySelector('.onesa-billing')).color, themeControls:[...document.querySelectorAll('button,input,select')].filter(v=>/theme|appearance/i.test(v.getAttribute('aria-label')||'')).length}))()`);
      assert.ok(measurements.scroll <= measurements.viewport); assert.ok(measurements.buttonHeight >= 48);
      assert.equal(measurements.color, 'rgb(229, 237, 246)'); assert.equal(measurements.themeControls, 0);
      observations.cases.push({ name: 'mobile_375px_os_dark', pass: true, ...measurements });
    });
    assert.deepEqual(cdp.external, []);
    Object.assign(observations.bootstrap, cdp.bootstrap);
    observations.externalNetworkRequests = 0; observations.observedAt = new Date().toISOString();
    if (process.env.BILLING_BROWSER_RECEIPT) await writeFile(process.env.BILLING_BROWSER_RECEIPT, JSON.stringify(observations, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(observations));
  } finally {
    cdp?.close();
    if (chromium?.pid) {
      try { process.kill(-chromium.pid, 'SIGTERM'); } catch { /* already exited */ }
      await Promise.race([once(chromium, 'exit').catch(() => {}), delay(1500)]);
      try { process.kill(-chromium.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
