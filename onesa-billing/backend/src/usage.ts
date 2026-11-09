import { createHash } from 'node:crypto';
import { Actor, BillingError, ensure, ProviderScope } from './domain.js';

export const USAGE_SAFE_WINDOW_MS = 33 * 24 * 60 * 60 * 1_000;
export const USAGE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const USAGE_MAX_ATTEMPTS = 1_000;

export interface UsageBinding {
  accountId: string;
  scope: ProviderScope;
  stripeCustomerId: string;
  metronomeCustomerId: string;
  metronomeProjectId: string;
  environment: 'sandbox' | 'production';
  contractId: string;
  meterId: string;
  eventType: string;
  quantityKey: string;
  properties: Readonly<Record<string, string>>;
  periodStart: string;
  periodEnd: string;
  ingestUntil: string;
}

export interface UsageProducerGrant {
  actor: Actor;
  accountId: string;
  scope: ProviderScope;
  allowedMeterIds: readonly string[];
  expiresAt: string;
}

declare const producerBrand: unique symbol;
/** Only the configured credential verifier can mint this process-local principal. */
export interface VerifiedUsageProducer { readonly [producerBrand]: true }
const producers = new WeakMap<object, UsageProducerGrant>();

export interface MetronomeEvent {
  transaction_id: string;
  customer_id: string;
  event_type: string;
  timestamp: string;
  properties: Readonly<Record<string, string>>;
}

export interface PreparedUsageEvent {
  transactionId: string;
  payloadFingerprint: string;
  sourceEventId: string;
  accountId: string;
  producer: Actor;
  scope: ProviderScope;
  meterId: string;
  quantity: string;
  occurredAt: string;
  recordedAt: string;
  binding: UsageBinding;
  payload: MetronomeEvent;
}

export interface UsageClaim {
  eventId: string;
  leaseToken: string;
  fence: number;
  expiresAt: string;
  firstAttemptAt: string;
  retryDeadline: string;
  attemptCount: number;
  event: PreparedUsageEvent;
}

export type UsageFailureReason =
  | 'invalid_claim' | 'payload_integrity' | 'provider_scope_mismatch'
  | 'provider_configuration' | 'provider_rejected' | 'provider_protocol'
  | 'network_or_timeout' | 'rate_limited' | 'provider_unavailable'
  | 'retry_deadline_exceeded' | 'attempt_limit_exceeded';

export type UsageOutcome =
  | { status: 'accepted'; acceptedAt: string }
  | { status: 'retry'; reason: UsageFailureReason; nextAttemptAt: string }
  | { status: 'quarantined'; reason: UsageFailureReason };

export type UsageDeliveryResult =
  | { status: 'accepted' }
  | { status: 'retry'; reason: UsageFailureReason; retryAfterMs?: number }
  | { status: 'quarantined'; reason: UsageFailureReason };

export interface UsageTransport {
  ingest(events: readonly PreparedUsageEvent[], signal: AbortSignal): Promise<UsageDeliveryResult>;
}

export interface UsageExportStore {
  enqueueUsage(event: PreparedUsageEvent): Promise<{ created: boolean; eventId: string }>;
  /** Atomically persists the immutable first attempt and a new fenced lease BEFORE returning. */
  claimUsage(now: Date, leaseMs: number): Promise<UsageClaim | null>;
  /** Rejects stale/expired lease tokens and fences; never changes the provider transaction ID. */
  settleUsage(claim: UsageClaim, outcome: UsageOutcome, now: Date): Promise<void>;
}

function object(value: unknown, code = 'INVALID_USAGE'): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null, code);
}

function keys(value: Record<string, unknown>, expected: readonly string[], code = 'INVALID_USAGE'): void {
  const actual = Object.keys(value).sort();
  ensure(actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i]), code);
}

function text(value: unknown, max = 256, code = 'INVALID_USAGE'): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), code);
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, 128);
  ensure(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result), 'INVALID_USAGE');
  return result;
}

export function canonicalUsageTimestamp(value: unknown): string {
  const raw = text(value, 30);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(raw);
  ensure(match, 'INVALID_USAGE_TIMESTAMP');
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const time = Date.parse(normalized);
  ensure(Number.isFinite(time) && new Date(time).toISOString() === normalized, 'INVALID_USAGE_TIMESTAMP');
  return normalized;
}

export function canonicalUsageQuantity(value: unknown): string {
  ensure(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/u.test(value), 'INVALID_USAGE_QUANTITY');
  // Never convert a billable decimal through a binary floating point number.
  return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
}

function scope(value: unknown): ProviderScope {
  object(value);
  keys(value, ['application', 'stripeAccountId', 'mode', 'configVersion']);
  ensure(value.application === 'company' && (value.mode === 'test' || value.mode === 'live'), 'INVALID_USAGE_SCOPE');
  const stripeAccountId = identifier(value.stripeAccountId);
  ensure(/^acct_[A-Za-z0-9]+$/u.test(stripeAccountId), 'INVALID_USAGE_SCOPE');
  return { application: 'company', stripeAccountId, mode: value.mode, configVersion: identifier(value.configVersion) };
}

export function sameUsageScope(left: ProviderScope, right: ProviderScope): boolean {
  return left.application === right.application && left.stripeAccountId === right.stripeAccountId
    && left.mode === right.mode && left.configVersion === right.configVersion;
}

function actor(value: unknown): Actor {
  object(value);
  keys(value, ['issuer', 'subject']);
  return { issuer: text(value.issuer, 512), subject: text(value.subject, 256) };
}

function properties(value: unknown): Readonly<Record<string, string>> {
  object(value);
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  ensure(entries.length <= 16, 'INVALID_USAGE_PROPERTIES');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, val] of entries) {
    ensure(/^[a-z][a-z0-9_]{0,63}$/u.test(key) && !['constructor', 'prototype'].includes(key), 'INVALID_USAGE_PROPERTIES');
    result[key] = text(val, 256, 'INVALID_USAGE_PROPERTIES');
  }
  return Object.freeze(result);
}

function binding(value: unknown): UsageBinding {
  object(value);
  keys(value, ['accountId', 'scope', 'stripeCustomerId', 'metronomeCustomerId', 'metronomeProjectId', 'environment',
    'contractId', 'meterId', 'eventType', 'quantityKey', 'properties', 'periodStart', 'periodEnd', 'ingestUntil']);
  const boundScope = scope(value.scope);
  const environment = boundScope.mode === 'test' ? 'sandbox' : 'production';
  ensure(value.environment === environment, 'USAGE_ENVIRONMENT_MISMATCH');
  const stripeCustomerId = identifier(value.stripeCustomerId);
  ensure(/^cus_[A-Za-z0-9]+$/u.test(stripeCustomerId), 'INVALID_USAGE_CUSTOMER');
  const quantityKey = text(value.quantityKey, 64);
  ensure(/^[a-z][a-z0-9_]{0,63}$/u.test(quantityKey) && !['constructor', 'prototype'].includes(quantityKey), 'INVALID_USAGE_PROPERTIES');
  const fixedProperties = properties(value.properties);
  ensure(!Object.hasOwn(fixedProperties, quantityKey), 'INVALID_USAGE_PROPERTIES');
  const periodStart = canonicalUsageTimestamp(value.periodStart);
  const periodEnd = canonicalUsageTimestamp(value.periodEnd);
  const ingestUntil = canonicalUsageTimestamp(value.ingestUntil);
  ensure(Date.parse(periodStart) < Date.parse(periodEnd)
    && Date.parse(ingestUntil) >= Date.parse(periodEnd)
    && Date.parse(ingestUntil) <= Date.parse(periodEnd) + USAGE_SAFE_WINDOW_MS, 'INVALID_USAGE_PERIOD');
  return Object.freeze({
    accountId: identifier(value.accountId), scope: Object.freeze(boundScope), stripeCustomerId,
    metronomeCustomerId: identifier(value.metronomeCustomerId), metronomeProjectId: identifier(value.metronomeProjectId),
    environment, contractId: identifier(value.contractId), meterId: identifier(value.meterId),
    eventType: identifier(value.eventType), quantityKey, properties: fixedProperties, periodStart, periodEnd, ingestUntil,
  });
}

function clockTime(now: Date): number {
  ensure(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_USAGE_CLOCK');
  return now.getTime();
}

/** The injected verifier is trusted server configuration, never a request field. */
export function createUsageProducerAuthenticator(
  verifier: (credential: string) => Promise<UsageProducerGrant | null>,
): (credential: string) => Promise<VerifiedUsageProducer> {
  return async (credential) => {
    text(credential, 8_192, 'USAGE_PRODUCER_UNAUTHORIZED');
    let result: UsageProducerGrant | null;
    try { result = await verifier(credential); } catch { throw new BillingError('USAGE_PRODUCER_UNAUTHORIZED', 401); }
    ensure(result, 'USAGE_PRODUCER_UNAUTHORIZED', 401);
    object(result, 'USAGE_PRODUCER_UNAUTHORIZED');
    keys(result, ['actor', 'accountId', 'scope', 'allowedMeterIds', 'expiresAt'], 'USAGE_PRODUCER_UNAUTHORIZED');
    ensure(Array.isArray(result.allowedMeterIds) && result.allowedMeterIds.length > 0 && result.allowedMeterIds.length <= 64,
      'USAGE_PRODUCER_UNAUTHORIZED', 401);
    const grant: UsageProducerGrant = Object.freeze({
      actor: Object.freeze(actor(result.actor)), accountId: identifier(result.accountId), scope: Object.freeze(scope(result.scope)),
      allowedMeterIds: Object.freeze([...new Set(result.allowedMeterIds.map(identifier))]),
      expiresAt: canonicalUsageTimestamp(result.expiresAt),
    });
    const principal = Object.freeze(Object.create(null)) as VerifiedUsageProducer;
    producers.set(principal, grant);
    return principal;
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

function transactionId(event: Pick<PreparedUsageEvent, 'scope' | 'accountId' | 'producer' | 'sourceEventId'>): string {
  return `onesa_${digest(['company-usage-v1', event.scope.application, event.scope.stripeAccountId, event.scope.mode,
    event.accountId, event.producer.issuer, event.producer.subject, event.sourceEventId])}`;
}

function makePayload(event: Pick<PreparedUsageEvent, 'transactionId' | 'binding' | 'quantity' | 'occurredAt'>): MetronomeEvent {
  return Object.freeze({
    transaction_id: event.transactionId, customer_id: event.binding.metronomeCustomerId,
    event_type: event.binding.eventType, timestamp: event.occurredAt,
    properties: Object.freeze({ ...event.binding.properties, [event.binding.quantityKey]: event.quantity }),
  });
}

function fingerprint(event: Omit<PreparedUsageEvent, 'payloadFingerprint'>): string {
  // Recording a duplicate later must not create a different commercial operation.
  const { recordedAt: _recordedAt, ...material } = event;
  return digest(material);
}

function payloadMatches(value: unknown, expected: MetronomeEvent): boolean {
  object(value, 'USAGE_PAYLOAD_INTEGRITY');
  keys(value, ['transaction_id', 'customer_id', 'event_type', 'timestamp', 'properties'], 'USAGE_PAYLOAD_INTEGRITY');
  object(value.properties, 'USAGE_PAYLOAD_INTEGRITY');
  const expectedKeys = Object.keys(expected.properties);
  keys(value.properties, expectedKeys, 'USAGE_PAYLOAD_INTEGRITY');
  return value.transaction_id === expected.transaction_id && value.customer_id === expected.customer_id
    && value.event_type === expected.event_type && value.timestamp === expected.timestamp
    && expectedKeys.every((key) => value.properties !== null && (value.properties as Record<string, unknown>)[key] === expected.properties[key]);
}

export function prepareUsageEvent(
  input: unknown, principal: VerifiedUsageProducer, selectedBinding: UsageBinding, now: Date,
): PreparedUsageEvent {
  const grant = principal !== null && typeof principal === 'object' ? producers.get(principal) : undefined;
  ensure(grant, 'USAGE_PRODUCER_UNAUTHORIZED', 401);
  const current = clockTime(now);
  ensure(Date.parse(grant.expiresAt) > current, 'USAGE_PRODUCER_EXPIRED', 401);
  object(input);
  keys(input, ['sourceEventId', 'meterId', 'quantity', 'occurredAt']);
  const selected = binding(selectedBinding);
  ensure(grant.accountId === selected.accountId && sameUsageScope(grant.scope, selected.scope)
    && grant.allowedMeterIds.includes(selected.meterId), 'USAGE_PRODUCER_FORBIDDEN', 403);
  ensure(input.meterId === selected.meterId, 'USAGE_METER_MISMATCH', 403);
  const occurredAt = canonicalUsageTimestamp(input.occurredAt);
  const occurred = Date.parse(occurredAt);
  ensure(occurred <= current + USAGE_FUTURE_SKEW_MS && occurred > current - USAGE_SAFE_WINDOW_MS, 'USAGE_TIME_WINDOW');
  ensure(occurred >= Date.parse(selected.periodStart) && occurred < Date.parse(selected.periodEnd), 'USAGE_PERIOD_MISMATCH');
  ensure(current < Date.parse(selected.ingestUntil), 'USAGE_PERIOD_CLOSED', 409);
  const core = {
    sourceEventId: identifier(input.sourceEventId), accountId: selected.accountId, producer: grant.actor,
    scope: selected.scope, meterId: selected.meterId, quantity: canonicalUsageQuantity(input.quantity),
    occurredAt, recordedAt: now.toISOString(), binding: selected,
  };
  const withId = { ...core, transactionId: transactionId(core) };
  const withPayload = { ...withId, payload: makePayload(withId) };
  return Object.freeze({ ...withPayload, payloadFingerprint: fingerprint(withPayload) });
}

/** Rechecks persisted JSON before enqueue or export; no caller-supplied hash is trusted. */
export function validatePreparedUsageEvent(value: unknown): PreparedUsageEvent {
  object(value, 'USAGE_PAYLOAD_INTEGRITY');
  keys(value, ['transactionId', 'payloadFingerprint', 'sourceEventId', 'accountId', 'producer', 'scope', 'meterId',
    'quantity', 'occurredAt', 'recordedAt', 'binding', 'payload'], 'USAGE_PAYLOAD_INTEGRITY');
  const core = {
    sourceEventId: identifier(value.sourceEventId), accountId: identifier(value.accountId), producer: Object.freeze(actor(value.producer)),
    scope: Object.freeze(scope(value.scope)), meterId: identifier(value.meterId), quantity: canonicalUsageQuantity(value.quantity),
    occurredAt: canonicalUsageTimestamp(value.occurredAt), recordedAt: canonicalUsageTimestamp(value.recordedAt), binding: binding(value.binding),
  };
  ensure(core.quantity === value.quantity && core.occurredAt === value.occurredAt && core.recordedAt === value.recordedAt
    && core.accountId === core.binding.accountId && core.meterId === core.binding.meterId && sameUsageScope(core.scope, core.binding.scope),
  'USAGE_PAYLOAD_INTEGRITY');
  const occurred = Date.parse(core.occurredAt);
  const recorded = Date.parse(core.recordedAt);
  ensure(occurred >= Date.parse(core.binding.periodStart) && occurred < Date.parse(core.binding.periodEnd)
    && occurred <= recorded + USAGE_FUTURE_SKEW_MS && occurred > recorded - USAGE_SAFE_WINDOW_MS
    && recorded < Date.parse(core.binding.ingestUntil), 'USAGE_PAYLOAD_INTEGRITY');
  const withId = { ...core, transactionId: transactionId(core) };
  const withPayload = { ...withId, payload: makePayload(withId) };
  const expected = fingerprint(withPayload);
  ensure(value.transactionId === withId.transactionId && value.payloadFingerprint === expected
    && payloadMatches(value.payload, withPayload.payload), 'USAGE_PAYLOAD_INTEGRITY');
  return Object.freeze({ ...withPayload, payloadFingerprint: expected });
}

export function usageRetryDeadline(event: PreparedUsageEvent, firstAttemptAt: string): string {
  const verified = validatePreparedUsageEvent(event);
  const first = Date.parse(canonicalUsageTimestamp(firstAttemptAt));
  ensure(first >= Date.parse(verified.recordedAt), 'INVALID_USAGE_ATTEMPT');
  return new Date(Math.min(first + USAGE_SAFE_WINDOW_MS, Date.parse(verified.occurredAt) + USAGE_SAFE_WINDOW_MS,
    Date.parse(verified.binding.ingestUntil))).toISOString();
}

export interface UsageExportOptions {
  clock?: () => Date;
  leaseMs?: number;
  requestTimeoutMs?: number;
}

/** One bounded export tick. A successful ingestion receipt is not an invoice/payment receipt. */
export async function exportNextUsage(
  store: UsageExportStore, transport: UsageTransport, options: UsageExportOptions = {},
): Promise<{ eventId: string; outcome: UsageOutcome } | null> {
  const clock = options.clock ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  ensure(Number.isSafeInteger(leaseMs) && leaseMs >= 3_000 && leaseMs <= 120_000
    && Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 && requestTimeoutMs <= 30_000
    && requestTimeoutMs + 1_000 < leaseMs, 'INVALID_USAGE_WORKER_BOUNDS');
  const claim = await store.claimUsage(clock(), leaseMs);
  if (!claim) return null;
  let outcome: UsageOutcome;
  let event: PreparedUsageEvent;
  try { event = validatePreparedUsageEvent(claim.event); } catch {
    outcome = { status: 'quarantined', reason: 'payload_integrity' };
    await store.settleUsage(claim, outcome, clock());
    return { eventId: claim.eventId, outcome };
  }
  let remaining: number;
  try {
    const now = clockTime(clock());
    identifier(claim.eventId);
    identifier(claim.leaseToken);
    const expiry = Date.parse(canonicalUsageTimestamp(claim.expiresAt));
    const first = Date.parse(canonicalUsageTimestamp(claim.firstAttemptAt));
    ensure(Number.isSafeInteger(claim.fence) && claim.fence > 0 && Number.isSafeInteger(claim.attemptCount)
      && claim.attemptCount > 0 && first <= now && expiry > now + 1_000, 'INVALID_USAGE_CLAIM');
    ensure(claim.retryDeadline === usageRetryDeadline(event, claim.firstAttemptAt), 'INVALID_USAGE_CLAIM');
    remaining = Math.min(expiry - now - 1_000, Date.parse(claim.retryDeadline) - now, requestTimeoutMs);
  } catch {
    outcome = { status: 'quarantined', reason: 'invalid_claim' };
    await store.settleUsage(claim, outcome, clock());
    return { eventId: claim.eventId, outcome };
  }
  if (remaining <= 0 || claim.attemptCount > USAGE_MAX_ATTEMPTS) {
    outcome = { status: 'quarantined', reason: remaining <= 0 ? 'retry_deadline_exceeded' : 'attempt_limit_exceeded' };
  } else {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: UsageDeliveryResult;
    try {
      result = await Promise.race([
        transport.ingest([event], controller.signal),
        new Promise<UsageDeliveryResult>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve({ status: 'retry', reason: 'network_or_timeout' }); }, remaining);
        }),
      ]);
    } catch (error) {
      result = error instanceof BillingError
        ? { status: 'quarantined', reason: 'provider_configuration' }
        : { status: 'retry', reason: 'network_or_timeout' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    const finished = clockTime(clock());
    if (result.status === 'accepted') outcome = { status: 'accepted', acceptedAt: new Date(finished).toISOString() };
    else if (result.status === 'quarantined') outcome = result;
    else {
      const requestedDelay = result.retryAfterMs;
      const minimumDelay = Math.min(3_600_000, 1_000 * 2 ** Math.min(claim.attemptCount - 1, 12));
      const delay = requestedDelay !== undefined && Number.isFinite(requestedDelay)
        ? Math.max(minimumDelay, Math.min(3_600_000, Math.max(0, requestedDelay))) : minimumDelay;
      const next = finished + delay;
      outcome = next >= Date.parse(claim.retryDeadline)
        ? { status: 'quarantined', reason: 'retry_deadline_exceeded' }
        : claim.attemptCount >= USAGE_MAX_ATTEMPTS
          ? { status: 'quarantined', reason: 'attempt_limit_exceeded' }
          : { status: 'retry', reason: result.reason, nextAttemptAt: new Date(next).toISOString() };
    }
  }
  await store.settleUsage(claim, outcome, clock());
  return { eventId: claim.eventId, outcome };
}
