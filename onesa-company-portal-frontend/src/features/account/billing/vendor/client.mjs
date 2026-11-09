const PREFIX = '/api/v1/account/billing';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const STATES = new Set(['prepared', 'dispatched', 'succeeded', 'failed', 'unknown']);
const KINDS = new Set(['customer_create', 'checkout_create', 'invoice_create', 'invoice_finalize', 'portal_create']);
const MAX_RESPONSE = 131_072;

export class BillingClientError extends Error {
  constructor(code, status = 0, uncertain = false) {
    super(code);
    this.name = 'BillingClientError';
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

function requireValue(value, code = 'INVALID_RESPONSE') {
  if (!value) throw new BillingClientError(code);
}
function object(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function string(value, max = 200) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value));
  return value;
}
function id(value) {
  requireValue(typeof value === 'string' && UUID.test(value), 'INVALID_IDENTIFIER');
  return value;
}
function integer(value, minimum = 0) {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum);
  return value;
}
function account(value) {
  const row = object(value);
  requireValue(['active', 'suspended', 'closed'].includes(row.status) && ['owner', 'payer', 'viewer'].includes(row.role));
  return Object.freeze({ id: id(row.id), displayName: string(row.displayName), status: row.status,
    revision: integer(row.revision, 1), role: row.role });
}
function catalog(value) {
  const row = object(value);
  requireValue(['test', 'live'].includes(row.mode) && typeof row.salesEnabled === 'boolean'
    && Array.isArray(row.items) && row.items.length <= 100);
  const seen = new Set();
  const items = row.items.map(value => {
    const item = object(value), sku = string(item.sku, 100);
    requireValue(!seen.has(sku) && typeof item.currency === 'string' && /^[a-z]{3}$/.test(item.currency)
      && ['inclusive', 'exclusive'].includes(item.taxBehavior));
    seen.add(sku);
    return Object.freeze({ sku, title: string(item.title), version: string(item.version, 100), currency: item.currency,
      unitAmount: integer(item.unitAmount), maxQuantity: integer(item.maxQuantity, 1), taxBehavior: item.taxBehavior });
  });
  return Object.freeze({ mode: row.mode, salesEnabled: row.salesEnabled, items: Object.freeze(items) });
}

/** A provider URL is only usable after the authenticated service has returned it. */
export function trustedHostedUrl(value, kind) {
  if (value === null || value === undefined) return null;
  string(value, 4096);
  const host = kind === 'checkout_create' ? 'checkout.stripe.com'
    : kind === 'invoice_create' || kind === 'invoice_finalize' ? 'invoice.stripe.com'
      : kind === 'portal_create' ? 'billing.stripe.com' : null;
  let parsed;
  try { parsed = new URL(value); } catch { throw new BillingClientError('INVALID_REDIRECT'); }
  requireValue(host && parsed.protocol === 'https:' && parsed.hostname === host && parsed.port === ''
    && parsed.username === '' && parsed.password === '', 'INVALID_REDIRECT');
  return parsed.href;
}

function operation(value, expectedAccountId) {
  const row = object(value);
  requireValue(KINDS.has(row.kind) && STATES.has(row.state) && typeof row.reviewRequired === 'boolean');
  const accountId = id(row.accountId);
  requireValue(!expectedAccountId || accountId === expectedAccountId, 'ACCOUNT_MISMATCH');
  requireValue(row.providerState === null || (typeof row.providerState === 'string' && row.providerState.length <= 100));
  requireValue(row.paymentConfirmed === undefined || typeof row.paymentConfirmed === 'boolean');
  const redirectUrl = trustedHostedUrl(row.redirectUrl, row.kind);
  // A navigation/return URL never supplies payment status; only a verified server read does.
  const paymentConfirmed = row.state === 'succeeded' && row.paymentConfirmed === true;
  const result = { id: id(row.id), accountId, commercialIntentId: id(row.commercialIntentId), kind: row.kind,
    state: row.state, providerState: row.providerState, reviewRequired: row.reviewRequired,
    redirectUrl, paymentConfirmed };
  if (row.amountMinor !== undefined) result.amountMinor = integer(row.amountMinor);
  if (row.currency !== undefined) {
    requireValue(typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency));
    result.currency = row.currency;
  }
  return Object.freeze(result);
}

async function boundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE)) {
    await response.body?.cancel().catch(() => {});
    throw new BillingClientError('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  requireValue(reader);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      requireValue(bytes <= MAX_RESPONSE);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
  catch { throw new BillingClientError('INVALID_RESPONSE'); }
}

/** Same-origin browser transport. It cannot accept an API origin, JWT or Stripe credential. */
export function createBillingClient({ csrf, fetch: fetcher = globalThis.fetch, idFactory = () => crypto.randomUUID() }) {
  requireValue(typeof csrf === 'function' && typeof fetcher === 'function' && typeof idFactory === 'function', 'INVALID_CLIENT');
  async function request(path, { method = 'GET', body, key, signal } = {}) {
    const mutation = method !== 'GET';
    const headers = { Accept: 'application/json' };
    if (mutation) {
      const proof = csrf();
      requireValue(typeof proof === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(proof), 'SESSION_REQUIRED');
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = proof;
      if (key !== undefined) {
        requireValue(typeof key === 'string' && KEY.test(key), 'INVALID_IDEMPOTENCY_KEY');
        headers['Idempotency-Key'] = key;
      }
    }
    let response;
    try {
      response = await fetcher(PREFIX + path, { method, headers, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        ...(mutation ? { body: JSON.stringify(body) } : {}) });
      const value = await boundedJson(response);
      if (!response.ok) {
        const code = value?.error?.code;
        throw new BillingClientError(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REQUEST_FAILED',
          response.status, mutation && response.status >= 500);
      }
      return value;
    } catch (error) {
      if (error instanceof BillingClientError) {
        if (mutation && error.status === 0) error.uncertain = true;
        throw error;
      }
      // Never expose an upstream body, URL, session or fetch exception to the page.
      throw new BillingClientError(signal?.aborted ? 'REQUEST_CANCELLED' : 'SERVICE_UNAVAILABLE', 0, mutation);
    }
  }
  const api = {
    newKey() { const key = idFactory(); requireValue(typeof key === 'string' && KEY.test(key), 'INVALID_IDEMPOTENCY_KEY'); return key; },
    async catalog(signal) { return catalog(await request('/catalog', { signal })); },
    async accounts(signal) {
      const rows = await request('/accounts', { signal });
      requireValue(Array.isArray(rows) && rows.length <= 100);
      return Object.freeze(rows.map(account));
    },
    async createAccount(displayName, signal) {
      string(displayName);
      requireValue(displayName.trim() === displayName, 'INVALID_ACCOUNT_NAME');
      return account(await request('/accounts', { method: 'POST', body: { displayName }, signal }));
    },
    async operations(accountId, signal) {
      const rows = await request(`/accounts/${id(accountId)}/operations`, { signal });
      requireValue(Array.isArray(rows) && rows.length <= 100);
      return Object.freeze(rows.map(row => operation(row, accountId)));
    },
    async operation(operationId, accountId, signal) {
      const result = operation(await request(`/operations/${id(operationId)}`, { signal }), id(accountId));
      requireValue(result.id === operationId, 'OPERATION_MISMATCH');
      return result;
    },
    async prepareCustomer(accountId, signal) {
      const result = operation(await request(`/accounts/${id(accountId)}/customer`, { method: 'POST', body: {}, signal }), accountId);
      requireValue(result.kind === 'customer_create', 'OPERATION_MISMATCH');
      return result;
    },
    async createCheckoutIntent(accountId, items, key, signal) {
      requireValue(Array.isArray(items) && items.length > 0 && items.length <= 8, 'INVALID_ITEMS');
      const rows = items.map(item => ({ sku: string(item.sku, 100), quantity: integer(item.quantity, 1) }));
      requireValue(new Set(rows.map(row => row.sku)).size === rows.length, 'INVALID_ITEMS');
      const result = object(await request(`/accounts/${id(accountId)}/intents`, {
        method: 'POST', body: { kind: 'checkout', items: rows }, key, signal,
      }));
      requireValue(result.kind === 'checkout' && result.accountId === accountId && Array.isArray(result.items)
        && JSON.stringify(result.items) === JSON.stringify(rows), 'INTENT_MISMATCH');
      return Object.freeze({ id: id(result.id), accountId, kind: 'checkout', items: Object.freeze(rows.map(Object.freeze)) });
    },
    async submitCheckout(accountId, intentId, key, signal) {
      const result = operation(await request(`/accounts/${id(accountId)}/intents/${id(intentId)}/submit`, {
        method: 'POST', body: {}, key, signal,
      }), accountId);
      requireValue(result.kind === 'checkout_create' && result.commercialIntentId === intentId, 'OPERATION_MISMATCH');
      return result;
    },
  };
  return Object.freeze(api);
}

/** One user purchase owns one pair of nonces for its entire lifetime, including uncertain responses. */
export function createCheckoutAttempt(client, accountId, items) {
  id(accountId);
  requireValue(Array.isArray(items) && items.length > 0 && items.length <= 8, 'INVALID_ITEMS');
  const frozenItems = Object.freeze(items.map(item => Object.freeze({ sku: string(item.sku, 100), quantity: integer(item.quantity, 1) })));
  const intentKey = client.newKey(), submitKey = client.newKey();
  let customer = null, intent = null, current = null, flight = null, submitAttempted = false;
  const snapshot = () => Object.freeze({ accountId, intentId: intent?.id ?? null, operation: current ?? customer,
    phase: current ? 'checkout' : intent ? 'submitting' : customer ? 'customer' : 'starting' });
  async function step(signal) {
    if (!customer) customer = await client.prepareCustomer(accountId, signal);
    else if (customer.state !== 'succeeded' && !['unknown', 'failed'].includes(customer.state)) {
      customer = await client.operation(customer.id, accountId, signal);
    }
    if (customer.state !== 'succeeded' || customer.reviewRequired) return snapshot();
    if (!intent) intent = await client.createCheckoutIntent(accountId, frozenItems, intentKey, signal);
    if (!current && submitAttempted) {
      const recorded = (await client.operations(accountId, signal)).filter(row =>
        row.kind === 'checkout_create' && row.commercialIntentId === intent.id);
      requireValue(recorded.length <= 1, 'OPERATION_MISMATCH');
      current = recorded[0] ?? null;
    }
    if (!current) {
      submitAttempted = true;
      current = await client.submitCheckout(accountId, intent.id, submitKey, signal);
    } else current = await client.operation(current.id, accountId, signal);
    return snapshot();
  }
  return Object.freeze({
    snapshot,
    advance(signal) {
      if (!flight) flight = step(signal).finally(() => { flight = null; });
      return flight;
    },
  });
}

export function operationStatus(operation) {
  if (operation.paymentConfirmed === true && operation.state === 'succeeded') return 'Paid';
  if (operation.reviewRequired || ['unknown', 'failed'].includes(operation.state)) return 'Needs review';
  if (operation.state !== 'succeeded') return 'Processing';
  if (operation.kind === 'customer_create') return 'Ready';
  if (operation.providerState === 'draft') return 'Draft';
  if (operation.providerState === 'void') return 'Voided';
  if (operation.providerState === 'uncollectible') return 'Unpaid';
  if (operation.providerState?.startsWith('expired')) return 'Expired';
  return 'Awaiting payment confirmation';
}

export function blocksNewCheckout(operation) {
  if (operation.kind !== 'checkout_create') return false;
  if (operation.reviewRequired || operation.state !== 'succeeded') return true;
  return operation.paymentConfirmed !== true && !operation.providerState?.startsWith('expired');
}
