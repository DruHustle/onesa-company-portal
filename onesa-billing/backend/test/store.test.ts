import assert from 'node:assert/strict';
import test from 'node:test';
import { billingFingerprint, canonicalBillingJson } from '../src/store.js';

test('frozen request identity ignores object key order but preserves arrays and commercial values', () => {
  assert.equal(billingFingerprint({ b: 2, a: { d: false, c: 1 } }), billingFingerprint({ a: { c: 1, d: false }, b: 2 }));
  assert.notEqual(billingFingerprint({ lines: [1, 2] }), billingFingerprint({ lines: [2, 1] }));
  assert.notEqual(billingFingerprint({ amount: 1, account: 'a' }), billingFingerprint({ amount: 1, account: 'b' }));
});

test('durable snapshots reject common credential/card fields, unstable JS values and excessive data', () => {
  // These parser fixtures are generated from public markers, never provider credentials.
  const syntheticKey = ['sk', 'test', 'T'.repeat(32)].join('_');
  const syntheticWebhook = ['whsec', 'W'.repeat(32)].join('_');
  for (const value of [{ client_secret: 'private' }, { Authorization: 'private' }, { card: { number: '4242' } },
    { secret: 'private' }, { value: syntheticKey }, { value: syntheticWebhook },
    { value: NaN }, { value: undefined }, { value: new Date() }, { value: BigInt(1) },
    JSON.parse('{"__proto__":{"polluted":true}}'), { value: 'a'.repeat(4097) }, { value: Array(65).fill(1) }]) {
    assert.throws(() => canonicalBillingJson(value));
  }
  const tooLarge = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i), 'x'.repeat(4096)]));
  assert.throws(() => canonicalBillingJson(tooLarge), /BILLING_SNAPSHOT_TOO_LARGE/u);
  assert.equal(canonicalBillingJson({ automaticTaxEnabled: false, customerId: 'cus_synthetic' }),
    '{"automaticTaxEnabled":false,"customerId":"cus_synthetic"}');
});
