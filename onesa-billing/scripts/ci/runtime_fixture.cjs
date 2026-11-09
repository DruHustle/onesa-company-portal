/* Disposable CI fixtures only. Production never imports this module. */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { createRequire } = require('node:module');

const ACCOUNT = 'acct_runtimeFixture';
const API_VERSION = '2026-10-28.endive';
const ISSUER = 'https://billing-fixture.example.invalid';
const ORIGIN = 'https://company-fixture.example.invalid';
const LANES = Object.freeze(['api', 'dispatcher', 'webhook', 'meter']);
const CATALOG = Object.freeze([{ sku: 'fixture-service', title: 'Synthetic runtime fixture',
  version: '1', kind: 'one_off', priceId: 'price_RuntimeFixture', currency: 'eur',
  unitAmount: 100, taxBehavior: 'exclusive', maxQuantity: 2 }]);

function write(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 });
}

function prepare(directory) {
  for (const name of ['runtime', 'provider', 'client', 'migration']) {
    fs.mkdirSync(path.join(directory, name), { mode: 0o755 });
  }
  const runtime = path.join(directory, 'runtime');
  const provider = path.join(directory, 'provider');
  const client = path.join(directory, 'client');
  const migration = path.join(directory, 'migration');
  const stripe = ['sk', 'test', crypto.randomBytes(24).toString('hex')].join('_');
  const webhook = ['whsec', crypto.randomBytes(24).toString('hex')].join('_');
  write(path.join(runtime, 'stripe.key'), stripe);
  write(path.join(runtime, 'webhook.key'), webhook);
  write(path.join(provider, 'stripe.key'), stripe);
  const passwords = Object.fromEntries(['admin', ...LANES, 'unprivileged'].map(name =>
    [name, crypto.randomBytes(24).toString('hex')]));
  const url = (name) => `postgresql://billing_fixture_${name}:${passwords[name]}@billing-db:5432/onesa_billing_runtime_test`;
  for (const name of [...LANES, 'unprivileged']) write(path.join(runtime, `${name}.url`), url(name));
  write(path.join(migration, 'owner.url'), url('admin'));
  write(path.join(directory, 'postgres.env'), `POSTGRES_DB=onesa_billing_runtime_test\nPOSTGRES_USER=billing_fixture_admin\nPOSTGRES_PASSWORD=${passwords.admin}\nPGDATA=/var/lib/postgresql/data\n`);
  const sql = ['REVOKE CREATE ON SCHEMA public FROM PUBLIC;'];
  for (const name of [...LANES, 'unprivileged']) {
    sql.push(`CREATE ROLE billing_fixture_${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[name]}';`);
    if (name !== 'unprivileged') sql.push(`GRANT onesa_billing_${name} TO billing_fixture_${name};`);
  }
  write(path.join(directory, 'roles.sql'), sql.join('\n') + '\n');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  write(path.join(runtime, 'jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'runtime-fixture' }] }));
  write(path.join(runtime, 'catalog.json'), JSON.stringify(CATALOG));
  const issuedAt = Math.floor(Date.now() / 1000);
  function token(issuer) {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'runtime-fixture' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'runtime-fixture-account-owner', iss: issuer,
      aud: 'onesa-billing', iat: issuedAt, exp: issuedAt + 600,
      jti: crypto.randomBytes(16).toString('hex'), scope: 'billing:account' })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  }
  write(path.join(client, 'valid.jwt'), token(ISSUER));
  write(path.join(client, 'wrong-issuer.jwt'), token('https://other-fixture.example.invalid'));
  const env = {
    HOST: '0.0.0.0', PORT: '8099', BILLING_MODE: 'test', BILLING_SALES_ENABLED: 'false',
    BILLING_AUTOMATIC_TAX: 'false', BILLING_CONFIG_VERSION: 'runtime-fixture-1',
    BILLING_RETURN_ORIGIN: ORIGIN, BILLING_ALLOWED_ORIGINS: ORIGIN, BILLING_AUTH_ISSUER: ISSUER,
    BILLING_AUTH_JWKS_FILE: '/fixture/jwks.json', BILLING_CATALOG_FILE: '/fixture/catalog.json',
    BILLING_INVOICE_DAYS_UNTIL_DUE: '14', BILLING_INTEGRATION_IDENTIFIER: 'onesa_company_abcdefgh',
    STRIPE_ACCOUNT_ID: ACCOUNT, STRIPE_SECRET_KEY_FILE: '/fixture/stripe.key',
    STRIPE_WEBHOOK_SECRET_FILE: '/fixture/webhook.key', NODE_EXTRA_CA_CERTS: '/fixture/ca.crt',
  };
  for (const lane of LANES) env[`BILLING_${lane.toUpperCase()}_DATABASE_URL_FILE`] = `/fixture/${lane}.url`;
  write(path.join(directory, 'runtime.env'), Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function classifyProviderRequest(request, expectedKey) {
  if (request.method !== 'GET' || request.url !== '/v1/account'
      || request.headers.host !== 'api.stripe.com') return 'forbidden';
  if (request.headers.authorization !== `Bearer ${expectedKey}`) return 'authorization_error';
  if (request.headers['stripe-version'] !== API_VERSION) return 'api_version_error';
  if (request.headers['content-length'] && request.headers['content-length'] !== '0') return 'forbidden';
  if (request.headers['transfer-encoding']) return 'forbidden';
  return 'accepted';
}

function serve() {
  const expectedKey = fs.readFileSync('/fixture/stripe.key', 'utf8');
  const counts = { accepted: 0, forbidden: 0, authorization_error: 0, api_version_error: 0 };
  const server = https.createServer({ key: fs.readFileSync('/fixture/server.key'),
    cert: fs.readFileSync('/fixture/server.crt'), minVersion: 'TLSv1.2',
    requestTimeout: 4000, headersTimeout: 4000, maxHeaderSize: 8192 }, (request, response) => {
    const category = classifyProviderRequest(request, expectedKey);
    counts[category]++;
    if (category !== 'accepted') {
      response.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
      response.end('{"error":{"type":"invalid_request_error","message":"fixture request refused"}}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'request-id': 'req_runtimeFixture' });
    response.end(JSON.stringify({ id: ACCOUNT, object: 'account', charges_enabled: false, details_submitted: false }));
  });
  server.on('clientError', (_error, socket) => { counts.forbidden++; socket.destroy(); });
  server.on('tlsClientError', () => { counts.forbidden++; });
  server.on('error', () => { process.stderr.write('BILLING_PROVIDER_FIXTURE_FAILED\n'); process.exitCode = 1; server.close(); });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.close(() => process.stdout.write(`BILLING_PROVIDER_COUNTS ${JSON.stringify(counts)}\n`));
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.listen(443, '0.0.0.0', () => process.stdout.write('BILLING_PROVIDER_FIXTURE_READY\n'));
}

async function request(method, route, token, input, origin = ORIGIN) {
  return await new Promise((resolve, reject) => {
    const bytes = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
    const headers = { origin, 'idempotency-key': 'runtime-fixture-command-1' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (bytes) { headers['content-type'] = 'application/json'; headers['content-length'] = String(bytes.length); }
    const outgoing = http.request({ hostname: 'billing-api', port: 8099, path: route,
      method, headers, timeout: 3000, agent: false }, response => {
      const chunks = []; let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > 65536) { response.destroy(); reject(new Error('RESPONSE_BOUND')); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()),
          cacheControl: response.headers['cache-control'] }); } catch { reject(new Error('RESPONSE_INVALID')); }
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('REQUEST_DEADLINE')));
    outgoing.on('error', reject); outgoing.end(bytes);
  });
}

async function probe() {
  const token = fs.readFileSync('/fixture/valid.jwt', 'utf8');
  const wrongIssuer = fs.readFileSync('/fixture/wrong-issuer.jwt', 'utf8');
  const result = {};
  const health = await request('GET', '/health');
  assert.equal(health.status, 200); assert.deepEqual(health.body, { status: 'ok' });
  assert.equal(health.cacheControl, 'private, no-store, max-age=0'); result.health = true;
  const anonymous = await request('GET', '/v1/catalog');
  assert.equal(anonymous.status, 401); result.anonymous_refused = true;
  const issuer = await request('GET', '/v1/catalog', wrongIssuer);
  assert.equal(issuer.status, 401); result.wrong_issuer_refused = true;
  const origin = await request('GET', '/health', undefined, undefined, 'https://foreign.example.invalid');
  assert.equal(origin.status, 403); result.foreign_origin_refused = true;
  const catalog = await request('GET', '/v1/catalog', token);
  assert.equal(catalog.status, 200); assert.equal(catalog.body.mode, 'test');
  assert.equal(catalog.body.salesEnabled, false); assert.equal(catalog.body.items.length, 1);
  assert.equal(catalog.body.items[0].sku, CATALOG[0].sku); result.test_sales_closed = true;
  const account = await request('POST', '/v1/accounts', token, { displayName: 'Disposable runtime fixture' });
  assert.equal(account.status, 201); assert.match(account.body.id, /^[a-f0-9-]{36}$/);
  for (const kind of ['checkout', 'invoice']) {
    const response = await request('POST', `/v1/accounts/${account.body.id}/intents`, token,
      { kind, items: [{ sku: CATALOG[0].sku, quantity: 1 }] });
    assert.equal(response.status, 503); assert.equal(response.body.error.code, 'SALES_PAUSED');
    result[`${kind}_paused`] = true;
  }
  const finalize = await request('POST', `/v1/accounts/${account.body.id}/invoices/finalize`, token,
    { draftOperationId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(finalize.status, 503); assert.equal(finalize.body.error.code, 'SALES_PAUSED'); result.finalize_paused = true;
  const webhook = await request('POST', '/v1/webhooks/stripe', undefined, {});
  assert.equal(webhook.status, 400); result.unsigned_webhook_refused = true;
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function roles() {
  const pg = createRequire('/app/package.json')('pg');
  const result = {};
  for (const lane of LANES) {
    const client = new pg.Client({ connectionString: fs.readFileSync(`/fixture/${lane}.url`, 'utf8'), connectionTimeoutMillis: 3000 });
    await client.connect();
    try {
      const row = (await client.query(`SELECT current_user=$1 AS expected_login,
        current_user=session_user AS direct_login, NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS restricted,
        pg_has_role(current_user,$2,'USAGE') AS expected_group,
        NOT pg_has_role(current_user,'onesa_billing_owner','MEMBER') AS not_owner
        FROM pg_roles r WHERE r.rolname=current_user`, [`billing_fixture_${lane}`, `onesa_billing_${lane}`])).rows[0];
      assert.ok(row && Object.values(row).every(value => value === true));
      await client.query('BEGIN');
      let denied = false;
      try { await client.query('CREATE TABLE billing.runtime_fixture_forbidden(id integer)'); }
      catch (error) { assert.equal(error.code, '42501'); denied = true; }
      finally { await client.query('ROLLBACK'); }
      assert.equal(denied, true); result[lane] = true;
    } finally { await client.end(); }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { ACCOUNT, API_VERSION, ISSUER, ORIGIN, LANES, CATALOG, prepare, classifyProviderRequest };
if (require.main === module) {
  const actions = { prepare: () => prepare(process.argv[3]), serve, probe, roles };
  if (!Object.hasOwn(actions, process.argv[2])) throw new Error('FIXTURE_MODE_REFUSED');
  Promise.resolve().then(actions[process.argv[2]]).catch(() => {
    process.stderr.write('BILLING_RUNTIME_FIXTURE_FAILED\n'); process.exitCode = 1;
  });
}
