import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStripeMoney } from '../money.mjs';

test('Stripe charge amount formatting respects EUR/JPY/ISK/UGX/HUF/TWD units', () => {
  const cases = [
    [1234, 'eur', '€12.34'], [1234, 'jpy', '¥1,234'],
    [500, 'isk', 'ISK\u00a05'], [500, 'ugx', 'UGX\u00a05'],
    [1045, 'huf', 'HUF\u00a010.45'], [80045, 'twd', 'NT$800.45'],
  ];
  for (const [amount, currency, expected] of cases) assert.equal(formatStripeMoney(amount, currency, 'en-US'), expected);
});

test('whole-unit API exceptions refuse fractions and unverified currencies are never guessed', () => {
  for (const currency of ['isk', 'ugx']) assert.equal(formatStripeMoney(501, currency, 'en-US'), null);
  assert.equal(formatStripeMoney(100, 'bhd', 'en-US'), null);
  assert.equal(formatStripeMoney(100, 'xxx', 'en-US'), null);
  assert.equal(formatStripeMoney(-1, 'eur', 'en-US'), null);
  assert.equal(formatStripeMoney(0.1, 'eur', 'en-US'), null);
  assert.equal(formatStripeMoney(Number.MAX_SAFE_INTEGER + 1, 'eur', 'en-US'), null);
});

test('formatting keeps every safe integer minor unit without floating-point division', () => {
  assert.equal(formatStripeMoney(Number.MAX_SAFE_INTEGER, 'usd', 'en-US'), '$90,071,992,547,409.91');
  assert.equal(formatStripeMoney(100, 'UGX', 'en-US'), 'UGX\u00a01');
});
