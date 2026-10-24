import "./local-environment.js";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
if (!process.env.TEST_DATABASE_URL)
  throw Error("Isolated local test database required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_KEY = randomBytes(32).toString("hex");
process.env.PUBLIC_ORIGIN = "https://portal.example.invalid";
const ownerId = randomUUID(),
  ownerPassword = randomBytes(32).toString("hex");
process.env.ACCESS_REGISTRATION_ENABLED = "true";
process.env.ACCESS_APPROVAL_OWNER_ID = ownerId;
process.env.ACCESS_PREAPPROVED_EMAILS = JSON.stringify([
  "approved@onesa.eu",
  "retained@example.invalid",
]);
process.env.ACCESS_POLICY_EVIDENCE =
  "Synthetic owner decision and exact-email Docs policy fixture";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.ENGINEERING_IDENTITY_ENABLED = "true";
process.env.ENGINEERING_OIDC_CONFIG_B64 = Buffer.from(
  JSON.stringify({
    issuer: process.env.PUBLIC_ORIGIN + "/api/v1/engineering-identity",
    clientId: "synthetic_registration_client",
    clientSecret: randomBytes(48).toString("hex"),
    cookieKeys: [randomBytes(48).toString("hex")],
    externalEmails: ["retained@example.invalid"],
    jwks: {
      keys: [
        {
          ...keys.privateKey.export({ format: "jwk" }),
          kid: "registration_key",
          alg: "RS256",
          use: "sig",
        },
      ],
    },
    redirectUri:
      "https://synthetic.cloudflareaccess.com/cdn-cgi/access/callback",
  }),
).toString("base64");
const { db } = await import("../src/services/db.js"),
  { migrate } = await import("../src/services/migrate.js"),
  { buildApp } = await import("../src/app.js");
const { decrypt, encrypt, hash, passwordHash, passwordValid } =
  await import("../src/auth/crypto.js");
const {
  accessConfiguration,
  requestEngineeringLink,
  consumeEngineeringLink,
  engineeringPasswordAccount,
  requestAdminLink,
  consumeAdminLink,
} = await import("../src/auth/access.js");
const app = await buildApp({ logging: false }),
  origin = { origin: process.env.PUBLIC_ORIGIN };
let ownerHeaders: Record<string, string>;
before(async () => {
  await migrate();
  await db.query(
    "TRUNCATE users,audit,rate_limits,jobs,access_links,access_registrations,engineering_credentials CASCADE",
  );
  await db.query(
    "INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,'owner@onesa.eu',$2,'owner',$3)",
    [ownerId, passwordHash(ownerPassword), encrypt("JBSWY3DPEHPK3PXP")],
  );
  const session = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hash(session), ownerId, csrf],
  );
  ownerHeaders = {
    ...origin,
    cookie: "onesa_session=" + session,
    "x-csrf-token": csrf,
  };
  await app.ready();
});
// Each test starts outside the 30-second delivery window. Within a test,
// repeated/concurrent requests retain the real cooldown and are asserted below.
beforeEach(async () => { await db.query("DELETE FROM rate_limits WHERE key LIKE 'access-link-cooldown:%'"); });
after(async () => {
  await app.close();
  await db.end();
});
async function register(email: string, audience = "admin", remoteAddress = "127.0.0.1") {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/access/register",
    remoteAddress,
    headers: origin,
    payload: { email, audience, name: "Synthetic applicant" },
  });
  assert.equal(r.statusCode, 202, r.body);
}
async function mailToken(
  email: string,
  subject = "Complete your Onesa registration",
) {
  const jobs = (
    await db.query(
      "SELECT payload FROM jobs WHERE payload->>'to'=$1 AND payload->>'subject'=$2 ORDER BY created_at DESC",
      [email, subject],
    )
  ).rows;
  assert.ok(jobs.length);
  const p = jobs[0].payload;
  assert.equal(p.text, undefined);
  assert.ok(!JSON.stringify(p).includes("#access-link="));
  const raw = decrypt(p.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )?.[1];
  assert.ok(raw);
  const stored = (
    await db.query("SELECT token_hash FROM access_links WHERE token_hash=$1", [
      hash(raw),
    ])
  ).rows[0];
  assert.ok(stored);
  assert.notEqual(stored.token_hash, raw);
  return raw;
}
const chosenPassword = "Synthetic password long enough " + randomUUID();
async function confirm(raw: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/access/confirm",
    headers: origin,
    payload: { token: raw, password: chosenPassword },
  });
}
async function proof() {
  const code = randomUUID();
  await db.query("INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)", [
    ownerId,
    hash(code),
  ]);
  return { password: ownerPassword, code };
}
let pendingId: string;
test("Disabled or malformed enrollment configuration fails closed; wildcard approvals are rejected", () => {
  assert.equal(accessConfiguration({}), null);
  for (const changes of [
    { ACCESS_APPROVAL_OWNER_ID: "bad" },
    { ACCESS_PREAPPROVED_EMAILS: '["*@onesa.eu"]' },
    { ACCESS_PREAPPROVED_EMAILS: "invalid" },
  ])
    assert.throws(
      () => accessConfiguration({ ...process.env, ...changes }),
      /configuration rejected/,
    );
});
test("New registration verifies the email before requesting approval and creates no account or privilege", async () => {
  const email = "pending@onesa.eu";
  await register(email);
  const row = (
    await db.query("SELECT * FROM access_registrations WHERE email=$1", [email])
  ).rows[0];
  pendingId = row.id;
  assert.equal(row.state, "unverified");
  assert.equal(row.password_hash, null);
  const raw = await mailToken(email);
  assert.equal(
    (await app.inject({ url: "/api/v1/access/confirm?token=" + raw }))
      .statusCode,
    404,
  );
  const confirmed = await confirm(raw);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, "pending");
  assert.equal(
    (await db.query("SELECT id FROM users WHERE email=$1", [email])).rowCount,
    0,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM engineering_memberships WHERE email=$1", [
        email,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM jobs WHERE dedupe_key=$1 AND payload->>'to'='owner@onesa.eu'",
        ["access-approval:" + row.id],
      )
    ).rowCount,
    1,
  );
  assert.equal((await confirm(raw)).statusCode, 401);
  const pending = (
    await db.query(
      "SELECT state,password_hash,email_verified_at FROM access_registrations WHERE id=$1",
      [row.id],
    )
  ).rows[0];
  assert.equal(pending.state, "pending");
  assert.ok(pending.email_verified_at);
  assert.ok(passwordValid(chosenPassword, pending.password_hash));
});
test("Already-approved address completes registration without another decision, but gets no owner role or MFA bypass", async () => {
  await register("approved@onesa.eu");
  const r = await confirm(await mailToken("approved@onesa.eu"));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "approved");
  const u = (
    await db.query("SELECT * FROM users WHERE email='approved@onesa.eu'")
  ).rows[0];
  assert.equal(u.role, "administrator");
  assert.ok(passwordValid(chosenPassword, u.password_hash));
  await requestAdminLink(u.email);
  await assert.rejects(
    consumeAdminLink(
      await mailToken(u.email, "Your Onesa sign-in link"),
      "123456",
    ),
    /Enroll your administrator authenticator/,
  );
});
test("Registration cannot overwrite an existing password, MFA, role or disabled account", async () => {
  const before = (await db.query("SELECT * FROM users WHERE id=$1", [ownerId]))
    .rows[0];
  await register("owner@onesa.eu");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM access_registrations WHERE email='owner@onesa.eu'",
      )
    ).rowCount,
    0,
  );
  assert.deepEqual(
    (await db.query("SELECT * FROM users WHERE id=$1", [ownerId])).rows[0],
    before,
  );
});
test("Owner approval is versioned, scoped, step-up protected and cannot create an owner", async () => {
  const url = "/api/v1/admin/access/requests/" + pendingId + "/review";
  const body = {
    decision: "approve",
    expectedRevision: 2,
    evidence:
      "Synthetic reviewed admin registration; minimum editor permission",
    role: "editor",
    ...(await proof()),
  };
  assert.equal(
    (await app.inject({ method: "POST", url, payload: body, headers: origin }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { ...body, role: "owner" },
        headers: ownerHeaders,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { ...body, expectedRevision: 1 },
        headers: ownerHeaders,
      })
    ).statusCode,
    409,
  );
  const r = await app.inject({
    method: "POST",
    url,
    payload: body,
    headers: ownerHeaders,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (await db.query("SELECT role FROM users WHERE email='pending@onesa.eu'"))
      .rows[0].role,
    "editor",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { ...body, ...(await proof()) },
        headers: ownerHeaders,
      })
    ).statusCode,
    409,
  );
  const audit = await db.query(
    "SELECT id FROM audit WHERE action='access.registration_approved' AND record_id=$1",
    [pendingId],
  );
  assert.equal(audit.rowCount, 1);
  const decision = (await db.query("SELECT payload FROM jobs WHERE dedupe_key=$1", ["access-decision:" + pendingId])).rows[0].payload;
  assert.match(decrypt(decision.encryptedText), /\/access\/setup-authenticator$/);
});
test("Engineering approval mail links to Docs without administrator MFA setup", async () => {
  const email = "new-engineering-approval@onesa.eu";
  await register(email, "engineering", "2001:db8:5e7::1");
  assert.equal((await confirm(await mailToken(email))).json().status, "pending");
  const request = (await db.query("SELECT id,revision FROM access_registrations WHERE email=$1 AND audience='engineering'", [email])).rows[0];
  const result = await app.inject({method: "POST", url: "/api/v1/admin/access/requests/" + request.id + "/review", headers: ownerHeaders, payload: {decision: "approve", expectedRevision: request.revision, evidence: "Synthetic scoped engineering approval only", role: "viewer", ...await proof()}});
  assert.equal(result.statusCode, 200, result.body);
  const decision = (await db.query("SELECT payload FROM jobs WHERE dedupe_key=$1", ["access-decision:" + request.id])).rows[0].payload;
  assert.match(decrypt(decision.encryptedText), /\/engineering$/);
  assert.doesNotMatch(decrypt(decision.encryptedText), /authenticator|administrator/);
  assert.equal((await db.query("SELECT id FROM users WHERE email=$1", [email])).rowCount, 0);
});
test("Engineering registration and password/link authentication grant no Portal account and enforce one-use/interaction boundaries", async () => {
  const email = "retained@example.invalid";
  await register(email, "engineering");
  const r = await confirm(await mailToken(email));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "approved");
  const m = (
    await db.query("SELECT * FROM engineering_memberships WHERE email=$1", [
      email,
    ])
  ).rows[0];
  assert.equal(
    (await db.query("SELECT id FROM users WHERE email=$1", [email])).rowCount,
    0,
  );
  assert.equal(
    await engineeringPasswordAccount(email, chosenPassword, [email]),
    m.id,
  );
  await assert.rejects(
    engineeringPasswordAccount(email, "incorrect password", [email]),
    /Unable to sign in/,
  );
  const uid = "synthetic_" + randomUUID();
  await requestEngineeringLink(email, uid, [email]);
  const raw = await mailToken(email, "Your Onesa sign-in link");
  await assert.rejects(consumeAdminLink(raw, "123456"), /invalid or expired/);
  await assert.rejects(
    consumeEngineeringLink(raw, "other_" + randomUUID(), [email]),
    /invalid or expired/,
  );
  const results = await Promise.allSettled([
    consumeEngineeringLink(raw, uid, [email]),
    consumeEngineeringLink(raw, uid, [email]),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  await requestEngineeringLink(email, "second_" + randomUUID(), [email]);
  const second = await mailToken(email, "Your Onesa sign-in link");
  const disable = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/engineering/memberships",
    headers: ownerHeaders,
    payload: {
      email,
      enabled: false,
      evidence: "Synthetic offboarding verification",
      expectedRevision: m.revision,
      ...(await proof()),
    },
  });
  assert.equal(disable.statusCode, 200, disable.body);
  assert.equal(
    (
      await db.query(
        "SELECT token_hash FROM access_links WHERE token_hash=$1",
        [hash(second)],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    engineeringPasswordAccount(email, chosenPassword, [email]),
    /Unable to sign in/,
  );
});
test("Engineering password errors distinguish unfinished setup and proven pending approval without changing membership", async () => {
  const email = "new-password-setup@onesa.eu";
  await assert.rejects(
    engineeringPasswordAccount(email, chosenPassword, []),
    { status: 401, code: "ENGINEERING_REGISTRATION_REQUIRED" },
  );
  const before = await db.query("SELECT count(*)::int AS count FROM engineering_memberships WHERE email=$1", [email]);
  assert.equal(before.rows[0].count, 0);
  await register(email, "engineering");
  await assert.rejects(
    engineeringPasswordAccount(email, chosenPassword, []),
    { status: 401, code: "ENGINEERING_REGISTRATION_REQUIRED" },
  );
  const confirmed = await confirm(await mailToken(email));
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, "pending");
  await assert.rejects(
    engineeringPasswordAccount(email, "synthetic-incorrect-password", []),
    { status: 401, code: "CREDENTIALS" },
  );
  await assert.rejects(
    engineeringPasswordAccount(email, chosenPassword, []),
    { status: 403, code: "ENGINEERING_APPROVAL_PENDING" },
  );
  assert.equal((await db.query("SELECT count(*)::int AS count FROM engineering_memberships WHERE email=$1", [email])).rows[0].count, 0);
  const jobsBefore = (await db.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'to'=$1", [email])).rows[0].count;
  await requestEngineeringLink(email, "synthetic_pending_" + randomUUID(), []);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'to'=$1", [email])).rows[0].count, jobsBefore);
  await assert.rejects(
    engineeringPasswordAccount("not-permitted@example.invalid", chosenPassword, []),
    { status: 401, code: "CREDENTIALS" },
  );
});
test("An approved engineering member can use an email link before configuring a password", async () => {
  const email = "approved-link-only@onesa.eu", id = randomUUID();
  await db.query("INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,$2,true,'Synthetic existing approval',$3)", [id, email, ownerId]);
  await assert.rejects(
    engineeringPasswordAccount(email, chosenPassword, []),
    { status: 401, code: "ENGINEERING_REGISTRATION_REQUIRED" },
  );
  const uid = "synthetic_link_only_" + randomUUID();
  await requestEngineeringLink(email, uid, []);
  assert.equal(await consumeEngineeringLink(await mailToken(email, "Your Onesa sign-in link"), uid, []), id);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM engineering_credentials WHERE membership_id=$1", [id])).rows[0].count, 0);
});
test("Administrator magic links require a fresh existing factor, commit failed attempts, expire and redeem once under concurrency", async () => {
  await requestAdminLink("owner@onesa.eu");
  const raw = await mailToken("owner@onesa.eu", "Your Onesa sign-in link");
  await assert.rejects(
    consumeAdminLink(raw, "bad-factor"),
    /invalid or expired/,
  );
  assert.equal(
    (
      await db.query("SELECT attempts FROM access_links WHERE token_hash=$1", [
        hash(raw),
      ])
    ).rows[0].attempts,
    1,
  );
  const fresh = await proof();
  const results = await Promise.allSettled([
    consumeAdminLink(raw, fresh.code),
    consumeAdminLink(raw, fresh.code),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  await db.query("UPDATE rate_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'access-link-cooldown:%'");
  await requestAdminLink("owner@onesa.eu");
  const expired = await mailToken("owner@onesa.eu", "Your Onesa sign-in link");
  await db.query(
    "UPDATE access_links SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [hash(expired)],
  );
  await assert.rejects(
    consumeAdminLink(expired, (await proof()).code),
    /invalid or expired/,
  );
});
test("A changed password invalidates an outstanding link, and global revocation removes all pending admin links", async () => {
  await requestAdminLink("owner@onesa.eu");
  const raw = await mailToken("owner@onesa.eu", "Your Onesa sign-in link");
  const old = (
    await db.query("SELECT password_hash FROM users WHERE id=$1", [ownerId])
  ).rows[0].password_hash;
  try {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      passwordHash("changed synthetic password"),
      ownerId,
    ]);
    await assert.rejects(
      consumeAdminLink(raw, (await proof()).code),
      /invalid or expired/,
    );
  } finally {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      old,
      ownerId,
    ]);
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/revoke",
    headers: ownerHeaders,
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (
      await db.query("SELECT token_hash FROM access_links WHERE user_id=$1", [
        ownerId,
      ])
    ).rowCount,
    0,
  );
});
test("Unknown account link requests have generic responses and cannot send mail; cross-origin requests are denied", async () => {
  const before = (await db.query("SELECT count(*) FROM jobs")).rows[0].count;
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/access/link",
    headers: origin,
    payload: { email: "unknown@onesa.eu" },
  });
  assert.equal(r.statusCode, 202);
  assert.equal(
    (await db.query("SELECT count(*) FROM jobs")).rows[0].count,
    before,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/access/register",
        headers: { origin: "https://attacker.invalid" },
        payload: {
          email: "new@onesa.eu",
          name: "Synthetic",
          audience: "admin",
        },
      })
    ).statusCode,
    403,
  );
});

test("Email-link MFA sign-in applies the same explicit browser persistence choice", async () => {
  for (const rememberBrowser of [false, true]) {
    await db.query("UPDATE rate_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'access-link-cooldown:%'");
    await requestAdminLink("owner@onesa.eu");
    const token = await mailToken("owner@onesa.eu", "Your Onesa sign-in link");
    const response = await app.inject({method:"POST", url:"/api/v1/access/link/verify", remoteAddress:"2001:db8:9::1", headers:origin, payload:{token, code:(await proof()).code, rememberBrowser}});
    assert.equal(response.statusCode,200,response.body);
    const cookie = response.cookies.find(c=>c.name==="onesa_session")!;
    assert.equal(cookie.maxAge, rememberBrowser ? 28800 : undefined);
    assert.equal(cookie.httpOnly,true); assert.equal(cookie.domain,undefined);
    const replay = await app.inject({method:"POST",url:"/api/v1/access/link/verify",remoteAddress:"2001:db8:9::1",headers:origin,payload:{token,code:(await proof()).code,rememberBrowser}});
    assert.equal(replay.statusCode,401); assert.equal(replay.cookies.length,0);
  }
});

test("Valid admin links identify enrollment or factor requirements without login or consuming attempts", async () => {
  const email = "no-mfa-" + randomUUID() + "@onesa.eu", id = randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'viewer')", [id, email, passwordHash(chosenPassword)]);
  await requestAdminLink(email);
  const raw = await mailToken(email, "Your Onesa sign-in link");
  for (const code of [undefined, "123456"]) {
    const r = await app.inject({method:"POST",url:"/api/v1/access/link/verify",headers:origin,payload:{token:raw,...(code ? {code} : {})}});
    assert.equal(r.statusCode,403,r.body); assert.equal(r.json().error.code,"MFA_ENROLLMENT_REQUIRED"); assert.equal(r.cookies.length,0);
  }
  await requestAdminLink("owner@onesa.eu");
  const enrolledLink = await mailToken("owner@onesa.eu", "Your Onesa sign-in link");
  const required = await app.inject({method:"POST",url:"/api/v1/access/link/verify",headers:origin,payload:{token:enrolledLink}});
  assert.equal(required.statusCode,401,required.body); assert.equal(required.json().error.code,"MFA_REQUIRED"); assert.equal(required.cookies.length,0);
  for (const value of [raw,enrolledLink]) {
    const row=(await db.query("SELECT attempts,consumed_at FROM access_links WHERE token_hash=$1",[hash(value)])).rows[0];
    assert.equal(row.attempts,0); assert.equal(row.consumed_at,null);
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",[id])).rows[0].n,0);
  await assert.rejects(consumeAdminLink(randomBytes(32).toString("hex"), ""), {code:"ACCESS_LINK"});
});
test("Concurrent sign-in link requests enqueue once, allow explicit resend after cooldown, and retain generic unknown-recipient behavior", async () => {
  const email="cooldown-"+randomUUID()+"@onesa.eu", id=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,'viewer',$4)",[id,email,passwordHash(chosenPassword),encrypt("JBSWY3DPEHPK3PXP")]);
  const count=async()=>Number((await db.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'to'=$1 AND payload->>'subject'='Your Onesa sign-in link'",[email])).rows[0].n);
  await Promise.all([requestAdminLink(email),requestAdminLink(email),requestAdminLink(email)]);
  assert.equal(await count(),1);
  await db.query("UPDATE rate_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'access-link-cooldown:%'");
  await requestAdminLink(email); assert.equal(await count(),2);
  const {engineeringLinkResendSeconds}=await import("../src/auth/access.js");
  for (const recipient of ["approved-link-only@onesa.eu","unknown-"+randomUUID()+"@onesa.eu"]) {
    const uid="synthetic_cooldown_"+randomUUID();
    const before=(await db.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'to'=$1",[recipient])).rows[0].n;
    await Promise.all([requestEngineeringLink(recipient,uid,[]),requestEngineeringLink(recipient,uid,[])]);
    const remaining=await engineeringLinkResendSeconds(uid); assert.ok(remaining>0 && remaining<=30);
    const after=(await db.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'to'=$1",[recipient])).rows[0].n;
    assert.equal(after-before,recipient.startsWith("unknown-")?0:1);
  }
});
