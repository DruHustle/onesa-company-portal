import { ensure, ProviderScope } from './domain.js';
import { PreparedUsageEvent, sameUsageScope, UsageDeliveryResult, UsageTransport, validatePreparedUsageEvent } from './usage.js';

export const METRONOME_INGEST_URL = 'https://api.metronome.com/v1/ingest';
const MAX_REQUEST_BYTES = 512_000;

export interface MetronomeTransportConfig {
  scope: ProviderScope;
  metronomeProjectId: string;
  environment: 'sandbox' | 'production';
  requestTimeoutMs?: number;
}

export type MetronomeFetch = (url: string, init: RequestInit) => Promise<Response>;

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.length > 64) return undefined;
  if (/^[0-9]{1,8}$/u.test(value)) return Math.min(3_600_000, Number(value) * 1_000);
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.min(3_600_000, Math.max(0, timestamp - now));
  }
  return undefined;
}

/** No customer, metric, contract, or Stripe invoice provisioning is performed here. */
export function createMetronomeTransport(
  config: MetronomeTransportConfig, token: string, fetcher: MetronomeFetch = fetch,
): UsageTransport {
  ensure(config.scope.application === 'company' && /^acct_[A-Za-z0-9]+$/u.test(config.scope.stripeAccountId)
    && ['test', 'live'].includes(config.scope.mode) && typeof config.scope.configVersion === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.scope.configVersion), 'METRONOME_INVALID_SCOPE');
  ensure(config.environment === (config.scope.mode === 'test' ? 'sandbox' : 'production')
    && typeof config.metronomeProjectId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.metronomeProjectId), 'METRONOME_INVALID_SCOPE');
  ensure(typeof token === 'string' && token.length > 0 && token.length <= 4_096
    && /^[\u0021-\u007e]+$/u.test(token), 'METRONOME_NOT_CONFIGURED', 503);
  const timeout = config.requestTimeoutMs ?? 10_000;
  ensure(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 30_000, 'METRONOME_INVALID_TIMEOUT');
  // Snapshot configured custody; changing a caller's object cannot retarget queued events.
  const configuredScope = Object.freeze({ ...config.scope });
  const configuredProject = config.metronomeProjectId;
  const configuredEnvironment = config.environment;

  return Object.freeze({
    async ingest(events: readonly PreparedUsageEvent[], signal: AbortSignal): Promise<UsageDeliveryResult> {
      ensure(Array.isArray(events) && events.length >= 1 && events.length <= 100, 'METRONOME_INVALID_BATCH');
      const verified = events.map(validatePreparedUsageEvent);
      if (verified.some((event) => !sameUsageScope(event.scope, configuredScope)
        || event.binding.metronomeProjectId !== configuredProject || event.binding.environment !== configuredEnvironment)) {
        return { status: 'quarantined', reason: 'provider_scope_mismatch' };
      }
      ensure(new Set(verified.map((event) => event.transactionId)).size === verified.length, 'METRONOME_DUPLICATE_BATCH');
      const body = JSON.stringify(verified.map((event) => event.payload));
      ensure(Buffer.byteLength(body, 'utf8') <= MAX_REQUEST_BYTES, 'METRONOME_REQUEST_TOO_LARGE');
      if (signal.aborted) return { status: 'retry', reason: 'network_or_timeout' };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = fetcher(METRONOME_INGEST_URL, {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body, signal: controller.signal,
        });
        const response = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('METRONOME_TIMEOUT')); }, timeout);
          }),
        ]);
        // The contract specifies HTTP200 without a response body. Never retain raw provider errors.
        if (response.body) void response.body.cancel().catch(() => undefined);
        if (response.status === 200) return { status: 'accepted' };
        if (response.status === 429) return { status: 'retry', reason: 'rate_limited', retryAfterMs: retryAfter(response.headers.get('retry-after'), Date.now()) };
        if (response.status >= 500 && response.status <= 599) return { status: 'retry', reason: 'provider_unavailable' };
        if (response.status === 401 || response.status === 403) return { status: 'quarantined', reason: 'provider_configuration' };
        if (response.status >= 400 && response.status <= 499) return { status: 'quarantined', reason: 'provider_rejected' };
        return { status: 'quarantined', reason: 'provider_protocol' };
      } catch {
        // Timeouts are ambiguous: retry only the exact recorded event within its durable deadline.
        return { status: 'retry', reason: 'network_or_timeout' };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller.abort();
      }
    },
  });
}
