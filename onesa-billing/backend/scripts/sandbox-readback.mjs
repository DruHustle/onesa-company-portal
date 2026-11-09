import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import Stripe from 'stripe';
import { StripeCompanyProvider, STRIPE_API_VERSION, validateProjectionForIntent } from '../dist/stripe-provider.js';

assert.equal(process.env.BILLING_SANDBOX_SMOKE, 'true');
const key = process.env.STRIPE_SECRET_KEY ?? '', accountId = process.env.STRIPE_ACCOUNT_ID ?? '';
assert.match(key, /^sk_test_[A-Za-z0-9]+$/); assert.match(accountId, /^acct_[A-Za-z0-9]+$/);
const reportPath = process.env.BILLING_SMOKE_REPORT; assert.ok(reportPath);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(report.runId, process.env.BILLING_SMOKE_RUN_ID); assert.equal(report.mode, 'test');
const runId = report.runId, scope = { application: 'company', stripeAccountId: accountId, mode: 'test', configVersion: runId };
const letters = [...createHash('sha256').update(runId).digest().subarray(0, 8)].map(value => String.fromCharCode(97 + value % 26)).join('');
const sdk = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 20_000, httpClient: Stripe.createFetchHttpClient() });
const provider = new StripeCompanyProvider({ scope, secretKey: key, webhookSecret: 'whsec_' + randomBytes(24).toString('hex'),
  publicOrigin: 'https://portal.onesa.eu', invoiceDaysUntilDue: 14, automaticTaxEnabled: false, integrationIdentifier: 'onesa_company_' + letters }, sdk);
const lines = [{ item: { sku: 'verification-fixture', title: 'Synthetic service', version: runId, kind: 'one_off',
  priceId: report.resources.price, currency: 'eur', unitAmount: 100, taxBehavior: 'exclusive', maxQuantity: 1 }, quantity: 1 }];
try {
  const account = await provider.verifyAccount(), balance = await sdk.balance.retrieve();
  assert.equal(account.stripeAccountId, accountId); assert.equal(balance.livemode, false);
  const checkout = await provider.retrieveCheckout(report.resources.checkout);
  validateProjectionForIntent(checkout, lines);
  assert.equal(checkout.amountTotal, 100); assert.equal(checkout.paymentConfirmed, false);
  const invoice = await provider.retrieveInvoice(report.resources.invoice);
  validateProjectionForIntent(invoice, lines);
  assert.equal(invoice.status, 'open'); assert.equal(invoice.amountRemaining, 100); assert.equal(invoice.autoAdvance, false);
  const tax = await provider.taxPreflight(); assert.equal(tax.activeRegistrationCount, 0);
  const source = await readFile(new URL('../src/stripe-provider.ts', import.meta.url));
  const readback = { status: 'passed', checkedAt: new Date().toISOString(), providerSourceSha256: createHash('sha256').update(source).digest('hex'),
    checkoutProjectionMatchesFrozenPrice: true, invoiceProjectionMatchesFrozenPrice: true, mode: 'test',
    checkoutPaymentConfirmed: checkout.paymentConfirmed, invoiceStatus: invoice.status, invoiceRemainingMinor: invoice.amountRemaining,
    activeTaxRegistrations: tax.activeRegistrationCount, mutationsRequested: 0 };
  report.finalReadback = readback;
  for (const check of report.checks) if (check.name === 'explicit-invoice-finalization' && check.status === 'open') { check.invoiceStatus = 'open'; check.status = 'passed'; }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(readback) + '\n');
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.code) ? error.code : 'SANDBOX_READBACK_FAILED';
  process.stderr.write(JSON.stringify({ status: 'failed', code, mutationsRequested: 0 }) + '\n'); process.exitCode = 1;
}
