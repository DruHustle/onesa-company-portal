'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fixture = require('../runtime_fixture.cjs');

test('only the exact versioned, authorized startup GET is accepted', () => {
  const secret = crypto.randomBytes(24).toString('hex');
  const good = { method: 'GET', url: '/v1/account', headers: { host: 'api.stripe.com',
    authorization: `Bearer ${secret}`, 'stripe-version': fixture.API_VERSION } };
  assert.equal(fixture.classifyProviderRequest(good, secret), 'accepted');
  for (const change of [
    { method: 'POST' }, { method: 'HEAD' }, { url: '/v1/account?expand[]=x' },
    { url: '/v1/customers' }, { headers: { ...good.headers, host: 'stripe.com' } },
    { headers: { ...good.headers, 'content-length': '1' } },
    { headers: { ...good.headers, 'transfer-encoding': 'chunked' } },
  ]) assert.equal(fixture.classifyProviderRequest({ ...good, ...change }, secret), 'forbidden');
  assert.equal(fixture.classifyProviderRequest({ ...good, headers: { ...good.headers, authorization: 'Bearer synthetic-wrong' } }, secret), 'authorization_error');
  assert.equal(fixture.classifyProviderRequest({ ...good, headers: { ...good.headers, 'stripe-version': 'different' } }, secret), 'api_version_error');
});

test('preparation isolates generated fixture secrets and signs bounded public-JWKS assertions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-runtime-unit-'));
  try {
    fixture.prepare(root);
    const runtime = path.join(root, 'runtime');
    const provider = path.join(root, 'provider');
    const jwks = JSON.parse(fs.readFileSync(path.join(runtime, 'jwks.json')));
    assert.equal(jwks.keys.length, 1); assert.equal(jwks.keys[0].kty, 'OKP');
    assert.equal(Object.hasOwn(jwks.keys[0], 'd'), false);
    const token = fs.readFileSync(path.join(root, 'client', 'valid.jwt'), 'utf8');
    const [header, body, signature] = token.split('.');
    assert.equal(crypto.verify(null, Buffer.from(`${header}.${body}`),
      crypto.createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
    const payload = JSON.parse(Buffer.from(body, 'base64url'));
    assert.equal(payload.iss, fixture.ISSUER); assert.equal(payload.aud, 'onesa-billing');
    assert.equal(payload.exp - payload.iat, 600); assert.equal(payload.scope, 'billing:account');
    const names = fs.readdirSync(runtime);
    assert.equal(names.includes('owner.url'), false);
    assert.equal(names.some(name => name.endsWith('.jwt') || name.includes('private')), false);
    assert.deepEqual(fs.readdirSync(provider), ['stripe.key']);
    const env = fs.readFileSync(path.join(root, 'runtime.env'), 'utf8');
    assert.match(env, /BILLING_MODE=test\n/); assert.match(env, /BILLING_SALES_ENABLED=false\n/);
    assert.doesNotMatch(env, /METRONOME|MIGRATION|ALLOW_LIVE|PROXY|NODE_TLS_REJECT_UNAUTHORIZED/);
    const urls = fixture.LANES.map(lane => new URL(fs.readFileSync(path.join(runtime, `${lane}.url`), 'utf8')));
    assert.equal(new Set(urls.map(url => url.password)).size, 4);
    assert.equal(new Set(urls.map(url => url.hostname + url.pathname)).size, 1);
    for (const [index, url] of urls.entries()) {
      assert.equal(url.username, `billing_fixture_${fixture.LANES[index]}`);
      assert.equal(url.hostname, 'billing-db'); assert.match(url.pathname, /_test$/);
      assert.equal(fs.statSync(path.join(runtime, `${fixture.LANES[index]}.url`)).mode & 0o777, 0o444);
    }
    assert.throws(() => fixture.prepare(root), { code: 'EEXIST' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
