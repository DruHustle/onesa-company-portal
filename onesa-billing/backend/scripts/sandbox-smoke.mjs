import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import Stripe from 'stripe';
import { StripeCompanyProvider, STRIPE_API_VERSION } from '../dist/stripe-provider.js';

// Explicit opt-in, synthetic fixtures only. This script never confirms a payment or sends an invoice email.
assert.equal(process.env.BILLING_SANDBOX_SMOKE, 'true', 'Set BILLING_SANDBOX_SMOKE=true for this synthetic provider test');
const key = process.env.STRIPE_SECRET_KEY ?? '', accountId = process.env.STRIPE_ACCOUNT_ID ?? '';
assert.match(key, /^sk_test_[A-Za-z0-9]+$/);
assert.match(accountId, /^acct_[A-Za-z0-9]+$/);
const runId = process.env.BILLING_SMOKE_RUN_ID ?? '';
assert.match(runId, /^[a-z0-9][a-z0-9-]{7,63}$/);
const reportPath = resolve(process.env.BILLING_SMOKE_REPORT ?? '.runtime/sandbox-smoke.json');
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
let report;
try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (report) assert.equal(report.runId, runId, 'Never reuse a different test intent');
else report = { runId, startedAt: new Date().toISOString(), mode: 'test', checks: [], resources: {}, paymentConfirmed: false, emailsSent: false };
assert.ok(Date.now() - Date.parse(report.startedAt) < 23 * 60 * 60 * 1000, 'Reconciliation is required after the safe retry window');
async function save() { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
await save();
const sdk = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 20_000,
  httpClient: Stripe.createFetchHttpClient() });
const scope = { application: 'company', stripeAccountId: accountId, mode: 'test', configVersion: runId };
const letters = [...createHash('sha256').update(runId).digest().subarray(0, 8)].map(value => String.fromCharCode(97 + value % 26)).join('');
const providerConfig = { scope, secretKey: key, webhookSecret: 'whsec_' + randomBytes(24).toString('hex'),
  publicOrigin: 'https://portal.onesa.eu', invoiceDaysUntilDue: 14, automaticTaxEnabled: false,
  integrationIdentifier: 'onesa_company_' + letters };
const provider = new StripeCompanyProvider(providerConfig, sdk);
const hash = label => createHash('sha256').update(runId + ':' + label).digest('hex');
const uuid = label => { const value = hash(label); return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`; };
function operation(kind, intent = kind) {
  return { id: uuid(kind), accountId: uuid('account'), commercialIntentId: uuid(intent), idempotencyKey: runId + ':' + kind,
    fingerprint: hash('payload:' + kind), createdAt: report.startedAt, firstAttemptAt: report.startedAt, scope };
}
async function check(name, action) {
  report.currentStep = name; await save();
  const detail = await action(); report.checks = report.checks.filter(item => item.name !== name);
  report.checks.push({ name, status: 'passed', ...detail }); await save();
  process.stdout.write(JSON.stringify({ check: name, status: 'passed', ...detail }) + '\n');
}
try {
  await check('account-and-sandbox', async () => {
    const account = await provider.verifyAccount(), balance = await sdk.balance.retrieve();
    assert.equal(account.stripeAccountId, accountId); assert.equal(balance.livemode, false);
    return { accountId, mode: 'test' };
  });
  await check('tax-readiness-observation', async () => {
    const observed = await provider.taxPreflight();
    return { settingsStatus: observed.settingsStatus, activeRegistrations: observed.activeRegistrationCount,
      registrationInventoryComplete: observed.registrationsComplete };
  });
  let price;
  await check('synthetic-product-and-price', async () => {
    const product = await sdk.products.create({ name: 'Onesa integration verification — test fixture',
      metadata: { onesa_test_run: runId } }, { idempotencyKey: runId + ':product' });
    price = await sdk.prices.create({ product: product.id, unit_amount: 100, currency: 'eur', tax_behavior: 'exclusive',
      metadata: { onesa_test_run: runId } }, { idempotencyKey: runId + ':price' });
    assert.equal(price.livemode, false); report.resources.product = product.id; report.resources.price = price.id;
    return { currency: 'eur', syntheticAmountMinor: 100 };
  });
  const lines = [{ item: { sku: 'verification-fixture', title: 'Synthetic service', version: runId, kind: 'one_off',
    priceId: price.id, currency: 'eur', unitAmount: 100, taxBehavior: 'exclusive', maxQuantity: 1 }, quantity: 1 }];
  let customer;
  await check('customer-create-and-idempotency', async () => {
    const op = operation('customer');
    customer = await provider.ensureCustomer(op, null, { name: 'Synthetic Onesa billing verification', email: 'billing-verification@example.invalid' });
    const repeated = await provider.ensureCustomer(op, null, { name: 'Synthetic Onesa billing verification', email: 'billing-verification@example.invalid' });
    assert.equal(repeated.customerId, customer.customerId); report.resources.customer = customer.customerId;
    return { duplicateCustomerCreated: false };
  });
  await check('hosted-checkout-and-idempotency', async () => {
    const op = operation('checkout');
    const first = await provider.createCheckout(op, customer, lines), repeated = await provider.createCheckout(op, customer, lines);
    assert.equal(first.id, repeated.id); assert.equal(first.status, 'open'); assert.equal(first.amountSubtotal, 100);
    assert.equal(first.paymentConfirmed, false); assert.ok(first.hostedUrl?.startsWith('https://checkout.stripe.com/'));
    report.resources.checkout = first.id;
    return { duplicateCheckoutCreated: false, paymentConfirmed: false };
  });
  let invoice;
  await check('draft-invoice-and-idempotency', async () => {
    const op = operation('invoice');
    invoice = await provider.createDraftInvoice(op, customer, lines);
    const repeated = await provider.createDraftInvoice(op, customer, lines);
    assert.equal(invoice.id, repeated.id); assert.equal(invoice.status, 'draft'); assert.equal(invoice.autoAdvance, false);
    assert.equal(invoice.total, 100); report.resources.invoice = invoice.id;
    return { duplicateInvoiceCreated: false, autoAdvance: false, totalMinor: invoice.total };
  });
  await check('explicit-invoice-finalization', async () => {
    const finalized = await provider.finalizeDraftInvoice(operation('finalize', 'invoice'), customer, invoice.id, lines);
    assert.equal(finalized.status, 'open'); assert.equal(finalized.autoAdvance, false); assert.equal(finalized.amountRemaining, 100);
    assert.ok(finalized.hostedInvoiceUrl?.startsWith('https://invoice.stripe.com/'));
    return { invoiceStatus: finalized.status, amountRemainingMinor: finalized.amountRemaining, emailsSent: false };
  });
  const readiness = await provider.taxPreflight();
  if (readiness.activeRegistrationCount === 0) await check('automatic-tax-blocks-unregistered-account', async () => {
    const taxProvider = new StripeCompanyProvider({ ...providerConfig, automaticTaxEnabled: true }, sdk);
    await assert.rejects(taxProvider.createCheckout(operation('tax-block'), customer, lines), { code: 'stripe_tax_registration_unqualified' });
    return { blockedBeforeCheckoutCreation: true };
  });
  report.completedAt = new Date().toISOString(); delete report.currentStep; await save();
  process.stdout.write(JSON.stringify({ status: 'passed', checks: report.checks.length, paymentConfirmed: false, emailsSent: false }) + '\n');
} catch (error) {
  // Only closed diagnostic identifiers are emitted; SDK messages, headers, response bodies and secrets stay private.
  const diagnostic = {};
  for (const field of ['code', 'type', 'param']) if (typeof error?.[field] === 'string' && /^[A-Za-z0-9_.\[\]-]{1,100}$/.test(error[field])) diagnostic[field] = error[field];
  report.failure = { step: report.currentStep, ...diagnostic }; await save();
  process.stderr.write(JSON.stringify({ status: 'failed', step: report.currentStep, ...diagnostic }) + '\n');
  process.exitCode = 1;
}
