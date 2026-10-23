import "./local-environment.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import cookie, { Signer } from "@fastify/cookie";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://synthetic@127.0.0.1:1/session_cookie_test";
process.env.SESSION_KEY = randomBytes(32).toString("hex");
const { env } = await import("../src/config/env.js");
const { hash } = await import("../src/auth/crypto.js");
const { mfaSessionCookie, mfaSessionLifetime, signSessionAuthentication, sessionAuthenticationTime } = await import("../src/auth/session-proof.js");
const { setSessionCookie, clearSessionCookies } = await import("../src/auth/session-cookie.js");
const raw = "a".repeat(64), other = "b".repeat(64);
const request = (proof?: string, session = raw) => ({ cookies: { onesa_session: session, ...(proof ? { [mfaSessionCookie]: proof } : {}) } });

test("MFA evidence is purpose-signed, bound to the exact bearer and contains no credentials", () => {
  const at = Date.now() - 1000, proof = signSessionAuthentication(raw, at);
  assert.equal(sessionAuthenticationTime(request(proof)), at);
  assert.equal(sessionAuthenticationTime(request(proof, other)), null);
  assert.equal(proof.includes(raw), false);
  assert.equal(proof.includes(process.env.SESSION_KEY!), false);
  assert.deepEqual(JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString()), [1, hash(raw), at]);
});
test("Legacy sessions and tampered, malformed or oversized evidence cannot become fresh MFA", () => {
  const proof = signSessionAuthentication(raw, Date.now());
  for (const value of [undefined, "invalid", proof.slice(0, -2), "x".repeat(513), proof.replace(/^./, proof[0] === "a" ? "b" : "a")])
    assert.equal(sessionAuthenticationTime(request(value)), null);
  assert.equal(sessionAuthenticationTime({ cookies: { [mfaSessionCookie]: proof } }), null);
});
test("A signature from another application purpose cannot authenticate a session", () => {
  const value = Buffer.from(JSON.stringify([1, hash(raw), Date.now()])).toString("base64url");
  assert.equal(sessionAuthenticationTime(request(new Signer(env.SESSION_KEY).sign(value))), null);
  assert.equal(sessionAuthenticationTime(request(new Signer(createHmac("sha256", env.SESSION_KEY).update("other-purpose").digest()).sign(value))), null);
});
test("Even correctly signed evidence rejects unsupported shapes, future times and expired MFA", () => {
  const signer = new Signer(createHmac("sha256", env.SESSION_KEY).update("onesa:portal-mfa-session:v1").digest());
  for (const value of [null, {}, [1, hash(raw)], [2, hash(raw), Date.now()], [1, hash(raw), "now"], [1, hash(raw), Date.now()+60000], [1, hash(raw), Date.now()-mfaSessionLifetime], [1, hash(raw), 0], [1, hash(raw), Date.now(), "extra"]])
    assert.equal(sessionAuthenticationTime(request(signer.sign(Buffer.from(JSON.stringify(value)).toString("base64url")))), null);
});
test("Fresh evidence expires after eight hours instead of becoming indefinitely trusted", t => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const at = now, proof = signSessionAuthentication(raw, at);
  now += mfaSessionLifetime - 1;
  assert.equal(sessionAuthenticationTime(request(proof)), at);
  now += 1;
  assert.equal(sessionAuthenticationTime(request(proof)), null);
});
test("Cookie persistence preserves original MFA time and logout clears all related cookies", async t => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const priorEnvironment = env.NODE_ENV;
  env.NODE_ENV = "production";
  const app = Fastify();
  try {
    await app.register(cookie);
    app.get("/new", (_request, reply) => { setSessionCookie(reply, raw, true, now); return {}; });
    app.get("/renew", (req, reply) => { setSessionCookie(reply, other, true, sessionAuthenticationTime(req)); return {}; });
    app.get("/clear", (_req, reply) => { clearSessionCookies(reply); return {}; });
    const first = await app.inject({url:"/new"});
    const proof = first.cookies.find(c=>c.name===mfaSessionCookie)!;
    assert.equal(proof.httpOnly,true); assert.equal(proof.secure,true); assert.equal(proof.domain,undefined); assert.equal(proof.maxAge,28800);
    now += 3_600_000;
    const renewal = await app.inject({url:"/renew",headers:{cookie:first.cookies.map(c=>c.name+"="+c.value).join("; ")}});
    const renewedProof = renewal.cookies.find(c=>c.name===mfaSessionCookie)!;
    assert.equal(renewedProof.maxAge,25200);
    assert.equal(sessionAuthenticationTime(request(renewedProof.value,other)),now-3_600_000);
    assert.equal(sessionAuthenticationTime(request(proof.value,other)),null);
    const legacy=await app.inject({url:"/renew",headers:{cookie:"onesa_session="+raw}});
    assert.equal(legacy.cookies.find(c=>c.name===mfaSessionCookie)?.value,"");
    assert.ok(legacy.cookies.find(c=>c.name==="onesa_session")?.value,"legacy Portal renewal remains available without inventing MFA evidence");
    const cleared=await app.inject({url:"/clear"});
    for(const name of ["onesa_session","onesa_remember_browser",mfaSessionCookie])assert.equal(cleared.cookies.find(c=>c.name===name)?.value,"");
  } finally {await app.close();env.NODE_ENV=priorEnvironment;}
});
