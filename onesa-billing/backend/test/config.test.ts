import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { loadConfig, validateCatalog } from '../src/config.js';

const catalog = [{ sku: 'example-offer', title: 'Synthetic test offer', version: '1', kind: 'one_off',
  priceId: 'price_synthetic', currency: 'eur', unitAmount: 1000, taxBehavior: 'exclusive', maxQuantity: 2 }];

test('configuration separates four database credentials, redacts secrets and keeps sales/tax default off', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'onesa-billing-config-'));
  try {
    const { publicKey } = await generateKeyPair('EdDSA');
    writeFileSync(join(folder, 'jwks.json'), JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'config-test' }] }));
    writeFileSync(join(folder, 'catalog.json'), JSON.stringify(catalog));
    const env: NodeJS.ProcessEnv = {
      BILLING_MODE: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'A'.repeat(24)].join('_'),
      STRIPE_WEBHOOK_SECRET: ['whsec', 'B'.repeat(24)].join('_'), STRIPE_ACCOUNT_ID: 'acct_synthetic',
      BILLING_CONFIG_VERSION: 'test1', BILLING_RETURN_ORIGIN: 'http://127.0.0.1:8099',
      BILLING_AUTH_ISSUER: 'https://issuer.example.invalid', BILLING_AUTH_JWKS_FILE: join(folder, 'jwks.json'),
      BILLING_CATALOG_FILE: join(folder, 'catalog.json'), BILLING_INVOICE_DAYS_UNTIL_DUE: '14',
      BILLING_INTEGRATION_IDENTIFIER: 'onesa_company_abcdefgh',
    };
    for (const role of ['API', 'DISPATCHER', 'WEBHOOK', 'METER']) env[`BILLING_${role}_DATABASE_URL`] = `postgres://test_${role.toLowerCase()}:synthetic@127.0.0.1/billing`;
    const config = loadConfig(env);
    assert.equal(config.salesEnabled, false); assert.equal(config.taxEnabled, false);
    assert.equal(config.secrets.database('api').includes('test_api'), true);
    const serialized = JSON.stringify(config);
    for (const privateValue of [env.STRIPE_SECRET_KEY!, env.STRIPE_WEBHOOK_SECRET!, 'postgres://', ':synthetic@']) assert.equal(serialized.includes(privateValue), false);
    assert.throws(() => loadConfig({ ...env, BILLING_MODE: 'live' }), /LIVE_MODE_NOT_AUTHORIZED/);
    assert.throws(() => loadConfig({ ...env, BILLING_MODE: 'live', BILLING_ALLOW_LIVE: 'true' }), /CONFIG_KEY_MODE_MISMATCH/);
    assert.throws(() => loadConfig({ ...env, STRIPE_SECRET_KEY_FILE: '/missing' }), /CONFIG_AMBIGUOUS/);
    assert.throws(() => loadConfig({ ...env, BILLING_METER_DATABASE_URL: undefined }), /CONFIG_REQUIRED_BILLING_METER/);
    assert.throws(() => loadConfig({ ...env, BILLING_METER_DATABASE_URL: 'postgres://meter:synthetic@127.0.0.1/other' }), /CONFIG_DATABASE_TARGET_MISMATCH/);
    assert.throws(() => loadConfig({ ...env, BILLING_API_DATABASE_URL: 'postgres://api:synthetic@127.0.0.1' }), /CONFIG_EXPLICIT_DATABASE_REQUIRED/);
    assert.throws(() => loadConfig({ ...env, BILLING_API_DATABASE_URL: env.BILLING_API_DATABASE_URL + '?host=another.invalid' }), /CONFIG_DATABASE_QUERY_FORBIDDEN/);
    assert.throws(() => loadConfig({ ...env, BILLING_RETURN_ORIGIN: 'https://trusted.invalid@attacker.invalid/path' }), /CONFIG_INVALID_ORIGIN/);
    assert.throws(() => loadConfig({ ...env, BILLING_INVOICE_DAYS_UNTIL_DUE: undefined }), /CONFIG_REQUIRED/);
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      writeFileSync(join(folder, 'jwks.json'), JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'config-test', [field]: 'private-material' }] }));
      assert.throws(() => loadConfig(env), /CONFIG_PUBLIC_JWKS_ONLY/);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('catalog validation excludes arbitrary properties, duplicate SKUs, unsafe amounts and metered Stripe prices', () => {
  assert.equal(validateCatalog(catalog)[0].unitAmount, 1000);
  for (const invalid of [[{ ...catalog[0], clientSecret: 'forbidden' }], [...catalog, ...catalog],
    [{ ...catalog[0], unitAmount: 1.25 }], [{ ...catalog[0], unitAmount: Number.MAX_SAFE_INTEGER }],
    [{ ...catalog[0], currency: 'EUR' }], [{ ...catalog[0], kind: 'metered' }], [{ ...catalog[0], maxQuantity: 1001 }]]) {
    assert.throws(() => validateCatalog(invalid));
  }
});
