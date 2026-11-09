import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The optional same-exec launcher supplies only a synthetic loopback admin URL.
// Copy it into the existing guarded test slot before all BILLING_ settings are cleared.
const ownedDatabase = !process.env.TEST_DATABASE_URL;
const supplied = process.env.TEST_DATABASE_URL ?? process.env.BILLING_TEST_DATABASE_URL;
if (supplied) process.env.TEST_DATABASE_URL = supplied;
await import("./local-environment.js");
test("Portal billing bridge uses real native session custody and refuses concurrent revocation", { skip: !supplied }, async context => {
  const selected = new URL(supplied!);
  assert.ok(["postgres:", "postgresql:"].includes(selected.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(selected.hostname));
  assert.ok(selected.pathname.endsWith("_test"), "only disposable loopback test databases may be used");
  const admin = new pg.Client({ connectionString: selected.toString(), connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  if (ownedDatabase) {
    await admin.connect();
    await admin.query("CREATE DATABASE onesa_portal_billing_test");
    selected.pathname = "/onesa_portal_billing_test";
  }
  const priorDirectory = process.cwd(), originalFetch = globalThis.fetch;
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  process.env.TEST_DATABASE_URL = selected.toString(); process.env.DATABASE_URL = selected.toString();
  process.env.NODE_ENV = "test"; process.env.SESSION_KEY = randomBytes(32).toString("hex");
  process.env.PUBLIC_ORIGIN = "https://portal.example.invalid"; process.env.COMPANY_ORIGIN = "";
  process.env.ONESA_IDENTITY_ENABLED = "false";
  delete process.env.ONESA_IDENTITY_CONFIG_B64;
  const pair = generateKeyPairSync("ed25519");
  process.env.BILLING_BRIDGE_ENABLED = "true"; process.env.BILLING_PRIVATE_ORIGIN = "http://onesa-billing:8380";
  process.env.BILLING_ASSERTION_ISSUER = "https://portal.example.invalid/billing"; process.env.BILLING_ASSERTION_KID = "fixture-integration";
  delete process.env.BILLING_ASSERTION_PRIVATE_KEY_FILE;
  process.env.BILLING_ASSERTION_PRIVATE_KEY_B64 = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64");
  const userId = randomUUID(), billingAccount = randomUUID(), operationId = randomUUID();
  const rawSession = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body });
    const body = init?.method === "POST" ? {
      id: operationId, accountId: billingAccount, commercialIntentId: billingAccount, kind: "customer_create",
      state: "prepared", providerState: null, reviewRequired: false,
    } : { mode: "test", salesEnabled: false, items: [] };
    return new Response(JSON.stringify(body), { status: init?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
  };
  const { db } = await import("../src/services/db.js");
  const { migrate } = await import("../src/services/migrate.js");
  const { hash, encrypt, passwordHash } = await import("../src/auth/crypto.js");
  const { signSessionAuthentication } = await import("../src/auth/session-proof.js");
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp({ logging: false });
  const headers = { cookie: `onesa_session=${rawSession}; onesa_mfa_session=${encodeURIComponent(signSessionAuthentication(rawSession, Date.now()))}`,
    origin: process.env.PUBLIC_ORIGIN, "x-csrf-token": csrf };
  const prefix = "/api/v1/account/billing";
  try {
    await migrate(); await app.ready();
    await db.query("INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,'owner',$4)",
      [userId, `bridge-${userId}@example.invalid`, passwordHash("Isolated bridge fixture password only"), encrypt("JBSWY3DPEHPK3PXP")]);
    await db.query("INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,'Isolated billing member',now())", [userId]);
    await db.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [hash(rawSession), userId, csrf]);
    await context.test("native MFA session bootstraps while shared identity stays disabled", async () => {
      assert.equal((await app.inject({ url: "/api/v1/account/me", headers })).statusCode, 503);
      const result = await app.inject({ url: `${prefix}/session`, headers });
      assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { csrf, displayName: "Isolated billing member" });
      assert.equal(requests.length, 0);
    });
    await context.test("same-Origin CSRF and current identity control the private assertion", async () => {
      const url = `${prefix}/accounts/${billingAccount}/customer`;
      assert.equal((await app.inject({ method: "POST", url, payload: {}, headers: { ...headers, origin: "https://www.onesa.eu" } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url, payload: {}, headers: { ...headers, "x-csrf-token": "wrong" } })).statusCode, 403);
      assert.equal(requests.length, 0);
      assert.equal((await app.inject({ method: "POST", url, payload: {}, headers })).statusCode, 202);
      const request = requests.at(-1)!; assert.equal(request.headers.get("cookie"), null); assert.equal(request.headers.get("x-csrf-token"), null);
      const [head, claims, signature] = request.headers.get("authorization")!.slice(7).split(".");
      assert.equal(verify(null, Buffer.from(`${head}.${claims}`), pair.publicKey, Buffer.from(signature!, "base64url")), true);
      const parsed = JSON.parse(Buffer.from(claims!, "base64url").toString());
      assert.equal(parsed.sub, userId); assert.equal(parsed.scope, "billing:account"); assert.equal(parsed.aud, "onesa-billing");
      assert.equal(parsed.exp - parsed.iat, 60); assert.equal(parsed.role, undefined); assert.equal(parsed.email, undefined);
    });
    await context.test("unverified and disabled real users cannot forward requests", async () => {
      const count = requests.length;
      await db.query("UPDATE identity_profiles SET email_verified_at=NULL WHERE user_id=$1", [userId]);
      assert.equal((await app.inject({ url: `${prefix}/catalog`, headers })).statusCode, 403);
      await db.query("UPDATE identity_profiles SET email_verified_at=now() WHERE user_id=$1", [userId]);
      await db.query("UPDATE users SET disabled=true WHERE id=$1", [userId]);
      assert.equal((await app.inject({ url: `${prefix}/catalog`, headers })).statusCode, 401);
      assert.equal(requests.length, count);
      await db.query("UPDATE users SET disabled=false WHERE id=$1", [userId]);
      await db.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at", [hash(rawSession), userId, csrf]);
    });
    await context.test("a request admitted before logout is refused after its account lock is released", async () => {
      const held = await db.connect(), count = requests.length;
      let released = false;
      try {
        await held.query("BEGIN"); await held.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [userId]);
        const pending = app.inject({ url: `${prefix}/catalog`, headers }).then(result => result);
        let waiting = false;
        // Autocommit observer avoids reusing a pg_stat_activity snapshot inside the held transaction.
        for (let attempt = 0; attempt < 100; attempt++) {
          const observed = await db.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE%'");
          if (observed.rows[0].count > 0) { waiting = true; break; }
          await delay(10);
        }
        assert.equal(waiting, true, "the actual bridge transaction must be waiting on the held user lock");
        await held.query("DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2", [hash(rawSession), userId]);
        await held.query("COMMIT"); released = true;
        assert.equal((await pending).statusCode, 401); assert.equal(requests.length, count);
      } finally { if (!released) await held.query("ROLLBACK"); held.release(); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (!ownedDatabase) await db.query("DELETE FROM users WHERE id=$1", [userId]);
    await db.end();
    if (ownedDatabase) { await admin.query("DROP DATABASE onesa_portal_billing_test"); await admin.end(); }
    process.chdir(priorDirectory);
  }
});
