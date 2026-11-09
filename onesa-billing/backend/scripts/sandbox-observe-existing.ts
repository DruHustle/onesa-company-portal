import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../src/stripe-provider.js';

const RETURN_URL = 'https://portal.onesa.eu/account/billing';
const RESPONSE_LIMIT = 256 * 1024;
const RECEIPT_LIMIT = 64 * 1024;
type Row = Record<string, unknown>;
type Query = readonly (readonly [string, string])[];
export interface ObserverInput {
  receiptPath: string; receiptSha256: string; observationPath: string; runId: string; accountId: string; secretKey: string;
}
class Refused extends Error {
  constructor(readonly code: string) { super(code); }
}
function require(value: unknown, code: string): asserts value { if (!value) throw new Refused(code); }
function row(value: unknown): Row {
  require(value !== null && typeof value === 'object' && !Array.isArray(value), 'RESPONSE_INVALID');
  return value as Row;
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function reference(value: unknown, prefix: string): string {
  require(typeof value === 'string' && new RegExp('^' + prefix + '[A-Za-z0-9]{1,128}$').test(value), 'FIXTURE_IDENTITY_INVALID');
  return value;
}
function metadata(runId: string, accountId: string, kind: 'customer' | 'checkout'): Record<string, string> {
  const digest = (label: string) => hash(runId + ':' + label);
  const uuid = (label: string) => {
    const value = digest(label);
    return [value.slice(0, 8), value.slice(8, 12), '4' + value.slice(13, 16), 'a' + value.slice(17, 20), value.slice(20, 32)].join('-');
  };
  const letters = [...createHash('sha256').update(runId).digest().subarray(0, 8)]
    .map(value => String.fromCharCode(97 + value % 26)).join('');
  return {
    onesa_application: 'company', onesa_account_id: uuid('account'), onesa_stripe_account: accountId,
    onesa_config_version: runId, onesa_integration_identifier: 'onesa_company_' + letters,
    onesa_operation_id: uuid(kind), onesa_intent_id: uuid(kind), onesa_fingerprint: digest('payload:' + kind), onesa_kind: kind,
  };
}
function sameMetadata(value: unknown, expected: Record<string, string>): void {
  const actual = row(value);
  require(Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => actual[key] === item), 'FIXTURE_METADATA_MISMATCH');
}

/** Every SDK request crosses this guard; neither redirects nor hidden retries can enlarge its authority. */
export function getOnlyTransport(allowed: ReadonlyMap<string, Query>, fetcher: typeof fetch = fetch) {
  const seen = new Set<string>();
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), expected = allowed.get(url.pathname);
    const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    require(init?.method === 'GET' && (init.body === undefined || init.body === null || init.body === '')
      && url.origin === 'https://api.stripe.com' && !url.username && !url.password && !url.hash
      && expected !== undefined && JSON.stringify(query) === JSON.stringify([...expected].sort(([a], [b]) => a.localeCompare(b)))
      && !seen.has(url.pathname) && seen.size < 6, 'PROVIDER_REQUEST_REFUSED');
    seen.add(url.pathname);
    const response = await fetcher(url.href, { ...init, redirect: 'error' });
    const advertised = response.headers.get('content-length');
    try {
      require(!response.redirected && !(response.status >= 300 && response.status < 400)
        && (!response.url || response.url === url.href)
        && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''), 'PROVIDER_REDIRECT_OR_RESPONSE_REFUSED');
      require(advertised === null || /^\d+$/.test(advertised) && Number(advertised) <= RESPONSE_LIMIT, 'PROVIDER_RESPONSE_TOO_LARGE');
    } catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
    require(response.body, 'PROVIDER_RESPONSE_INVALID');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        require(size <= RESPONSE_LIMIT, 'PROVIDER_RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return new Response(Buffer.concat(chunks, size), { status: response.status, headers: response.headers });
  };
  return { fetch: guarded, count: () => seen.size };
}

function privateFile(fd: number): void {
  const stat = fstatSync(fd);
  require(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.()
    && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= RECEIPT_LIMIT, 'PRIVATE_RECEIPT_REQUIRED');
}
function receiptBytes(fd: number): Buffer {
  const data = Buffer.alloc(RECEIPT_LIMIT + 1);
  let count = 0;
  while (count < data.length) {
    const read = readSync(fd, data, count, data.length - count, count);
    if (!read) break;
    count += read;
  }
  require(count > 0 && count <= RECEIPT_LIMIT, 'PRIVATE_RECEIPT_REQUIRED');
  return data.subarray(0, count);
}
function outputTarget(path: string, input: string): string {
  const target = resolve(path), parent = dirname(target), stat = lstatSync(parent);
  require(target !== resolve(input) && realpathSync(parent) === parent && stat.isDirectory()
    && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'PRIVATE_NEW_OUTPUT_REQUIRED');
  try { lstatSync(target); throw new Refused('OUTPUT_ALREADY_EXISTS'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  return target;
}

/** Observe only the existing EUR1 synthetic fixture; never import it into the application ledger. */
export async function observeExistingCheckout(input: ObserverInput, fetcher: typeof fetch = fetch, now = new Date()) {
  require(/^[a-f0-9]{64}$/.test(input.receiptSha256)
    && /^[a-z0-9][a-z0-9-]{7,63}$/.test(input.runId)
    && /^(?:sk|rk)_test_[A-Za-z0-9]{12,512}$/.test(input.secretKey)
    && Number.isFinite(now.getTime()), 'OBSERVER_CONFIGURATION_INVALID');
  reference(input.accountId, 'acct_');
  const target = outputTarget(input.observationPath, input.receiptPath);
  const fd = openSync(input.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    privateFile(fd);
    const initial = fstatSync(fd), bytes = receiptBytes(fd);
    require(hash(bytes) === input.receiptSha256, 'ORIGINAL_RECEIPT_HASH_MISMATCH');
    const original = row(JSON.parse(bytes.toString('utf8')));
    require(original.mode === 'test' && original.runId === input.runId && original.paymentConfirmed === false
      && typeof original.startedAt === 'string' && Number.isFinite(Date.parse(original.startedAt))
      && Date.parse(original.startedAt) <= now.getTime() && typeof original.completedAt === 'string'
      && Number.isFinite(Date.parse(original.completedAt)) && Date.parse(original.completedAt) <= now.getTime(), 'ORIGINAL_FIXTURE_REQUIRED');
    require(Array.isArray(original.checks), 'ORIGINAL_FIXTURE_REQUIRED');
    const accountChecks = original.checks.map(row).filter(check => check.name === 'account-and-sandbox');
    require(accountChecks.length === 1 && accountChecks[0]!.status === 'passed'
      && accountChecks[0]!.accountId === input.accountId && accountChecks[0]!.mode === 'test', 'FIXTURE_ACCOUNT_MISMATCH');
    const checkoutChecks = original.checks.map(row).filter(check => check.name === 'hosted-checkout-and-idempotency');
    require(checkoutChecks.length === 1 && checkoutChecks[0]!.status === 'passed'
      && checkoutChecks[0]!.duplicateCheckoutCreated === false && checkoutChecks[0]!.paymentConfirmed === false, 'ORIGINAL_FIXTURE_REQUIRED');
    const resources = row(original.resources);
    const checkoutId = reference(resources.checkout, 'cs_test_'), customerId = reference(resources.customer, 'cus_');
    const priceId = reference(resources.price, 'price_'), productId = reference(resources.product, 'prod_');
    const expected = metadata(input.runId, input.accountId, 'checkout');
    const checkoutPath = '/v1/checkout/sessions/' + checkoutId;
    const allowed = new Map<string, Query>([
      ['/v1/account', []], ['/v1/balance', []], [checkoutPath, []], ['/v1/customers/' + customerId, []],
      [checkoutPath + '/line_items', [['limit', '2'], ['expand[0]', 'data.price']]],
    ]);
    const transport = getOnlyTransport(allowed, fetcher);
    const sdk = new Stripe(input.secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 4000,
      httpClient: Stripe.createFetchHttpClient(transport.fetch) });
    let observation: Record<string, unknown>;
    try {
      const account = await sdk.accounts.retrieve(null);
      require(account.object === 'account' && account.id === input.accountId, 'FIXTURE_ACCOUNT_MISMATCH');
      require((await sdk.balance.retrieve()).livemode === false, 'TEST_MODE_REQUIRED');
      const checkout = await sdk.checkout.sessions.retrieve(checkoutId);
      require(checkout.id === checkoutId && checkout.object === 'checkout.session' && checkout.livemode === false
        && checkout.mode === 'payment' && checkout.customer === customerId && checkout.customer_account === null
        && checkout.client_reference_id === expected.onesa_intent_id
        && checkout.integration_identifier === expected.onesa_integration_identifier, 'FIXTURE_CHECKOUT_MISMATCH');
      sameMetadata(checkout.metadata, expected);
      require(checkout.currency === 'eur' && checkout.amount_subtotal === 100 && checkout.amount_total === 100
        && checkout.automatic_tax.enabled === false && checkout.total_details?.amount_tax === 0
        && checkout.total_details.amount_discount === 0 && checkout.total_details.amount_shipping === 0
        && JSON.stringify(checkout.payment_method_types) === JSON.stringify(['card']), 'FIXTURE_AMOUNT_OR_POLICY_MISMATCH');
      require(checkout.success_url === RETURN_URL && checkout.cancel_url === RETURN_URL, 'FIXTURE_RETURN_TARGET_MISMATCH');
      require(['open', 'complete', 'expired'].includes(checkout.status ?? '')
        && ['paid', 'unpaid'].includes(checkout.payment_status)
        && (checkout.payment_status !== 'paid' || checkout.status === 'complete'), 'CHECKOUT_STATE_UNSUPPORTED');
      const customer = await sdk.customers.retrieve(customerId);
      require(customer.id === customerId && customer.deleted !== true && customer.object === 'customer'
        && customer.livemode === false, 'FIXTURE_CUSTOMER_MISMATCH');
      sameMetadata(customer.metadata, metadata(input.runId, input.accountId, 'customer'));
      const inventory = await sdk.checkout.sessions.listLineItems(checkoutId, { limit: 2, expand: ['data.price'] });
      require(inventory.has_more === false && inventory.data.length === 1, 'FIXTURE_LINE_INVENTORY_MISMATCH');
      const line = inventory.data[0]!, price = line.price;
      require(line.quantity === 1 && line.currency === 'eur' && line.amount_subtotal === 100 && line.amount_total === 100
        && line.amount_tax === 0 && line.amount_discount === 0 && price?.id === priceId && price.object === 'price'
        && price.livemode === false && price.currency === 'eur' && price.unit_amount === 100
        && price.type === 'one_time' && price.tax_behavior === 'exclusive' && price.product === productId, 'FIXTURE_PRICE_MISMATCH');
      let intentStatus: string | null = null, received = 0;
      if (checkout.payment_intent !== null) {
        const intentId = reference(checkout.payment_intent, 'pi_');
        allowed.set('/v1/payment_intents/' + intentId, []);
        const intent = await sdk.paymentIntents.retrieve(intentId);
        require(intent.id === intentId && intent.object === 'payment_intent' && intent.livemode === false
          && intent.customer === customerId && intent.currency === 'eur' && intent.amount === 100, 'FIXTURE_PAYMENT_INTENT_MISMATCH');
        sameMetadata(intent.metadata, expected);
        require(['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded'].includes(intent.status),
          'PAYMENT_INTENT_STATE_UNSUPPORTED');
        const paid = checkout.payment_status === 'paid';
        require(paid ? intent.status === 'succeeded' && intent.amount_received === 100
          : intent.status !== 'succeeded' && intent.amount_received === 0, 'PAYMENT_STATE_INCONSISTENT');
        intentStatus = intent.status; received = intent.amount_received;
      } else require(checkout.payment_status === 'unpaid', 'PAYMENT_INTENT_REQUIRED');
      observation = {
        schema_version: 1, kind: 'existing-synthetic-checkout-observation', observed_at: now.toISOString(),
        api_version: STRIPE_API_VERSION, original_receipt_sha256: input.receiptSha256,
        fixture_identity_sha256: { account: hash(input.accountId), checkout: hash(checkoutId), customer: hash(customerId) },
        mode: 'test', amount_total_minor: 100, currency: 'eur', checkout_status: checkout.status,
        payment_status: checkout.payment_status, bound_payment_intent_status: intentStatus, amount_received_minor: received,
        payment_confirmed: checkout.payment_status === 'paid' && intentStatus === 'succeeded',
        stored_return_urls: { success: RETURN_URL, cancel: RETURN_URL }, exact_fixture_binding_verified: true,
        original_receipt_unchanged: true, provider_get_requests: transport.count(), provider_mutations: 0,
        application_ledger_writes: 0, application_reconciliation_verified: false, browser_return_verified: false,
        verification_only: true, release_authorized: false,
      };
    } catch (error) { throw error instanceof Refused ? error : new Refused('PROVIDER_READ_FAILED'); }
    privateFile(fd);
    const final = fstatSync(fd), pathState = lstatSync(input.receiptPath);
    require(initial.dev === final.dev && initial.ino === final.ino && initial.size === final.size
      && initial.mtimeMs === final.mtimeMs && initial.ctimeMs === final.ctimeMs
      && pathState.dev === initial.dev && pathState.ino === initial.ino && !pathState.isSymbolicLink()
      && hash(receiptBytes(fd)) === input.receiptSha256, 'ORIGINAL_RECEIPT_CHANGED');
    outputTarget(target, input.receiptPath);
    const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(output);
      require(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.()
        && (stat.mode & 0o777) === 0o600 && !(stat.dev === initial.dev && stat.ino === initial.ino), 'PRIVATE_NEW_OUTPUT_REQUIRED');
      writeFileSync(output, JSON.stringify(observation, null, 2) + '\n'); fsyncSync(output);
    } finally { closeSync(output); }
    return observation;
  } finally { closeSync(fd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    require(process.env.BILLING_SANDBOX_OBSERVE === 'true', 'EXPLICIT_OBSERVER_OPT_IN_REQUIRED');
    const result = await observeExistingCheckout({
      receiptPath: process.env.BILLING_SMOKE_REPORT ?? '', receiptSha256: process.env.BILLING_SMOKE_RECEIPT_SHA256 ?? '',
      observationPath: process.env.BILLING_OBSERVATION_REPORT ?? '', runId: process.env.BILLING_SMOKE_RUN_ID ?? '',
      accountId: process.env.STRIPE_ACCOUNT_ID ?? '', secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'REFUSED', code: error instanceof Refused ? error.code : 'OBSERVER_INPUT_OR_OUTPUT_REFUSED' }) + '\n');
    process.exitCode = 1;
  }
}
