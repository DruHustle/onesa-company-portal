import "./local-environment.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL) throw Error("Isolated local test database required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/services/db.js");
const { migrate } = await import("../src/services/migrate.js");
const { buildApp } = await import("../src/app.js");
const { totp } = await import("../src/auth/crypto.js");
after(async () => { await db.end(); });
test("Bootstrap requires verified UI MFA enrollment, prints no factor, and cannot replace an existing account", async () => {
  await migrate();
  await db.query("TRUNCATE users,audit,rate_limits CASCADE");
  const email = "bootstrap-owner@example.invalid", password = "SyntheticBootstrapPassword-20261024";
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "src/auth/bootstrap.ts"], {
    cwd: process.cwd(), env: { ...process.env, BOOTSTRAP_EMAIL: email, BOOTSTRAP_PASSWORD: password }, encoding: "utf8", timeout: 20000,
  });
  const created = run(); assert.equal(created.status, 0);
  assert.match(created.stdout, /\/access\/setup-authenticator before signing in/);
  assert.doesNotMatch(created.stdout + created.stderr, /otpauth:|TOTP secret|secret=|SyntheticBootstrapPassword/);
  const row = (await db.query("SELECT id,email,role,password_hash,mfa_secret,mfa_pending FROM users")).rows[0];
  assert.equal(row.email, email); assert.equal(row.role, "owner"); assert.equal(row.mfa_secret, null); assert.equal(row.mfa_pending, null);
  const occupied = run(); assert.notEqual(occupied.status, 0);
  assert.match(occupied.stderr, /Bootstrap is only available for an empty user table/);
  assert.deepEqual((await db.query("SELECT id,email,role,password_hash,mfa_secret,mfa_pending FROM users")).rows, [row]);
  const app = await buildApp({ logging: false }); await app.ready();
  try {
    const initial = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    assert.equal(initial.statusCode, 403); assert.equal(initial.json().error.code, "MFA_ENROLLMENT_REQUIRED"); assert.equal(initial.cookies.length, 0);
    const setup = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", payload: { email, password } });
    assert.equal(setup.statusCode, 200);
    assert.equal((await db.query("SELECT mfa_secret IS NULL AS inactive FROM users WHERE id=$1", [row.id])).rows[0].inactive, true);
    const verified = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", payload: { challenge: setup.json().challenge, code: totp(setup.json().secret) } });
    assert.equal(verified.statusCode, 200); assert.equal(verified.cookies.length, 0);
    assert.equal((await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [row.id])).rowCount, 0);
    const signedIn = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password, code: verified.json().recoveryCodes[0] } });
    assert.equal(signedIn.statusCode, 200); assert.equal(signedIn.json().user.role, "owner");
  } finally { await app.close(); }
});
