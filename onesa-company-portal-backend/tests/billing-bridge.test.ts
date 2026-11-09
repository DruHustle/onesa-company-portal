import "./local-environment.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AccountSession } from "../src/identity/accounts.js";
import type { BillingBridgeDependencies } from "../src/billing/bridge.js";

process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/bridge_test";
process.env.SESSION_KEY = "billing-bridge-fixture-key-not-production-123456789";
process.env.NODE_ENV = "test";
const { billingBridgeConfiguration, registerBillingBridge } = await import("../src/billing/bridge.js");
const { HttpError } = await import("../src/services/workflows.js");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const NOW = new Date("2026-11-08T12:00:00.000Z");
const USER = "6e539c46-7afd-46c5-9dca-5fb202b69763";
const ACCOUNT = "b31011e5-a1dc-46db-8c5d-7dcaee65ab83";
const INTENT = "09d74491-84de-4599-b3bd-5bc755d821c8";
const OPERATION = "40f9be34-8403-4cee-9f8a-5b6966db0531";
const PREFIX = "/api/v1/account/billing";
const environment = (changes: NodeJS.ProcessEnv = {}) => ({
  BILLING_BRIDGE_ENABLED: "true", BILLING_PRIVATE_ORIGIN: "http://onesa-billing:8380",
  PUBLIC_ORIGIN: "https://portal.onesa.eu", BILLING_ASSERTION_ISSUER: "https://portal.onesa.eu/billing",
  BILLING_ASSERTION_KID: "synthetic-billing-1", BILLING_ASSERTION_PRIVATE_KEY_B64: Buffer.from(pem).toString("base64"), ...changes,
});
const session: AccountSession = {
  account: { id: USER, email: "private-fixture@example.invalid", role: "owner", display_name: "Synthetic member",
    email_verified_at: new Date("2026-11-01T12:00:00.000Z"), mfa_enrolled: true },
  csrf: "a".repeat(64), authenticatedAt: NOW.getTime() / 1000 - 300,
  amr: ["otp"], source: "portal", sourceHash: "b".repeat(64),
};
const account = { id: ACCOUNT, displayName: "Synthetic company", status: "active", revision: 1, role: "owner" };
const operation = { id: OPERATION, accountId: ACCOUNT, commercialIntentId: INTENT, kind: "checkout_create",
  state: "prepared", providerState: null, reviewRequired: false };
const catalog = { mode: "test", salesEnabled: false, items: [{ sku: "consulting", title: "Consulting", version: "v1",
  currency: "eur", unitAmount: 100, taxBehavior: "exclusive", maxQuantity: 10 }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function harness(options: {
  disabled?: boolean;
  current?: AccountSession["account"];
  expiresAt?: Date;
  revoked?: boolean;
  fetch?: typeof fetch;
} = {}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  const requests: { url: string; init: RequestInit }[] = [];
  const admissions: boolean[] = [], order: string[] = [];
  const dependencies: BillingBridgeDependencies = {
    now: () => NOW,
    async requireAccount(request, mutation) {
      admissions.push(mutation);
      if (request.cookies.onesa_session !== "synthetic-session") throw new HttpError(401, "ACCOUNT_REQUIRED", "Sign in.");
      if (mutation && request.headers["x-csrf-token"] !== session.csrf) throw new HttpError(403, "CSRF", "Refresh account.");
      return session;
    },
    async withLockedSession(_session, action) {
      order.push("locked");
      if (options.revoked) throw new HttpError(401, "ACCOUNT_REQUIRED", "Session ended.");
      try { return await action(options.current ?? session.account, options.expiresAt ?? new Date(NOW.getTime() + 3600_000)); }
      finally { order.push("unlocked"); }
    },
    async fetch(url, init = {}) {
      order.push("request"); requests.push({ url: String(url), init });
      return options.fetch ? options.fetch(url, init) : json(catalog);
    },
  };
  app.setErrorHandler((error, _request, reply) => {
    const value = error as Error & { validation?: unknown };
    reply.code(error instanceof HttpError ? error.status : value.validation ? 400 : 500).send({ error: {
      code: error instanceof HttpError ? error.code : "VALIDATION", message: error instanceof HttpError ? error.message : "Invalid request", requestId: "synthetic-request",
    } });
  });
  await registerBillingBridge(app, { config: options.disabled ? null : billingBridgeConfiguration(environment()), dependencies });
  await app.ready();
  const headers = { cookie: "onesa_session=synthetic-session; private-other-cookie=never-forward",
    origin: "https://portal.onesa.eu", "x-csrf-token": session.csrf, authorization: "Bearer caller-must-never-forward",
    "idempotency-key": "stable-synthetic-request-1" };
  return { app, headers, requests, admissions, order };
}

test("bridge defaults off and validates exact private origin, issuer, dedicated Ed25519 key and unambiguous secret input", () => {
  assert.equal(billingBridgeConfiguration({}), null);
  assert.equal(billingBridgeConfiguration({ BILLING_BRIDGE_ENABLED: "false", BILLING_ASSERTION_PRIVATE_KEY_B64: "not-read" }), null);
  for (const changes of [
    { BILLING_BRIDGE_ENABLED: "TRUE" }, { BILLING_PRIVATE_ORIGIN: "https://attacker.example.invalid" },
    { BILLING_PRIVATE_ORIGIN: "http://169.254.169.254" }, { BILLING_PRIVATE_ORIGIN: "http://onesa-billing:8380/v1" },
    { BILLING_PRIVATE_ORIGIN: "http://user:password@10.1.2.3" }, { BILLING_PRIVATE_ORIGIN: "http://10.1.2.3?next=private" },
    { BILLING_ASSERTION_ISSUER: "https://other.onesa.eu/billing" }, { BILLING_ASSERTION_KID: "unsafe\nheader" },
    { BILLING_ASSERTION_PRIVATE_KEY_B64: "SYNTHETIC_PRIVATE_INVALID_KEY" }, { BILLING_ASSERTION_PRIVATE_KEY_FILE: "/not-read-with-ambiguous-b64" },
  ]) assert.throws(() => billingBridgeConfiguration(environment(changes)), (error: unknown) => {
    assert.ok(error instanceof HttpError); assert.equal(error.code, "BILLING_BRIDGE_CONFIGURATION");
    assert.ok(!error.message.includes("PRIVATE")); return true;
  });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => billingBridgeConfiguration(environment({ BILLING_ASSERTION_PRIVATE_KEY_B64: Buffer.from(rsa).toString("base64") })), /Company billing is unavailable/u);
  for (const origin of ["http://127.0.0.1:8380", "http://10.1.2.3:8380", "http://172.31.2.3:8380", "https://192.168.1.2", "http://[fd12::3]:8380"])
    assert.equal(billingBridgeConfiguration(environment({ BILLING_PRIVATE_ORIGIN: origin }))?.privateOrigin, origin);
});

test("preferred secret file is bounded, private, regular and cannot use a final symlink or broad permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "onesa-billing-key-"));
  try {
    const path = join(directory, "key.pem"); writeFileSync(path, pem, { mode: 0o600 });
    const selected = environment({ BILLING_ASSERTION_PRIVATE_KEY_B64: undefined, BILLING_ASSERTION_PRIVATE_KEY_FILE: path });
    assert.equal(billingBridgeConfiguration(selected)?.privateKey.asymmetricKeyType, "ed25519");
    chmodSync(path, 0o644); assert.throws(() => billingBridgeConfiguration(selected)); chmodSync(path, 0o600);
    const alias = join(directory, "alias.pem"); symlinkSync(path, alias);
    assert.throws(() => billingBridgeConfiguration({ ...selected, BILLING_ASSERTION_PRIVATE_KEY_FILE: alias }));
    writeFileSync(path, "x".repeat(16_385)); assert.throws(() => billingBridgeConfiguration(selected));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("disabled bridge and unknown provider paths cannot mint assertions or contact the service", async () => {
  const f = await harness({ disabled: true });
  try {
    const disabled = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers });
    assert.equal(disabled.statusCode, 503); assert.equal(f.admissions.length, 0);
    for (const path of ["/v1/catalog", "/usage", "/webhooks/stripe", "/health", "/accounts/../webhooks/stripe"])
      assert.equal((await f.app.inject({ url: PREFIX + path, headers: f.headers })).statusCode, 404);
    assert.equal(f.requests.length, 0);
  } finally { await f.app.close(); }
});

test("local bootstrap reuses native MFA session and returns only current display name and CSRF", async () => {
  const f = await harness();
  try {
    const response = await f.app.inject({ url: `${PREFIX}/session`, headers: f.headers });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { csrf: session.csrf, displayName: "Synthetic member" });
    assert.deepEqual(f.admissions, [false]); assert.deepEqual(f.order, ["locked", "unlocked"]); assert.equal(f.requests.length, 0);
    assert.ok(!response.body.includes(session.account.email)); assert.ok(!response.body.includes("owner")); assert.ok(!response.body.includes("eyJ"));
  } finally { await f.app.close(); }
});

test("account/session and email are rechecked under lock before any assertion is sent", async () => {
  for (const options of [{ revoked: true }, { current: { ...session.account, email_verified_at: null } },
    { current: { ...session.account, id: ACCOUNT } }, { expiresAt: new Date(NOW.getTime() - 1) }]) {
    const f = await harness(options);
    try {
      const response = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers });
      assert.ok([401, 403].includes(response.statusCode)); assert.equal(f.requests.length, 0);
    } finally { await f.app.close(); }
  }
  const anonymous = await harness();
  try { assert.equal((await anonymous.app.inject({ url: `${PREFIX}/catalog` })).statusCode, 401); assert.equal(anonymous.requests.length, 0); }
  finally { await anonymous.app.close(); }
});

test("signed assertion is account-only, short-lived, session-capped and never returned to browser", async () => {
  const f = await harness({ expiresAt: new Date(NOW.getTime() + 35_000) });
  try {
    const response = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), catalog);
    assert.deepEqual(f.order, ["locked", "request", "unlocked"]);
    const request = f.requests[0]!; assert.equal(request.url, "http://onesa-billing:8380/v1/catalog");
    assert.equal(request.init.redirect, "error"); assert.equal(request.init.body, undefined);
    const headers = new Headers(request.init.headers), authorization = headers.get("authorization")!;
    assert.equal(headers.get("cookie"), null); assert.equal(headers.get("x-csrf-token"), null); assert.equal(headers.get("origin"), null);
    assert.notEqual(authorization, f.headers.authorization);
    const [header, claims, signature] = authorization.slice(7).split(".");
    assert.equal(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url")), true);
    assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "EdDSA", typ: "JWT", kid: "synthetic-billing-1" });
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
    assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss", "jti", "scope", "sub"]);
    assert.equal(payload.sub, USER); assert.equal(payload.scope, "billing:account"); assert.equal(payload.aud, "onesa-billing");
    assert.equal(payload.exp - payload.iat, 35); assert.equal(payload.iss, "https://portal.onesa.eu/billing");
    assert.equal(response.headers["set-cookie"], undefined); assert.match(String(response.headers["cache-control"]), /no-store/u);
    assert.ok(!response.body.includes(authorization)); assert.ok(!response.body.includes(pem));
  } finally { await f.app.close(); }
});

test("all mutations require same Portal Origin, CSRF and stable key only on declared routes", async () => {
  const f = await harness({ fetch: async () => json({ id: INTENT, kind: "checkout", accountId: ACCOUNT,
    items: [{ sku: "consulting", quantity: 1 }], createdAt: NOW.toISOString() }, 201) });
  const url = `${PREFIX}/accounts/${ACCOUNT}/intents`, payload = { kind: "checkout", items: [{ sku: "consulting", quantity: 1 }] };
  try {
    for (const headers of [{ ...f.headers, origin: "https://www.onesa.eu" }, { ...f.headers, origin: "" },
      { ...f.headers, "sec-fetch-site": "cross-site" }, { ...f.headers, "x-csrf-token": "wrong" }])
      assert.equal((await f.app.inject({ method: "POST", url, headers, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url, headers: { ...f.headers, "idempotency-key": "short" }, payload })).statusCode, 400);
    assert.equal(f.requests.length, 0);
    const success = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    assert.equal(success.statusCode, 201); assert.equal(f.requests[0]?.url, `http://onesa-billing:8380/v1/accounts/${ACCOUNT}/intents`);
    assert.deepEqual(JSON.parse(String(f.requests[0]?.init.body)), payload);
    assert.equal(new Headers(f.requests[0]?.init.headers).get("idempotency-key"), f.headers["idempotency-key"]);
    assert.ok(f.admissions.every(value => value));
  } finally { await f.app.close(); }
});

test("closed route bodies, UUIDs and empty query contract reject customer/price/role/URL injection", async () => {
  const f = await harness();
  try {
    const url = `${PREFIX}/accounts/${ACCOUNT}/intents`;
    for (const payload of [
      { kind: "portal", items: [] },
      { kind: "checkout", items: [{ sku: "consulting", quantity: 1 }], customerId: "cus_injected" },
      { kind: "checkout", items: [{ sku: "consulting", quantity: 1, priceId: "price_injected" }] },
      { kind: "checkout", items: [{ sku: "consulting", quantity: 1 }], role: "owner" },
      { kind: "checkout", items: [{ sku: "consulting", quantity: 1 }], returnUrl: "https://attacker.invalid" },
    ]) assert.equal((await f.app.inject({ method: "POST", url, payload, headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: `${PREFIX}/catalog?url=https://attacker.invalid`, headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: `${PREFIX}/accounts/not-a-uuid`, headers: f.headers })).statusCode, 400);
    assert.equal(f.requests.length, 0);
  } finally { await f.app.close(); }
});

test("fixed account/history/customer/finalization/portal paths match exact private contracts", async () => {
  const cases = [
    { method: "GET" as const, path: "/accounts", response: [account], status: 200 },
    { method: "POST" as const, path: "/accounts", body: { displayName: account.displayName }, response: account, status: 201 },
    { method: "GET" as const, path: `/accounts/${ACCOUNT}`, response: account, status: 200 },
    { method: "GET" as const, path: `/accounts/${ACCOUNT}/operations`, response: [operation], status: 200 },
    { method: "POST" as const, path: `/accounts/${ACCOUNT}/customer`, body: {}, response: operation, status: 202 },
    { method: "POST" as const, path: `/accounts/${ACCOUNT}/intents/${INTENT}/submit`, body: {}, response: operation, status: 202 },
    { method: "POST" as const, path: `/accounts/${ACCOUNT}/invoices/finalize`, body: { draftOperationId: OPERATION }, response: operation, status: 202 },
    { method: "POST" as const, path: `/accounts/${ACCOUNT}/portal`, body: {}, response: { redirectUrl: "https://billing.stripe.com/p/session/synthetic" }, status: 200 },
    { method: "GET" as const, path: `/operations/${OPERATION}`, response: operation, status: 200 },
    { method: "PATCH" as const, path: `/accounts/${ACCOUNT}/members`, body: { expectedRevision: 1, subject: USER, role: "viewer", status: "active" }, response: { revision: 2 }, status: 200 },
  ];
  for (const entry of cases) {
    const f = await harness({ fetch: async () => json(entry.response, entry.status) });
    try {
      const response = await f.app.inject({ method: entry.method, url: PREFIX + entry.path, headers: f.headers, payload: entry.body });
      assert.equal(response.statusCode, entry.status); assert.deepEqual(response.json(), entry.response);
      assert.equal(f.requests.length, 1); assert.equal(f.requests[0]?.url, `http://onesa-billing:8380/v1${entry.path}`);
    } finally { await f.app.close(); }
  }
});

test("provider redirects, unexpected fields, oversized bodies and raw errors cannot expose private values", async () => {
  const responses = [
    () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/private" } }),
    () => json({ ...catalog, assertion: "PRIVATE_ASSERTION" }),
    () => json({ ...catalog, items: [{ ...catalog.items[0], priceId: "PRIVATE_PRICE_ID" }] }),
    () => new Response("PRIVATE_BODY", { status: 200, headers: { "content-type": "text/plain" } }),
    () => new Response("x".repeat(65_537), { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response("PRIVATE_BODY", { status: 200, headers: { "content-type": "application/json", "content-length": "999999" } }),
    () => json({ error: { code: "PRIVATE_RAW_ERROR", secret: "PRIVATE_KEY" } }, 500),
  ];
  for (const respond of responses) {
    const f = await harness({ fetch: async () => respond() });
    try {
      const response = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers });
      assert.ok(response.statusCode >= 500); assert.ok(!response.body.includes("PRIVATE")); assert.equal(response.headers.location, undefined);
    } finally { await f.app.close(); }
  }
  const f = await harness({ fetch: async () => { throw new Error(`PRIVATE_ERROR ${pem}`); } });
  try { const response = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers }); assert.equal(response.statusCode, 503); assert.ok(!response.body.includes("PRIVATE")); }
  finally { await f.app.close(); }
});

test("hosted redirect result is exact Stripe HTTPS and upstream cookies are never copied", async () => {
  for (const url of ["https://billing.stripe.com.attacker.invalid/", "http://billing.stripe.com/", "https://user:password@billing.stripe.com/", "https://billing.stripe.com:8443/"] ) {
    const f = await harness({ fetch: async () => json({ redirectUrl: url }) });
    try { assert.equal((await f.app.inject({ method: "POST", url: `${PREFIX}/accounts/${ACCOUNT}/portal`, payload: {}, headers: f.headers })).statusCode, 502); }
    finally { await f.app.close(); }
  }
  const f = await harness({ fetch: async () => new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json", "set-cookie": "PRIVATE_COOKIE=never-forward" } }) });
  try { const response = await f.app.inject({ url: `${PREFIX}/catalog`, headers: f.headers }); assert.equal(response.statusCode, 200); assert.equal(response.headers["set-cookie"], undefined); }
  finally { await f.app.close(); }
});

test("one bounded deadline covers headers and streamed body without retrying a possible mutation", async context => {
  for (const stream of [false, true]) {
    let sent!: () => void; const started = new Promise<void>(resolve => { sent = resolve; });
    let signal: AbortSignal | null | undefined;
    const f = await harness({ fetch: async (_url, init) => {
      signal = init?.signal; sent();
      return stream ? new Response(new ReadableStream(), { headers: { "content-type": "application/json" } }) : new Promise<Response>(() => undefined);
    } });
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = f.app.inject({ method: "POST", url: `${PREFIX}/accounts/${ACCOUNT}/portal`, payload: {}, headers: f.headers });
      await started; context.mock.timers.tick(8_000);
      const response = await pending; assert.equal(response.statusCode, 504); assert.equal(signal?.aborted, true); assert.equal(f.requests.length, 1);
    } finally { context.mock.timers.reset(); await f.app.close(); }
  }
});
