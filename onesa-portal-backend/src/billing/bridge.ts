import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AccountSession, IdentityAccount } from "../identity/accounts.js";
import { error as errorSchema } from "../api/contracts.js";
import { HttpError } from "../services/workflows.js";

const PREFIX = "/api/v1/account/billing";
const RESPONSE_LIMIT = 65_536;
const REQUEST_LIMIT = 16_384;
const UPSTREAM_TIMEOUT_MS = 8_000;
const ASSERTION_SECONDS = 60;
const identifier = z.uuid();
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const empty = z.strictObject({});
const item = z.strictObject({ sku: opaque, quantity: z.number().int().min(1).max(1_000_000) });
const account = z.strictObject({
  id: identifier, displayName: z.string().min(1).max(200),
  status: z.enum(["active", "suspended", "closed"]), revision: z.number().int().min(1),
  role: z.enum(["owner", "payer", "viewer"]),
});
const hostedUrl = z.string().max(4096).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["checkout.stripe.com", "invoice.stripe.com", "billing.stripe.com"].includes(url.hostname)
      && !/[\u0000-\u0020\u007f]/u.test(value);
  } catch { return false; }
});
const operation = z.strictObject({
  id: identifier, accountId: identifier, commercialIntentId: identifier,
  kind: z.enum(["customer_create", "checkout_create", "invoice_create", "invoice_finalize", "portal_create"]),
  state: z.enum(["prepared", "dispatched", "succeeded", "failed", "unknown"]),
  providerState: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/).nullable(), reviewRequired: z.boolean(),
  redirectUrl: hostedUrl.nullable().optional(), paymentConfirmed: z.boolean().optional(),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  currency: z.string().regex(/^[a-z]{3}$/).optional(),
});
const catalog = z.strictObject({
  mode: z.enum(["test", "live"]), salesEnabled: z.boolean(),
  items: z.array(z.strictObject({
    sku: opaque, title: z.string().min(1).max(150), version: opaque,
    currency: z.string().regex(/^[a-z]{3}$/), unitAmount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    taxBehavior: z.enum(["inclusive", "exclusive"]), maxQuantity: z.number().int().min(1).max(1_000_000),
  })).max(100),
});
const intent = z.strictObject({
  id: identifier, kind: z.enum(["checkout", "invoice", "portal"]), accountId: identifier,
  items: z.array(item).max(8), createdAt: z.iso.datetime(),
});
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema,
  409: errorSchema, 413: errorSchema, 429: errorSchema, 500: errorSchema, 502: errorSchema, 503: errorSchema, 504: errorSchema };

export interface BillingBridgeConfiguration {
  readonly privateOrigin: string;
  readonly portalOrigin: string;
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: KeyObject;
}
export interface BillingBridgeDependencies {
  requireAccount(request: FastifyRequest, mutation: boolean): Promise<AccountSession>;
  withLockedSession<T>(session: AccountSession, action: (current: IdentityAccount, expiresAt: Date) => Promise<T>): Promise<T>;
  fetch: typeof fetch;
  now(): Date;
}

function configurationError(): never {
  throw new HttpError(503, "BILLING_BRIDGE_CONFIGURATION", "Company billing is unavailable.");
}
function exactOrigin(value: string | undefined): URL {
  try {
    if (!value || value.length > 2048) return configurationError();
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) return configurationError();
    return url;
  } catch { return configurationError(); }
}
function privateHost(host: string): boolean {
  if (["localhost", "127.0.0.1", "[::1]", "onesa-billing", "onesa-billing-api"].includes(host)) return true;
  if (/^\[(?:fc|fd)[0-9a-f:]+\]$/i.test(host)) return true;
  const parts = host.split(".").map(value => /^\d{1,3}$/.test(value) ? Number(value) : NaN);
  return parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31);
}
function signingMaterial(environment: NodeJS.ProcessEnv): Buffer {
  const path = environment.BILLING_ASSERTION_PRIVATE_KEY_FILE;
  const encoded = environment.BILLING_ASSERTION_PRIVATE_KEY_B64;
  if (Boolean(path) === Boolean(encoded)) return configurationError();
  if (encoded) {
    if (encoded.length > 24_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return configurationError();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 16_384) return configurationError();
    return bytes;
  }
  if (!path || path.length > 4096 || !isAbsolute(path) || path.includes("\0")) return configurationError();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 16_384
      || before.mode & 0o077 || before.uid !== 0 && before.uid !== process.geteuid?.()) return configurationError();
    const buffer = Buffer.alloc(16_385); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const bytes = buffer.subarray(0, offset), after = fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) return configurationError();
    return bytes;
  } catch { return configurationError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Reads only dedicated server configuration. Disabled routes require no secret or issuer setup. */
export function billingBridgeConfiguration(environment: NodeJS.ProcessEnv): BillingBridgeConfiguration | null {
  if (environment.BILLING_BRIDGE_ENABLED === undefined || environment.BILLING_BRIDGE_ENABLED === "false") return null;
  if (environment.BILLING_BRIDGE_ENABLED !== "true") return configurationError();
  const upstream = exactOrigin(environment.BILLING_PRIVATE_ORIGIN);
  if (!privateHost(upstream.hostname)) return configurationError();
  const portal = exactOrigin(environment.PUBLIC_ORIGIN ?? "http://localhost:3300");
  if (portal.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(portal.hostname)) return configurationError();
  const issuer = environment.BILLING_ASSERTION_ISSUER, kid = environment.BILLING_ASSERTION_KID;
  if (!issuer || issuer.length > 512 || !kid || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(kid)) return configurationError();
  try {
    const parsed = new URL(issuer);
    if (parsed.origin !== portal.origin || parsed.username || parsed.password || parsed.search || parsed.hash
      || /[\u0000-\u0020\u007f]/u.test(issuer)) return configurationError();
    const bytes = signingMaterial(environment);
    let privateKey: KeyObject;
    try { privateKey = createPrivateKey({ key: bytes, format: "pem", type: "pkcs8" }); }
    finally { bytes.fill(0); }
    if (privateKey.asymmetricKeyType !== "ed25519") return configurationError();
    return Object.freeze({ privateOrigin: upstream.origin, portalOrigin: portal.origin, issuer, kid, privateKey });
  } catch { return configurationError(); }
}

function checkedAccount(session: AccountSession, current: IdentityAccount, expiresAt: Date, now: Date): void {
  if (current.id !== session.account.id || !identifier.safeParse(current.id).success
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime())
    throw new HttpError(401, "ACCOUNT_REQUIRED", "Your Onesa session has ended. Sign in again.");
  if (!(current.email_verified_at instanceof Date) || !Number.isFinite(current.email_verified_at.getTime()))
    throw new HttpError(403, "BILLING_EMAIL_VERIFICATION_REQUIRED", "Verify your Onesa account email before using billing.");
}
function assertion(config: BillingBridgeConfiguration, current: IdentityAccount, expiresAt: Date, now: Date): string {
  const issued = Math.floor(now.getTime() / 1000), expires = Math.min(issued + ASSERTION_SECONDS, Math.floor(expiresAt.getTime() / 1000));
  if (!Number.isSafeInteger(issued) || expires <= issued) throw new HttpError(401, "ACCOUNT_REQUIRED", "Your Onesa session has ended. Sign in again.");
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.kid })).toString("base64url");
  // Company account membership is resolved independently by billing, never copied from Portal/product roles.
  const claims = Buffer.from(JSON.stringify({ iss: config.issuer, aud: "onesa-billing", sub: current.id,
    scope: "billing:account", iat: issued, exp: expires, jti: randomUUID() })).toString("base64url");
  const input = `${header}.${claims}`;
  return `${input}.${sign(null, Buffer.from(input), config.privateKey).toString("base64url")}`;
}
async function defaultDependencies(): Promise<BillingBridgeDependencies> {
  const [{ requireAccount, lockAccountSession, identityAccount }, { transaction }] = await Promise.all([
    import("../identity/accounts.js"), import("../services/db.js"),
  ]);
  return {
    requireAccount, fetch, now: () => new Date(),
    withLockedSession: (session, action) => transaction(async connection => {
      const expires = await lockAccountSession(connection, session);
      const current = await identityAccount(session.account.id, connection);
      if (!current) throw new HttpError(401, "ACCOUNT_REQUIRED", "Your Onesa session has ended. Sign in again.");
      return action(current, expires);
    }),
  };
}

type Route = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  operationId: string;
  params?: z.ZodType;
  body?: z.ZodType;
  idempotent?: boolean;
  response: z.ZodType;
  statuses: readonly number[];
};
const accountParams = z.strictObject({ accountId: identifier });
const routes: readonly Route[] = [
  { method: "GET", path: "/catalog", operationId: "billingCatalog", response: catalog, statuses: [200] },
  { method: "GET", path: "/accounts", operationId: "billingAccounts", response: z.array(account).max(100), statuses: [200] },
  { method: "POST", path: "/accounts", operationId: "billingCreateAccount", body: z.strictObject({ displayName: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u) }), response: account, statuses: [201] },
  { method: "GET", path: "/accounts/:accountId", operationId: "billingAccount", params: accountParams, response: account, statuses: [200] },
  { method: "GET", path: "/accounts/:accountId/operations", operationId: "billingAccountOperations", params: accountParams, response: z.array(operation).max(50), statuses: [200] },
  { method: "POST", path: "/accounts/:accountId/customer", operationId: "billingPrepareCustomer", params: accountParams, body: empty, response: operation, statuses: [202] },
  { method: "PATCH", path: "/accounts/:accountId/members", operationId: "billingUpdateMember", params: accountParams,
    body: z.strictObject({ expectedRevision: z.number().int().min(1), subject: identifier, role: z.enum(["owner", "payer", "viewer"]), status: z.enum(["active", "revoked"]) }),
    response: z.strictObject({ revision: z.number().int().min(1) }), statuses: [200] },
  { method: "POST", path: "/accounts/:accountId/intents", operationId: "billingCreateIntent", params: accountParams, idempotent: true,
    body: z.strictObject({ kind: z.enum(["checkout", "invoice"]), items: z.array(item).max(8) }), response: intent, statuses: [200, 201] },
  { method: "POST", path: "/accounts/:accountId/intents/:intentId/submit", operationId: "billingSubmitIntent",
    params: z.strictObject({ accountId: identifier, intentId: identifier }), body: empty, idempotent: true, response: operation, statuses: [202] },
  { method: "POST", path: "/accounts/:accountId/invoices/finalize", operationId: "billingFinalizeInvoice", params: accountParams,
    body: z.strictObject({ draftOperationId: identifier }), idempotent: true, response: operation, statuses: [202] },
  { method: "POST", path: "/accounts/:accountId/portal", operationId: "billingPortalSession", params: accountParams, body: empty, idempotent: true,
    response: z.union([z.strictObject({ redirectUrl: hostedUrl }), operation]), statuses: [200, 202] },
  { method: "GET", path: "/operations/:operationId", operationId: "billingOperation", params: z.strictObject({ operationId: identifier }), response: operation, statuses: [200] },
];
const publicCodes = new Set(["SALES_PAUSED", "CUSTOMER_PENDING", "DRAFT_NOT_READY", "OFFER_UNAVAILABLE", "INVALID_QUANTITY",
  "MIXED_CURRENCY", "PORTAL_NOT_CONFIGURED", "BILLING_IDEMPOTENCY_CONFLICT", "BILLING_REVISION_CONFLICT", "BILLING_ACCOUNT_INACTIVE",
  "BILLING_FORBIDDEN", "BILLING_NOT_FOUND", "BILLING_CONFLICT", "LAST_BILLING_OWNER"]);

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d{1,9}$/.test(length) || Number(length) > RESPONSE_LIMIT))
    throw new HttpError(502, "BILLING_RESPONSE_INVALID", "Company billing returned an invalid response.");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") || !response.body)
    throw new HttpError(502, "BILLING_RESPONSE_INVALID", "Company billing returned an invalid response.");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new HttpError(504, "BILLING_TIMEOUT", "Company billing did not respond in time.");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > RESPONSE_LIMIT) throw new HttpError(502, "BILLING_RESPONSE_INVALID", "Company billing returned an invalid response.");
      parts.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}
async function forward(config: BillingBridgeConfiguration, dependencies: BillingBridgeDependencies, route: Route,
  request: FastifyRequest, bearer: string): Promise<{ status: number; body: unknown }> {
  const params = (route.params?.parse(request.params) ?? {}) as Record<string, string>;
  const path = route.path.replace(/:([A-Za-z]+)/g, (_full, key: string) => encodeURIComponent(params[key]!));
  const target = `${config.privateOrigin}/v1${path}`;
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${bearer}` });
  if (route.idempotent) {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))
      throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Use a stable request key for this billing action.");
    headers.set("Idempotency-Key", key);
  }
  const body = route.body ? JSON.stringify(route.body.parse(request.body)) : undefined;
  if (body !== undefined) {
    if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new HttpError(413, "BILLING_REQUEST_TOO_LARGE", "The billing request is too large.");
    headers.set("Content-Type", "application/json");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await dependencies.fetch(target, { method: route.method, headers, body, redirect: "error", signal: controller.signal });
        if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== target)
          throw new HttpError(502, "BILLING_REDIRECT_REFUSED", "Company billing returned an invalid response.");
        const value = await responseJson(response, controller.signal);
        if (!route.statuses.includes(response.status)) {
          const parsed = z.strictObject({ error: z.strictObject({ code: z.string().max(100) }) }).safeParse(value);
          const code = parsed.success && publicCodes.has(parsed.data.error.code) ? parsed.data.error.code : "BILLING_REQUEST_REFUSED";
          const status = [400, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 503;
          throw new HttpError(status, code, "The billing request could not be completed.");
        }
        const parsed = route.response.safeParse(value);
        if (!parsed.success) throw new HttpError(502, "BILLING_RESPONSE_INVALID", "Company billing returned an invalid response.");
        return { status: response.status, body: parsed.data };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new HttpError(504, "BILLING_TIMEOUT", "Company billing did not respond in time.")); }, UPSTREAM_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "BILLING_UNAVAILABLE", "Company billing is temporarily unavailable.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Fixed account-only bridge. No browser token, arbitrary URL, usage ingestion or webhook proxy. */
export async function registerBillingBridge(app: FastifyInstance, options: {
  config?: BillingBridgeConfiguration | null;
  dependencies?: BillingBridgeDependencies;
} = {}): Promise<void> {
  const config = options.config === undefined ? billingBridgeConfiguration(process.env) : options.config;
  const dependencies = options.dependencies ?? await defaultDependencies();
  const api = app.withTypeProvider<ZodTypeProvider>();
  const security: Record<string, string[]>[] = [{ identityAccountCookie: [] }, { sessionCookie: [] }];
  const configured = () => {
    if (!config) throw new HttpError(503, "BILLING_UNAVAILABLE", "Company billing is not available yet.");
    return config;
  };
  const mutationOrigin = (request: FastifyRequest, selected: BillingBridgeConfiguration) => {
    if (request.method !== "GET" && (request.headers.origin !== selected.portalOrigin || request.headers["sec-fetch-site"] === "cross-site"))
      throw new HttpError(403, "ORIGIN", "Use the Onesa account page.");
  };
  api.get(`${PREFIX}/session`, { schema: {
    operationId: "billingAccountSession", tags: ["Company billing"], security,
    description: "Current verified Portal account session. No billing assertion or product role is returned.",
    querystring: empty, response: { 200: z.strictObject({ csrf: z.string().regex(/^[a-f0-9]{64}$/), displayName: z.string().min(1).max(200) }), ...errors },
  } }, async (request, reply) => {
    configured();
    reply.header("Cache-Control", "private, no-store, max-age=0").header("Pragma", "no-cache").header("Referrer-Policy", "no-referrer");
    const session = await dependencies.requireAccount(request, false);
    return dependencies.withLockedSession(session, async (current, expiresAt) => {
      checkedAccount(session, current, expiresAt, dependencies.now());
      return { csrf: session.csrf, displayName: current.display_name };
    });
  });
  for (const route of routes) {
    api.route({ method: route.method, url: `${PREFIX}${route.path}`, bodyLimit: REQUEST_LIMIT,
      schema: { operationId: route.operationId, tags: ["Company billing"], security,
        description: "Verified Portal session. Billing owns account membership and commercial authority. Mutations require same Origin and X-CSRF-Token.",
        querystring: empty, ...(route.params ? { params: route.params } : {}), ...(route.body ? { body: route.body } : {}),
        response: { ...errors, ...Object.fromEntries(route.statuses.map(status => [status, route.response])) },
      },
      handler: async (request, reply) => {
        const selected = configured(); mutationOrigin(request, selected);
        const session = await dependencies.requireAccount(request, request.method !== "GET");
        const result = await dependencies.withLockedSession(session, async (current, expiresAt) => {
          const now = dependencies.now(); checkedAccount(session, current, expiresAt, now);
          return forward(selected, dependencies, route, request, assertion(selected, current, expiresAt, now));
        });
        return (reply as FastifyReply).header("Cache-Control", "private, no-store, max-age=0").header("Pragma", "no-cache")
          .header("Referrer-Policy", "no-referrer").code(result.status).send(result.body);
      },
    });
  }
}
