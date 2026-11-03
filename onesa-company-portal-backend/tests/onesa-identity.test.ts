import "./local-environment.js";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { InjectOptions } from "fastify";
if (!process.env.TEST_DATABASE_URL)
  throw Error("Isolated loopback test database required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_KEY = randomBytes(32).toString("hex");
process.env.PUBLIC_ORIGIN = "https://account.example.invalid";
process.env.COMPANY_ORIGIN = "";
process.env.PROXY_SHARED_KEY = randomBytes(32).toString("hex");
const origin = process.env.PUBLIC_ORIGIN;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer: origin + "/api/v1/identity",
  clients: ["ai", "drone", "robot"].map((product) => ({
    product,
    clientId: "synthetic_onesa_" + product,
    clientSecret: randomBytes(48).toString("hex") + "+%",
    redirectUri:
      "https://" + product + ".example.invalid/api/v1/auth/identity/callback",
    applicationUrl: "https://" + product + ".example.invalid/",
  })),
  cookieKeys: [randomBytes(48).toString("hex")],
  jwks: {
    keys: [
      {
        ...key.privateKey.export({ format: "jwk" }),
        kid: "synthetic_onesa_key",
        alg: "RS256",
        use: "sig",
      },
    ],
  },
};
process.env.ONESA_IDENTITY_ENABLED = "true";
process.env.ONESA_IDENTITY_CONFIG_B64 = Buffer.from(
  JSON.stringify(config),
).toString("base64");
const { db } = await import("../src/services/db.js");
const { migrate } = await import("../src/services/migrate.js");
const { buildApp } = await import("../src/app.js");
const { decrypt, encrypt, hash, passwordHash } =
  await import("../src/auth/crypto.js");
const { identityConfiguration } = await import("../src/identity/config.js");
const { IdentityAdapter } = await import("../src/identity/adapter.js");
const { revokeAccountIdentity } = await import("../src/identity/accounts.js");
const app = await buildApp({ logging: false });
const owner = randomUUID(),
  admin = randomUUID(),
  member = randomUUID(),
  outsider = randomUUID();
const password = "Synthetic shared account password 2026";
const passwordEncoded = passwordHash(password);
const ids = { owner, admin, member, outsider };
const emails = {
  owner: "owner@example.invalid",
  admin: "admin@example.invalid",
  member: "member@example.invalid",
  outsider: "outsider@example.invalid",
};
before(async () => {
  await migrate();
  await app.ready();
});
beforeEach(async () => {
  await db.query(
    "TRUNCATE users,audit,rate_limits,jobs,identity_records CASCADE",
  );
  for (const [name, id] of Object.entries(ids)) {
    await db.query(
      "INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        emails[name as keyof typeof emails],
        passwordEncoded,
        name === "owner"
          ? "owner"
          : name === "admin"
            ? "administrator"
            : "member",
        name === "owner" || name === "admin"
          ? encrypt("JBSWY3DPEHPK3PXP")
          : null,
      ],
    );
    await db.query(
      "INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,$2,now())",
      [id, "Synthetic " + name],
    );
  }
  await db.query(
    "INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'ai','user','active')",
    [member],
  );
});
after(async () => {
  await app.close();
  await db.end();
});
const proxy = { "x-portal-proxy-key": process.env.PROXY_SHARED_KEY! };
const basic = (index = 0) =>
  "Basic " +
  Buffer.from(
    encodeURIComponent(config.clients[index].clientId) +
      ":" +
      encodeURIComponent(config.clients[index].clientSecret),
  ).toString("base64");
function browser() {
  const jar = new Map<string, string>();
  const request = async (input: InjectOptions) => {
    const response = await app.inject({
      ...input,
      headers: {
        ...proxy,
        cookie: [...jar].map(([key, value]) => key + "=" + value).join("; "),
        ...(input.method === "POST" ||
        input.method === "PUT" ||
        input.method === "PATCH"
          ? { origin }
          : {}),
        ...input.headers,
      },
    });
    for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  };
  return { jar, request };
}
async function factor(id: string) {
  const code = randomUUID();
  await db.query("INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)", [
    id,
    hash(code),
  ]);
  return code;
}
async function signIn(name: keyof typeof ids = "member", client = browser()) {
  const response = await client.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: {
      email: emails[name],
      password,
      code: name === "owner" || name === "admin" ? await factor(ids[name]) : "",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { ...client, session: response.json() };
}
async function authorization(
  name: keyof typeof ids = "member",
  index = 0,
  existing = browser(),
  extra: Record<string, string> = {},
) {
  const verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(24).toString("hex");
  const query = new URLSearchParams({
    client_id: config.clients[index].clientId,
    redirect_uri: config.clients[index].redirectUri,
    response_type: "code",
    scope: "openid email profile onesa",
    state,
    nonce: randomBytes(24).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...extra,
  });
  const start = await existing.request({
    url: "/api/v1/identity/auth?" + query,
  });
  assert.equal(start.statusCode, 303, start.body);
  const location = new URL(String(start.headers.location));
  assert.match(location.pathname, /^\/account\/sign-in\/[A-Za-z0-9_-]+$/);
  const uid = location.pathname.split("/").pop()!;
  const details = await existing.request({
    url: "/api/v1/account/interaction/" + uid,
  });
  assert.equal(details.statusCode, 200, details.body);
  return {
    ...existing,
    uid,
    verifier,
    state,
    details: details.json(),
    index,
    name,
  };
}
async function issueCode(
  flow: Awaited<ReturnType<typeof authorization>>,
  useSession = false,
) {
  const submitted = await flow.request({
    method: "POST",
    url:
      "/api/v1/account/interaction/" +
      flow.uid +
      (useSession ? "/continue" : "/login"),
    payload: useSession
      ? { csrf: flow.details.csrf }
      : {
          csrf: flow.details.csrf,
          email: emails[flow.name],
          password,
          code:
            flow.name === "owner" || flow.name === "admin"
              ? await factor(ids[flow.name])
              : "",
        },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const resumed = await flow.request({ url: submitted.json().continuePath });
  assert.equal(resumed.statusCode, 303, resumed.body);
  const callback = new URL(String(resumed.headers.location));
  assert.equal(
    callback.origin + callback.pathname,
    config.clients[flow.index].redirectUri,
  );
  assert.equal(callback.searchParams.get("state"), flow.state);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.clients[flow.index].redirectUri,
    code_verifier: flow.verifier,
  }).toString();
  return { payload, callback };
}
async function complete(
  flow: Awaited<ReturnType<typeof authorization>>,
  useSession = false,
) {
  const { payload, callback } = await issueCode(flow, useSession);
  const exchanged = await app.inject({
    method: "POST",
    url: "/api/v1/identity/token",
    headers: {
      ...proxy,
      authorization: basic(flow.index),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload,
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(exchanged.json().refresh_token, undefined);
  return { token: exchanged.json().access_token as string, payload, callback };
}
const inspect = (token: string, index = 0) =>
  app.inject({
    method: "POST",
    url: "/api/v1/identity/session",
    headers: { ...proxy, authorization: basic(index) },
    payload: { token },
  });

test("Configuration is opt-in, fixed-client, exact issuer/callback and strong-key only", () => {
  assert.equal(identityConfiguration({}, origin), null);
  assert.equal(identityConfiguration(process.env, origin)?.clients.length, 3);
  for (const change of [
    { issuer: "https://foreign.invalid/api/v1/identity" },
    { clients: [config.clients[0], config.clients[0]] },
    { cookieKeys: ["short"] },
    {
      clients: [
        {
          ...config.clients[0],
          redirectUri: "https://foreign.invalid/callback",
        },
      ],
    },
    { clients: [{ ...config.clients[0], clientSecret: "short" }] },
  ])
    assert.throws(() =>
      identityConfiguration(
        {
          ONESA_IDENTITY_ENABLED: "true",
          ONESA_IDENTITY_CONFIG_B64: Buffer.from(
            JSON.stringify({ ...config, ...change }),
          ).toString("base64"),
        },
        origin,
      ),
    );
});
test("Protocol artifact custody is encrypted, bound, atomic and single-use", async () => {
  const adapter = new IdentityAdapter("AuthorizationCode"),
    id = randomUUID();
  await adapter.upsert(id, { accountId: member, grantId: "fixture-grant" }, 60);
  const row = (
    await db.query(
      "SELECT encrypted_payload FROM identity_records WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.ok(!row.encrypted_payload.includes(member));
  assert.equal(
    (
      await Promise.allSettled([adapter.consume(id), adapter.consume(id)])
    ).filter((r) => r.status === "fulfilled").length,
    1,
  );
  await adapter.revokeByGrantId("fixture-grant");
  assert.equal(await adapter.find(id), undefined);
});
test("Registration verifies email once and grants no product or administrator authority", async () => {
  const client = browser(),
    email = "new-account@example.invalid";
  const requested = await client.request({
    method: "POST",
    url: "/api/v1/account/register",
    payload: { email, name: "New account", products: ["ai", "robot"] },
  });
  assert.equal(requested.statusCode, 202, requested.body);
  const job = (
    await db.query("SELECT payload FROM jobs WHERE payload->>'to'=$1", [email])
  ).rows[0];
  assert.equal(job.payload.text, undefined);
  const raw = decrypt(job.payload.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )?.[1];
  assert.ok(raw);
  assert.equal(
    (
      await client.request({
        method: "POST",
        url: "/api/v1/account/confirm",
        payload: { token: raw, password },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await client.request({
        method: "POST",
        url: "/api/v1/account/confirm",
        payload: { token: raw, password },
      })
    ).statusCode,
    401,
  );
  const user = (
    await db.query("SELECT id,role FROM users WHERE email=$1", [email])
  ).rows[0];
  assert.equal(user.role, "member");
  const grants = (
    await db.query(
      "SELECT product,status FROM identity_product_access WHERE user_id=$1 ORDER BY product",
      [user.id],
    )
  ).rows;
  assert.deepEqual(grants, [
    { product: "ai", status: "pending" },
    { product: "robot", status: "pending" },
  ]);
  const signed = await client.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email, password },
  });
  assert.equal(signed.statusCode, 200, signed.body);
  assert.equal(
    signed.cookies.some((c) => c.name === "onesa_session" && c.value),
    false,
  );
  assert.equal(
    (await client.request({ url: "/api/v1/admin/identity/accounts" }))
      .statusCode,
    401,
  );
});
test("Existing account verification cannot replace its password or link with email alone", async () => {
  await db.query("DELETE FROM identity_profiles WHERE user_id=$1", [member]);
  const client = browser();
  await client.request({
    method: "POST",
    url: "/api/v1/account/register",
    payload: { email: emails.member, name: "Existing", products: ["ai"] },
  });
  const job = (
    await db.query("SELECT payload FROM jobs WHERE payload->>'to'=$1", [
      emails.member,
    ])
  ).rows[0];
  const raw = decrypt(job.payload.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )![1];
  const wrong = await client.request({
    method: "POST",
    url: "/api/v1/account/confirm",
    payload: { token: raw, password: "An unrelated replacement password" },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(
    (await db.query("SELECT password_hash FROM users WHERE id=$1", [member]))
      .rows[0].password_hash,
    passwordEncoded,
  );
  assert.equal(
    (
      await client.request({
        method: "POST",
        url: "/api/v1/account/confirm",
        payload: { token: raw, password },
      })
    ).statusCode,
    200,
  );
});
test("One central identity signs into every approved product and returns current per-product grants", async () => {
  await db.query(
    "INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'drone','viewer','active'),($1,'robot','operator','active')",
    [member],
  );
  const tenant = randomUUID();
  await db.query(
    "INSERT INTO identity_drone_memberships VALUES($1,$2,'viewer','Synthetic workspace')",
    [member, tenant],
  );
  const central = await signIn();
  for (let index = 0; index < 3; index++) {
    const flow = await authorization("member", index, central);
    assert.equal(flow.details.account.id, member);
    const { token } = await complete(flow, true),
      response = await inspect(token, index);
    assert.equal(response.statusCode, 200, response.body);
    const claims = response.json();
    assert.equal(claims.active, true);
    assert.equal(claims.sub, member);
    assert.equal(claims.iss, config.issuer);
    assert.equal(claims.aud, config.clients[index].clientId);
    assert.deepEqual(claims.onesa_roles, []);
    assert.equal(claims.onesa_applications.length, 3);
    assert.deepEqual(claims.onesa_memberships, [
      { product: "drone", tenant_id: tenant, role: "viewer" },
    ]);
    assert.equal(
      claims.auth_time,
      Math.floor(
        new Date(
          (
            await db.query(
              "SELECT authenticated_at FROM identity_sessions WHERE user_id=$1",
              [member],
            )
          ).rows[0].authenticated_at,
        ).getTime() / 1000,
      ),
    );
  }
});
test("Unapproved products cannot issue a login grant", async () => {
  const flow = await authorization("outsider");
  const reply = await flow.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + flow.uid + "/login",
    payload: { csrf: flow.details.csrf, email: emails.outsider, password },
  });
  assert.equal(reply.statusCode, 403);
  assert.equal(reply.json().error.code, "PRODUCT_ACCESS_REQUIRED");
  assert.equal(
    (await db.query("SELECT id FROM identity_records WHERE model='Grant'"))
      .rowCount,
    0,
  );
});
test("Codes are browser-bound, protected by PKCE, exact redirects and replay rejection", async () => {
  const flow = await authorization();
  assert.equal(
    (
      await browser().request({
        url: "/api/v1/account/interaction/" + flow.uid,
      })
    ).statusCode,
    401,
  );
  const badCsrf = await flow.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + flow.uid + "/login",
    payload: { csrf: "0".repeat(64), email: emails.member, password },
  });
  assert.equal(badCsrf.statusCode, 403);
  const result = await complete(flow);
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/identity/token",
    headers: {
      ...proxy,
      authorization: basic(),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: result.payload,
  });
  assert.equal(replay.statusCode, 400);
  const params = new URLSearchParams({
    client_id: config.clients[0].clientId,
    redirect_uri: "https://foreign.invalid/callback",
    response_type: "code",
    scope: "openid",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  const refused = await app.inject({
    url: "/api/v1/identity/auth?" + params,
    headers: proxy,
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.headers.location, undefined);
});
test("Live assertions bind client audience and reject wrong Basic credentials", async () => {
  const { token } = await complete(await authorization());
  assert.equal((await inspect(token)).json().active, true);
  assert.deepEqual((await inspect(token, 1)).json(), { active: false });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/identity/session",
        headers: {
          authorization:
            "Basic " +
            Buffer.from("synthetic_onesa_ai:wrong").toString("base64"),
        },
        payload: { token },
      })
    ).statusCode,
    401,
  );
});
test("Revoking a product removes access from an already issued token immediately", async () => {
  const { token } = await complete(await authorization());
  await db.query(
    "UPDATE identity_product_access SET status='revoked' WHERE user_id=$1 AND product='ai'",
    [member],
  );
  assert.deepEqual((await inspect(token)).json(), { active: false });
});
test("Global Administrators need MFA and receive all applications without per-product approval", async () => {
  const flow = await authorization("admin", 2);
  const noMfa = await flow.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + flow.uid + "/login",
    payload: { csrf: flow.details.csrf, email: emails.admin, password },
  });
  assert.equal(noMfa.statusCode, 401);
  assert.equal(noMfa.json().error.code, "MFA_REQUIRED");
  const { token } = await complete(flow),
    claims = (await inspect(token, 2)).json();
  assert.deepEqual(claims.onesa_roles, ["global_admin"]);
  assert.deepEqual(claims.onesa_product_roles, {
    ai: "admin",
    drone: "admin",
    robot: "admin",
  });
  assert.ok(claims.amr.includes("otp"));
});
test("Fresh step-up cannot reuse an existing login session", async () => {
  const central = await signIn("admin"),
    flow = await authorization("admin", 0, central, {
      prompt: "login",
      max_age: "0",
      acr_values: "urn:onesa:mfa",
    });
  assert.equal(flow.details.freshRequired, true);
  const reused = await flow.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + flow.uid + "/continue",
    payload: { csrf: flow.details.csrf },
  });
  assert.equal(reused.statusCode, 403);
  assert.equal(reused.json().error.code, "REAUTH_REQUIRED");
  const { token } = await complete(flow);
  assert.equal((await inspect(token)).json().active, true);
});
test("Password, MFA, disable and role changes revoke issuer artifacts atomically", async () => {
  for (const change of [
    "password_hash=password_hash||'x'",
    "mfa_secret='synthetic-changed'",
    "disabled=true",
    "role='viewer'",
  ]) {
    await db.query(
      "UPDATE users SET password_hash=$2,mfa_secret=NULL,disabled=false,role='member' WHERE id=$1",
      [member, passwordEncoded],
    );
    const { token } = await complete(await authorization());
    await db.query("UPDATE users SET " + change + " WHERE id=$1", [member]);
    assert.deepEqual((await inspect(token)).json(), { active: false });
    assert.equal(
      (
        await db.query(
          "SELECT token_hash FROM identity_sessions WHERE user_id=$1",
          [member],
        )
      ).rowCount,
      0,
    );
  }
});
test("Central logout revokes all products while a foreign client cannot revoke a token", async () => {
  const { token } = await complete(await authorization());
  const foreign = await app.inject({
    method: "POST",
    url: "/api/v1/identity/revoke",
    headers: { authorization: basic(1) },
    payload: { token, all_sessions: true },
  });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.json().all_sessions_revoked, false);
  assert.equal((await inspect(token)).json().active, true);
  const revoked = await app.inject({
    method: "POST",
    url: "/api/v1/identity/revoke",
    headers: { authorization: basic() },
    payload: { token, all_sessions: true },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().all_sessions_revoked, true);
  const repeated = await app.inject({
    method: "POST",
    url: "/api/v1/identity/revoke",
    headers: { authorization: basic() },
    payload: { token, all_sessions: true },
  });
  assert.equal(repeated.json().all_sessions_revoked, false);
  assert.deepEqual((await inspect(token)).json(), { active: false });
});
test("Legacy administrative routes cannot bypass owner-controlled global Administrator assignment", async () => {
  const client = await signIn("admin");
  const create = await client.request({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { "x-csrf-token": client.session.csrf },
    payload: {
      email: "unauthorized-global-admin@example.invalid",
      password,
      role: "administrator",
    },
  });
  assert.equal(create.statusCode, 403);
  const change = await client.request({
    method: "PATCH",
    url: "/api/v1/admin/users/" + outsider,
    headers: { "x-csrf-token": client.session.csrf },
    payload: {
      role: "administrator",
      disabled: false,
      stepUp: { password, code: await factor(admin) },
    },
  });
  assert.equal(change.statusCode, 403);
  const own = await signIn("owner");
  const noProof = await own.request({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: { "x-csrf-token": own.session.csrf },
    payload: {
      email: "missing-proof@example.invalid",
      password,
      role: "administrator",
    },
  });
  assert.equal(noProof.statusCode, 403);
  const granted = await own.request({
    method: "PUT",
    url: "/api/v1/admin/identity/accounts/" + outsider + "/administrator",
    headers: { "x-csrf-token": own.session.csrf },
    payload: {
      administrator: true,
      stepUp: { password, code: await factor(owner) },
    },
  });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal(
    (await db.query("SELECT role FROM users WHERE id=$1", [outsider])).rows[0]
      .role,
    "administrator",
  );
});
test("Member account sessions are host-only and cannot access Portal administration or omit Origin/CSRF", async () => {
  const client = await signIn();
  assert.equal(
    (await client.request({ url: "/api/v1/admin/dashboard" })).statusCode,
    401,
  );
  assert.equal(
    (
      await client.request({
        method: "POST",
        url: "/api/v1/account/products/drone/request",
        payload: {},
      })
    ).statusCode,
    403,
  );
  const missingOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/account/products/drone/request",
    headers: {
      cookie: [...client.jar]
        .map(([key, value]) => key + "=" + value)
        .join("; "),
      "x-csrf-token": client.session.csrf,
    },
    payload: {},
  });
  assert.equal(missingOrigin.statusCode, 403);
  const request = await client.request({
    method: "POST",
    url: "/api/v1/account/products/drone/request",
    headers: { "x-csrf-token": client.session.csrf },
    payload: {},
  });
  assert.equal(request.statusCode, 200, request.body);
  assert.equal(
    request
      .json()
      .access.find((a: { product: string }) => a.product === "drone").status,
    "pending",
  );
});
test("Product access changes require current revision, fresh administrator proof and explicit Drone workspace", async () => {
  const client = await signIn("admin"),
    path = "/api/v1/admin/identity/accounts/" + member + "/products/drone";
  const input = {
    role: "viewer",
    status: "active",
    expectedRevision: 0,
    memberships: [],
  };
  const noProof = await client.request({
    method: "PUT",
    url: path,
    headers: { "x-csrf-token": client.session.csrf },
    payload: input,
  });
  assert.equal(noProof.statusCode, 400);
  const noWorkspace = await client.request({
    method: "PUT",
    url: path,
    headers: { "x-csrf-token": client.session.csrf },
    payload: { ...input, stepUp: { password, code: await factor(admin) } },
  });
  assert.equal(noWorkspace.statusCode, 400);
  assert.equal(noWorkspace.json().error.code, "WORKSPACE_REQUIRED");
  const memberships = [
    { tenant_id: randomUUID(), role: "viewer", label: "Synthetic team" },
  ];
  const saved = await client.request({
    method: "PUT",
    url: path,
    headers: { "x-csrf-token": client.session.csrf },
    payload: {
      ...input,
      memberships,
      stepUp: { password, code: await factor(admin) },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const conflict = await client.request({
    method: "PUT",
    url: path,
    headers: { "x-csrf-token": client.session.csrf },
    payload: {
      ...input,
      memberships,
      stepUp: { password, code: await factor(admin) },
    },
  });
  assert.equal(conflict.statusCode, 409);
});

test("A wrong PKCE verifier cannot redeem a real issued authorization code", async () => {
  const { payload } = await issueCode(await authorization());
  const wrong = new URLSearchParams(payload);
  wrong.set("code_verifier", randomBytes(48).toString("base64url"));
  const refused = await app.inject({
    method: "POST",
    url: "/api/v1/identity/token",
    headers: {
      ...proxy,
      authorization: basic(),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: wrong.toString(),
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, "invalid_grant");
  assert.equal(refused.json().access_token, undefined);
});

test("A replaced provider grant cannot claim completed global sign-out", async () => {
  const { token } = await complete(await authorization());
  await db.query(
    "DELETE FROM identity_records WHERE model='Grant' AND account_id=$1",
    [member],
  );
  assert.equal((await inspect(token)).json().active, false);
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/identity/revoke",
    headers: { authorization: basic() },
    payload: { token, all_sessions: true },
  });
  assert.deepEqual(result.json(), { ok: true, all_sessions_revoked: false });
  assert.equal(
    (
      await db.query(
        "SELECT token_hash FROM identity_sessions WHERE user_id=$1",
        [member],
      )
    ).rowCount,
    1,
  );
});

test("Signing into a member account clears the previous Administrator and product sessions", async () => {
  const central = await signIn("admin");
  const flow = await authorization("admin", 0, central);
  const { token } = await complete(flow, true);
  assert.equal(
    (await central.request({ url: "/api/v1/admin/dashboard" })).statusCode,
    200,
  );
  const switched = await signIn("member", central);
  assert.equal(switched.session.account.id, member);
  assert.equal(switched.session.account.globalAdmin, false);
  assert.equal(central.jar.get("onesa_session"), "");
  assert.equal(
    (await central.request({ url: "/api/v1/admin/dashboard" })).statusCode,
    401,
  );
  assert.deepEqual((await inspect(token)).json(), { active: false });
});

test("An existing MFA Portal session can approve an explicitly bound shared grant", async () => {
  const central = await signIn("admin");
  central.jar.delete("onesa_account");
  const flow = await authorization("admin", 0, central);
  const { token } = await complete(flow, true);
  const claims = (await inspect(token)).json();
  assert.equal(claims.active, true);
  assert.equal(claims.sub, admin);
  assert.deepEqual(claims.amr, ["otp"]);
  assert.equal(
    (
      await db.query(
        "SELECT source_kind FROM identity_grant_sessions WHERE user_id=$1",
        [admin],
      )
    ).rows[0].source_kind,
    "portal",
  );
});

test("Native Portal logout revokes only grants bound to that native session", async () => {
  const first = await signIn("admin");
  const savedAccountCookie = first.jar.get("onesa_account")!;
  first.jar.delete("onesa_account");
  const portalGrant = await complete(await authorization("admin", 0, first), true);
  first.jar.set("onesa_account", savedAccountCookie);
  const second = await signIn("admin");
  const independentGrant = await complete(await authorization("admin", 1, second), true);
  const response = await first.request({
    method: "POST", url: "/api/v1/auth/logout",
    headers: { "x-csrf-token": first.session.csrf }, payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await inspect(portalGrant.token, 0)).json().active, false);
  assert.equal((await inspect(independentGrant.token, 1)).json().active, true);
  assert.equal((await first.request({url: "/api/v1/account/me"})).statusCode, 200);
  assert.equal((await second.request({url: "/api/v1/admin/dashboard"})).statusCode, 200);
});

test("Identity-disabled candidate keeps native administration usable with a member on schema 014", async () => {
  const before = (await db.query("SELECT id,email,password_hash,role,disabled FROM users WHERE id=$1", [member])).rows[0];
  const previous = process.env.ONESA_IDENTITY_ENABLED;
  process.env.ONESA_IDENTITY_ENABLED = "false";
  const fallback = await buildApp({logging: false});
  try {
    await fallback.ready();
    const login = await fallback.inject({method: "POST", url: "/api/v1/auth/login", headers: proxy,
      payload: {email: emails.owner, password, code: await factor(owner)}});
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.filter(c => c.value).map(c => c.name + "=" + c.value).join("; ");
    const list = await fallback.inject({url: "/api/v1/admin/users", headers: {...proxy, cookie}});
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(list.json().items.some((user: {id: string}) => user.id === owner));
    assert.ok(!list.json().items.some((user: {id: string}) => user.id === member));
    const memberLogin = await fallback.inject({method: "POST", url: "/api/v1/auth/login", headers: proxy,
      payload: {email: emails.member, password, code: ""}});
    assert.equal(memberLogin.statusCode, 401);
    const configResponse = await fallback.inject({url: "/api/v1/account/config", headers: proxy});
    assert.deepEqual(configResponse.json(), {enabled: false, applications: []});
    assert.deepEqual((await db.query("SELECT id,email,password_hash,role,disabled FROM users WHERE id=$1", [member])).rows[0], before);
  } finally {
    process.env.ONESA_IDENTITY_ENABLED = previous;
    await fallback.close();
  }
});

async function revokeWhileBlocked(
  work: () => Promise<
    Awaited<ReturnType<ReturnType<typeof browser>["request"]>>
  >,
) {
  const holder = await db.connect();
  let running: ReturnType<typeof work> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
      member,
    ]);
    running = work();
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await db.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id=%'",
      );
      if (found.rowCount) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.equal(
      blocked,
      true,
      "the admitted HTTP request must actually reach the held account lock",
    );
    await revokeAccountIdentity(holder, member);
    await holder.query("DELETE FROM sessions WHERE user_id=$1", [member]);
    await holder.query("COMMIT");
    return await running;
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    if (running) await running;
  }
}

test("A password change admitted before concurrent sign-out cannot mutate credentials afterward", async () => {
  const central = await signIn();
  const result = await revokeWhileBlocked(() =>
    central.request({
      method: "POST",
      url: "/api/v1/account/password/change",
      headers: { "x-csrf-token": central.session.csrf },
      payload: {
        currentPassword: password,
        password: "Different synthetic account password 2026",
      },
    }),
  );
  assert.equal(result.statusCode, 401, result.body);
  assert.equal(
    (await db.query("SELECT password_hash FROM users WHERE id=$1", [member]))
      .rows[0].password_hash,
    passwordEncoded,
  );
});

test("A product continuation admitted before concurrent sign-out cannot recreate an active grant", async () => {
  const central = await signIn();
  const flow = await authorization("member", 0, central);
  const result = await revokeWhileBlocked(() =>
    flow.request({
      method: "POST",
      url: "/api/v1/account/interaction/" + flow.uid + "/continue",
      payload: { csrf: flow.details.csrf },
    }),
  );
  assert.equal(result.statusCode, 401, result.body);
  assert.equal(
    (
      await db.query(
        "SELECT grant_id FROM identity_grant_sessions WHERE user_id=$1",
        [member],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM identity_records WHERE model='Grant' AND account_id=$1",
        [member],
      )
    ).rowCount,
    0,
  );
});

test("Late provider writes cannot restore access after the source session has ended", async () => {
  const flow = await authorization();
  const { token } = await complete(flow);
  const records = (
    await db.query("SELECT * FROM identity_records WHERE account_id=$1", [
      member,
    ])
  ).rows;
  const bindings = (
    await db.query("SELECT * FROM identity_grant_sessions WHERE user_id=$1", [
      member,
    ])
  ).rows;
  const session = (await flow.request({ url: "/api/v1/account/me" })).json();
  const loggedOut = await flow.request({
    method: "POST",
    url: "/api/v1/account/logout",
    headers: { "x-csrf-token": session.csrf },
    payload: {},
  });
  assert.equal(loggedOut.statusCode, 200);
  for (const record of records)
    await db.query(
      "INSERT INTO identity_records SELECT * FROM json_populate_record(NULL::identity_records,$1::json) ON CONFLICT DO NOTHING",
      [JSON.stringify(record)],
    );
  for (const binding of bindings)
    await db.query(
      "INSERT INTO identity_grant_sessions SELECT * FROM json_populate_record(NULL::identity_grant_sessions,$1::json) ON CONFLICT DO NOTHING",
      [JSON.stringify(binding)],
    );
  assert.deepEqual((await inspect(token)).json(), { active: false });
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/identity/revoke",
    headers: { authorization: basic() },
    payload: { token, all_sessions: true },
  });
  assert.equal(result.json().all_sessions_revoked, false);
});

test("A new product Administrator grant cannot elevate a password-only session", async () => {
  const central = await signIn();
  const { token } = await complete(
    await authorization("member", 0, central),
    true,
  );
  await db.query(
    "UPDATE identity_product_access SET role='admin' WHERE user_id=$1 AND product='ai'",
    [member],
  );
  assert.deepEqual((await inspect(token)).json(), { active: false });
  const refused = await browser().request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error.code, "MFA_ENROLLMENT_REQUIRED");
  await db.query("UPDATE users SET mfa_secret=$2 WHERE id=$1", [
    member,
    encrypt("JBSWY3DPEHPK3PXP"),
  ]);
  const accepted = await browser().request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password, code: await factor(member) },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test("Restore quarantine removes shared capabilities and preserves identity and approval evidence", async () => {
  const { execFileSync } = await import("node:child_process");
  const { token } = await complete(await authorization());
  await app.inject({
    method: "POST",
    url: "/api/v1/account/register",
    headers: { origin },
    payload: {
      email: "synthetic.restore@example.invalid",
      name: "Synthetic restored account",
      products: ["ai"],
    },
  });
  const sql = execFileSync(
    "python3",
    [
      "-c",
      "import sys;sys.path.insert(0,'../scripts/release');import restore_lockdown;print(restore_lockdown.IDENTITY_SQL)",
    ],
    { encoding: "utf8" },
  );
  await db.query(sql);
  for (const table of [
    "identity_sessions",
    "identity_records",
    "identity_registration_links",
    "identity_grant_sessions",
  ])
    assert.equal(
      (await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]
        .count,
      0,
    );
  assert.deepEqual((await inspect(token)).json(), { active: false });
  assert.equal(
    (
      await db.query(
        "SELECT status FROM identity_product_access WHERE user_id=$1 AND product='ai'",
        [member],
      )
    ).rows[0].status,
    "active",
  );
  assert.equal(
    (
      await db.query(
        "SELECT email_verified_at IS NOT NULL AS verified FROM identity_profiles WHERE user_id=$1",
        [member],
      )
    ).rows[0].verified,
    true,
  );
});

test("A revoked source cannot submit a delayed access request or global logout", async () => {
  for (const url of [
    "/api/v1/account/products/drone/request",
    "/api/v1/account/logout",
  ]) {
    const central = await signIn();
    const result = await revokeWhileBlocked(() =>
      central.request({
        method: "POST",
        url,
        headers: { "x-csrf-token": central.session.csrf },
        payload: {},
      }),
    );
    assert.equal(result.statusCode, 401, result.body);
  }
  assert.equal(
    (
      await db.query(
        "SELECT product FROM identity_product_access WHERE user_id=$1 AND product='drone'",
        [member],
      )
    ).rowCount,
    0,
  );
});

test("Same-account reauthentication retains other products without renewing their authentication proof", async () => {
  const central = await signIn("admin");
  const oldCookie = central.jar.get("onesa_account")!;
  const oldTime = Math.floor(Date.now() / 1000) - 600;
  await db.query(
    "UPDATE identity_sessions SET authenticated_at=to_timestamp($2) WHERE user_id=$1",
    [admin, oldTime],
  );
  const first = await complete(await authorization("admin", 0, central), true);
  const before = (await inspect(first.token)).json();
  assert.equal(before.auth_time, oldTime);
  await signIn("admin", central);
  assert.notEqual(central.jar.get("onesa_account"), oldCookie);
  const after = (await inspect(first.token)).json();
  assert.equal(after.active, true);
  assert.equal(after.auth_time, before.auth_time);
  assert.deepEqual(after.amr, before.amr);
  assert.equal(after.exp, before.exp);
  const expiredBrowser = await browser().request({
    url: "/api/v1/account/me",
    headers: { cookie: "onesa_account=" + oldCookie },
  });
  assert.equal(expiredBrowser.statusCode, 401);
  const fresh = await complete(await authorization("admin", 1, central), true);
  assert.ok(
    (await inspect(fresh.token, 1)).json().auth_time > before.auth_time,
  );
  const me = (await central.request({ url: "/api/v1/account/me" })).json();
  assert.equal(
    (
      await central.request({
        method: "POST",
        url: "/api/v1/account/logout",
        headers: { "x-csrf-token": me.csrf },
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.equal((await inspect(first.token)).json().active, false);
  assert.equal((await inspect(fresh.token, 1)).json().active, false);
});

test("Concurrent all-product sign-outs use one confirmed revocation without pool starvation", async () => {
  const { token } = await complete(await authorization());
  const results = await Promise.all(
    Array.from({ length: 15 }, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/identity/revoke",
        headers: { authorization: basic() },
        payload: { token, all_sessions: true },
      }),
    ),
  );
  assert.ok(results.every((result) => result.statusCode === 200));
  assert.equal(
    results.filter((result) => result.json().all_sessions_revoked === true)
      .length,
    1,
  );
  assert.equal((await inspect(token)).json().active, false);
});
