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
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  clients: ["ai", "drone", "robot", "mobile", "farmer", "logistics", "pasofi", "factory"].map((product) => ({
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
  for (const name of ["onesa_identity_interaction", "onesa_identity_interaction.sig"]) {
    const cookie = start.cookies.find(value => value.name === name);
    assert.ok(cookie);
    assert.equal(cookie.path, "/api/v1/account/interaction/" + uid);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
  }
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
  assert.equal(identityConfiguration(process.env, origin)?.clients.length, 8);
  assert.equal(
    identityConfiguration(
      {
        ONESA_IDENTITY_ENABLED: "true",
        ONESA_IDENTITY_CONFIG_B64: Buffer.from(
          JSON.stringify({ ...config, clients: config.clients.slice(0, 3) }),
        ).toString("base64"),
      },
      origin,
    )?.clients.length,
    3,
  );
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
test("an MFA platform session signs into all configured clients with the contract for that audience", async () => {
  const central = await signIn("admin");
  const legacy = ["ai", "drone", "robot"];
  const tokens: string[] = [];
  for (const [index, client] of config.clients.entries()) {
    const flow = await authorization("admin", index, central);
    assert.equal(flow.details.account.id, admin);
    const { token } = await complete(flow, true);
    const claims = (await inspect(token, index)).json();
    assert.equal(claims.active, true);
    assert.equal(claims.sub, admin);
    assert.equal(claims.aud, client.clientId);
    assert.deepEqual(claims.onesa_roles, ["global_admin"]);
    assert.ok(claims.amr.includes("otp"));
    const expected = legacy.includes(client.product) ? legacy :
      client.product === "mobile" ? [...legacy, "mobile"] : [client.product];
    assert.deepEqual(claims.onesa_applications, expected);
    assert.deepEqual(claims.onesa_product_roles, Object.fromEntries(expected.map((name) => [name, "admin"])));
    assert.deepEqual(claims.onesa_memberships, []);
    tokens.push(token);
  }
  await db.query("UPDATE users SET role='member' WHERE id=$1", [admin]);
  for (const [index, token] of tokens.entries())
    assert.deepEqual((await inspect(token, index)).json(), { active: false });
});

test("ordinary product membership cannot authorize an administrator-only client", async () => {
  const central = await signIn("member");
  for (const [index, client] of config.clients.entries()) {
    if (!["farmer", "logistics", "pasofi"].includes(client.product)) continue;
    const flow = await authorization("member", index, central);
    const response = await flow.request({
      method: "POST", url: "/api/v1/account/interaction/" + flow.uid + "/continue",
      payload: {csrf: flow.details.csrf},
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "PRODUCT_ACCESS_REQUIRED");
  }
});

test("switching from AI to PasoFi and Mobile keeps OIDC state, enforces max_age and preserves prior proof", async () => {
  const central = await signIn("admin");
  const oldTime = Math.floor(Date.now() / 1000) - 600;
  await db.query("UPDATE identity_sessions SET authenticated_at=to_timestamp($2) WHERE user_id=$1", [admin, oldTime]);
  const first = await complete(await authorization("admin", 0, central), true);
  const original = (await inspect(first.token, 0)).json();
  assert.equal(original.auth_time, oldTime);
  const pasofi = config.clients.findIndex(client => client.product === "pasofi");
  const mobile = config.clients.findIndex(client => client.product === "mobile");
  const stepUp = { max_age: "300", acr_values: "urn:onesa:mfa" };
  const stale = await authorization("admin", pasofi, central, stepUp);
  assert.equal(stale.details.freshRequired, true);
  const refused = await stale.request({method: "POST", url: "/api/v1/account/interaction/" + stale.uid + "/continue", payload: {csrf: stale.details.csrf}});
  assert.equal(refused.statusCode, 403);
  const refreshed = await complete(stale);
  const fresh = (await inspect(refreshed.token, pasofi)).json();
  assert.equal(fresh.active, true);
  assert.ok(fresh.auth_time > oldTime);
  const next = await authorization("admin", mobile, central, stepUp);
  assert.equal(next.details.freshRequired, false);
  const continued = await complete(next, true);
  assert.equal((await inspect(continued.token, mobile)).json().auth_time, fresh.auth_time);
  assert.deepEqual((await inspect(first.token, 0)).json(), original);
  await db.query("UPDATE users SET role='member' WHERE id=$1", [admin]);
  for (const [index, grant] of [[0, first], [pasofi, refreshed], [mobile, continued]] as const)
    assert.deepEqual((await inspect(grant.token, index)).json(), { active: false });
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
  const portalGrant = await complete(
    await authorization("admin", 0, first),
    true,
  );
  first.jar.set("onesa_account", savedAccountCookie);
  const second = await signIn("admin");
  const independentGrant = await complete(
    await authorization("admin", 1, second),
    true,
  );
  const response = await first.request({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { "x-csrf-token": first.session.csrf },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await inspect(portalGrant.token, 0)).json().active, false);
  assert.equal((await inspect(independentGrant.token, 1)).json().active, true);
  assert.equal(
    (await first.request({ url: "/api/v1/account/me" })).statusCode,
    200,
  );
  assert.equal(
    (await second.request({ url: "/api/v1/admin/dashboard" })).statusCode,
    200,
  );
});

test("Identity-disabled candidate keeps native administration usable with a member on schema 016", async () => {
  const before = (
    await db.query(
      "SELECT id,email,password_hash,role,disabled FROM users WHERE id=$1",
      [member],
    )
  ).rows[0];
  const previous = process.env.ONESA_IDENTITY_ENABLED;
  process.env.ONESA_IDENTITY_ENABLED = "false";
  const fallback = await buildApp({ logging: false });
  try {
    await fallback.ready();
    const login = await fallback.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: proxy,
      payload: { email: emails.owner, password, code: await factor(owner) },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies
      .filter((c) => c.value)
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    const list = await fallback.inject({
      url: "/api/v1/admin/users",
      headers: { ...proxy, cookie },
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(
      list.json().items.some((user: { id: string }) => user.id === owner),
    );
    assert.ok(
      !list.json().items.some((user: { id: string }) => user.id === member),
    );
    const memberLogin = await fallback.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: proxy,
      payload: { email: emails.member, password, code: "" },
    });
    assert.equal(memberLogin.statusCode, 401);
    const configResponse = await fallback.inject({url: "/api/v1/account/config", headers: proxy});
    const configuration=configResponse.json();
    assert.deepEqual({enabled:configuration.enabled,applications:configuration.applications}, {enabled: false, applications: []});
    assert.deepEqual(configuration.catalog.map((entry:{product:string;connected:boolean})=>[entry.product,entry.connected]), ["ai","drone","robot","farmer","logistics","factory","pasofi","mobile"].map(product=>[product,false]));
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

test("Mobile customer requests remain pending and legacy client claims keep the three-product vocabulary", async () => {
  const central = await signIn();
  const requested = await central.request({
    method: "POST",
    url: "/api/v1/account/products/mobile/request",
    headers: { "x-csrf-token": central.session.csrf },
    payload: {},
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const grant = requested
    .json()
    .access.find((item: { product: string }) => item.product === "mobile");
  assert.equal(grant.role, "customer");
  assert.equal(grant.status, "pending");
  const denied = await authorization("member", 3, central);
  const refused = await denied.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + denied.uid + "/continue",
    payload: { csrf: denied.details.csrf },
  });
  assert.equal(refused.statusCode, 403);
  await db.query(
    "UPDATE identity_product_access SET status='active',revision=revision+1 WHERE user_id=$1 AND product='mobile'",
    [member],
  );
  const mobileFlow = await authorization("member", 3, central),
    mobile = await complete(mobileFlow, true);
  const mobileClaims = (await inspect(mobile.token, 3)).json();
  assert.equal(mobileClaims.active, true);
  assert.equal(mobileClaims.onesa_product_roles.mobile, "customer");
  assert.ok(mobileClaims.onesa_applications.includes("mobile"));
  assert.equal(mobileClaims.amr.includes("otp"), false);
  const legacyFlow = await authorization("member", 0, central),
    legacy = await complete(legacyFlow, true);
  const legacyClaims = (await inspect(legacy.token, 0)).json();
  assert.deepEqual(legacyClaims.onesa_applications, ["ai"]);
  assert.deepEqual(legacyClaims.onesa_product_roles, { ai: "user" });
  assert.equal((await inspect(mobile.token, 0)).json().active, false);
});

test("Mobile staff MFA is enforced at login, continuation and every live assertion", async () => {
  await db.query(
    "INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'mobile','customer','active')",
    [member],
  );
  const central = await signIn(),
    customerFlow = await authorization("member", 3, central),
    issued = await complete(customerFlow, true);
  await db.query(
    "UPDATE identity_product_access SET role='operations',revision=revision+1 WHERE user_id=$1 AND product='mobile'",
    [member],
  );
  assert.equal((await inspect(issued.token, 3)).json().active, false);
  const passwordSession = browser();
  passwordSession.jar.set("onesa_account", central.jar.get("onesa_account")!);
  const staffFlow = await authorization("member", 3, passwordSession);
  const continued = await staffFlow.request({
    method: "POST",
    url: "/api/v1/account/interaction/" + staffFlow.uid + "/continue",
    payload: { csrf: staffFlow.details.csrf },
  });
  assert.equal(continued.statusCode, 403);
  assert.equal(continued.json().error.code, "MFA_REQUIRED");
  const passwordOnly = await browser().request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password },
  });
  assert.equal(passwordOnly.statusCode, 403);
  assert.equal(passwordOnly.json().error.code, "MFA_ENROLLMENT_REQUIRED");
  await db.query("UPDATE users SET mfa_secret=$2 WHERE id=$1", [
    member,
    encrypt("JBSWY3DPEHPK3PXP"),
  ]);
  const staffBrowser = browser();
  const signed = await staffBrowser.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password, code: await factor(member) },
  });
  assert.equal(signed.statusCode, 200, signed.body);
  const freshFlow = await authorization("member", 3, staffBrowser),
    staffToken = await complete(freshFlow, true);
  const claims = (await inspect(staffToken.token, 3)).json();
  assert.equal(claims.active, true);
  assert.equal(claims.onesa_product_roles.mobile, "operations");
  assert.ok(claims.amr.includes("otp"));
  await db.query(
    "UPDATE identity_product_access SET status='revoked',revision=revision+1 WHERE user_id=$1 AND product='mobile'",
    [member],
  );
  assert.equal((await inspect(staffToken.token, 3)).json().active, false);
});

test("Mobile product roles remain scoped in administration and the database", async () => {
  const administrator = await signIn("admin");
  const request = (selected: string, role: string, revision = 0) =>
    administrator.request({
      method: "PUT",
      url:
        "/api/v1/admin/identity/accounts/" + member + "/products/" + selected,
      headers: { "x-csrf-token": administrator.session.csrf },
      payload: {
        role,
        status: "active",
        expectedRevision: revision,
        memberships: [],
        stepUp: { password, code: "not-a-valid-factor" },
      },
    });
  for (const [selected, role] of [
    ["ai", "finance"],
    ["drone", "customer"],
    ["robot", "support"],
    ["mobile", "operator"],
  ]) {
    const rejected = await request(selected, role);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, "PRODUCT_ROLE");
  }
  const approved = await administrator.request({
    method: "PUT",
    url: "/api/v1/admin/identity/accounts/" + member + "/products/mobile",
    headers: { "x-csrf-token": administrator.session.csrf },
    payload: {
      role: "finance",
      status: "active",
      expectedRevision: 0,
      memberships: [],
      stepUp: { password, code: await factor(admin) },
    },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  for (const role of [
    "admin",
    "operations",
    "support",
    "finance",
    "agent",
    "auditor",
    "customer",
  ])
    await db.query(
      "UPDATE identity_product_access SET role=$2 WHERE user_id=$1 AND product='mobile'",
      [member, role],
    );
  await assert.rejects(
    db.query(
      "UPDATE identity_product_access SET role='viewer' WHERE user_id=$1 AND product='mobile'",
      [member],
    ),
    /violates check constraint/,
  );
  await assert.rejects(
    db.query(
      "UPDATE identity_product_access SET role='customer' WHERE user_id=$1 AND product='ai'",
      [member],
    ),
    /violates check constraint/,
  );
});

test("An unconfigured Mobile client does not enable registration, access requests or authorization", async () => {
  const saved = process.env.ONESA_IDENTITY_CONFIG_B64;
  process.env.ONESA_IDENTITY_CONFIG_B64 = Buffer.from(
    JSON.stringify({ ...config, clients: config.clients.slice(0, 3) }),
  ).toString("base64");
  let legacyApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacyApp = await buildApp({ logging: false });
    await legacyApp.ready();
    const settings = await legacyApp.inject({
      url: "/api/v1/account/config",
      headers: proxy,
    });
    assert.equal(settings.json().applications.length, 3);
    const registration = await legacyApp.inject({
      method: "POST",
      url: "/api/v1/account/register",
      headers: { ...proxy, origin },
      payload: {
        email: "mobile-unconfigured@example.invalid",
        name: "Synthetic",
        products: ["mobile"],
      },
    });
    assert.equal(registration.statusCode, 503);
    assert.equal(registration.json().error.code, "PRODUCT_UNAVAILABLE");
    const request = await legacyApp.inject({
      method: "POST",
      url: "/api/v1/account/products/mobile/request",
      headers: { ...proxy, origin },
      payload: {},
    });
    assert.equal(request.statusCode, 503);
    const authorization = await legacyApp.inject({
      url:
        "/api/v1/identity/auth?" +
        new URLSearchParams({
          client_id: config.clients[3].clientId,
          redirect_uri: config.clients[3].redirectUri,
          response_type: "code",
          scope: "openid",
          code_challenge_method: "S256",
          code_challenge: randomBytes(32).toString("base64url"),
        }),
      headers: proxy,
    });
    assert.equal(authorization.statusCode, 400);
  } finally {
    await legacyApp?.close();
    process.env.ONESA_IDENTITY_CONFIG_B64 = saved;
  }
});

test("A deletion request belongs to the verified session and concurrent retries queue one privacy case", async () => {
  const url = "/api/v1/account/deletion-requests";
  const input = { method: "POST" as const, url, payload: { confirmed: true } };
  assert.equal((await browser().request(input)).statusCode, 401);
  const client = await signIn();
  assert.equal((await client.request(input)).statusCode, 403);
  const headers = { "x-csrf-token": client.session.csrf };
  assert.equal(
    (await client.request({ ...input, headers, payload: { confirmed: false } }))
      .statusCode,
    400,
  );
  const offOrigin = await client.request({
    ...input,
    headers: { ...headers, origin: "https://foreign.example.invalid" },
  });
  assert.equal(offOrigin.statusCode, 403);
  const replies = await Promise.all([
    client.request({ ...input, headers }),
    client.request({ ...input, headers }),
  ]);
  for (const reply of replies) assert.equal(reply.statusCode, 202);
  const id = replies[0].json().reference;
  assert.match(id, /^[a-f\d-]{36}$/);
  assert.equal(replies[1].json().reference, id);
  const jobs = (
    await db.query(
      "SELECT payload FROM jobs WHERE dedupe_key LIKE 'identity-deletion-request:%'",
    )
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.text, undefined);
  assert.ok(decrypt(jobs[0].payload.encryptedText).includes(member));
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit WHERE action='identity.deletion_requested' AND actor_id=$1 AND record_id=$2",
        [member, id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await client.request({ url: "/api/v1/account/me" })).statusCode,
    200,
  );
});
async function enableDroneOperator() {
  await db.query(
    "INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'drone','operator','active')",
    [member],
  );
  const tenant = randomUUID();
  await db.query(
    "INSERT INTO identity_drone_memberships VALUES($1,$2,'operator','Simulation only')",
    [member, tenant],
  );
  return tenant;
}
test("Drone password recovery ends live grants, preserves the subject and workspace, and consumes the email link once", async () => {
  const tenant = await enableDroneOperator();
  const flow = await authorization("member", 1);
  const { token } = await complete(flow);
  const previous = (await inspect(token, 1)).json();
  assert.equal(previous.active, true);
  assert.equal(previous.sub, member);
  assert.deepEqual(previous.onesa_memberships, [
    { product: "drone", tenant_id: tenant, role: "operator" },
  ]);
  const client = browser();
  assert.equal(
    (
      await client.request({
        method: "POST",
        url: "/api/v1/account/password/request",
        payload: { email: emails.member },
      })
    ).statusCode,
    202,
  );
  const { payload } = (
    await db.query("SELECT payload FROM jobs WHERE payload->>'to'=$1", [
      emails.member,
    ])
  ).rows[0];
  const secret = decrypt(payload.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )?.[1];
  assert.ok(secret);
  const newPassword = randomBytes(36).toString("base64url");
  const reset = () =>
    client.request({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: secret, password: newPassword },
    });
  assert.equal((await reset()).statusCode, 200);
  assert.equal((await reset()).statusCode, 400);
  assert.deepEqual((await inspect(token, 1)).json(), { active: false });
  const old = await client.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password },
  });
  assert.equal(old.statusCode, 401);
  const fresh = await client.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: emails.member, password: newPassword },
  });
  assert.equal(fresh.statusCode, 200);
  const { token: newToken } = await complete(
    await authorization("member", 1, client),
    true,
  );
  const now = (await inspect(newToken, 1)).json();
  assert.equal(now.active, true);
  assert.equal(now.sub, member);
  assert.deepEqual(now.onesa_memberships, previous.onesa_memberships);
});
test("An expired central account session invalidates the issued Drone grant", async () => {
  await enableDroneOperator();
  const { token } = await complete(await authorization("member", 1));
  assert.equal((await inspect(token, 1)).json().active, true);
  await db.query(
    "UPDATE identity_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [member],
  );
  assert.deepEqual((await inspect(token, 1)).json(), { active: false });
});

test("An administrator can disable and restore an ordinary member with fresh MFA and retained Drone assignments", async () => {
  const tenant = await enableDroneOperator();
  const { token } = await complete(await authorization("member", 1));
  const staff = await signIn("admin");
  const url = "/api/v1/admin/identity/accounts/" + member + "/member-status";
  const headers = { "x-csrf-token": staff.session.csrf };
  const fresh = async () => ({ password, code: await factor(admin) });
  const setStatus = async (disabled: boolean) =>
    staff.request({
      method: "PUT",
      url,
      headers,
      payload: { disabled, stepUp: await fresh() },
    });
  const ordinary = await signIn("member");
  assert.equal(
    (
      await ordinary.request({
        method: "PUT",
        url,
        headers: { "x-csrf-token": ordinary.session.csrf },
        payload: { disabled: true, stepUp: await fresh() },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await staff.request({
        method: "PUT",
        url,
        headers,
        payload: { disabled: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await staff.request({
        method: "PUT",
        url,
        headers,
        payload: { disabled: true, stepUp: { password, code: "invalid" } },
      })
    ).statusCode,
    403,
  );
  assert.equal((await setStatus(true)).statusCode, 200);
  assert.deepEqual((await inspect(token, 1)).json(), { active: false });
  assert.equal(
    (await ordinary.request({ url: "/api/v1/account/me" })).statusCode,
    401,
  );
  assert.equal(
    (
      await browser().request({
        method: "POST",
        url: "/api/v1/account/login",
        payload: { email: emails.member, password },
      })
    ).statusCode,
    401,
  );
  const directory = await staff.request({
    url:
      "/api/v1/admin/identity/accounts?search=" +
      encodeURIComponent(emails.member),
  });
  assert.equal(directory.json().items[0].disabled, true);
  const protectedStaff = await staff.request({
    method: "PUT",
    url: url.replace(member, owner),
    headers,
    payload: { disabled: true, stepUp: await fresh() },
  });
  assert.equal(protectedStaff.statusCode, 409);
  assert.equal((await setStatus(false)).statusCode, 200);
  assert.deepEqual((await inspect(token, 1)).json(), { active: false });
  const { token: newToken } = await complete(await authorization("member", 1));
  const restored = (await inspect(newToken, 1)).json();
  assert.equal(restored.sub, member);
  assert.deepEqual(restored.onesa_roles, []);
  assert.equal(restored.onesa_product_roles.drone, "operator");
  assert.deepEqual(restored.onesa_memberships, [
    { product: "drone", tenant_id: tenant, role: "operator" },
  ]);
});

test("Farmer admits verified Portal staff and approved customers, and enforces later revocation", async () => {
  const farmer = config.clients.findIndex((client) => client.product === "farmer");
  const first = await signIn("member");
  const requested = await first.request({
    method: "POST", url: "/api/v1/account/products/farmer/request",
    headers: {"x-csrf-token": first.session.csrf}, payload: {},
  });
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().access.find((grant: {product: string}) => grant.product === "farmer").status, "pending");
  const waiting = await authorization("member", farmer, first);
  const denied = await waiting.request({method: "POST", url: "/api/v1/account/interaction/" + waiting.uid + "/continue", payload: {csrf: waiting.details.csrf}});
  assert.equal(denied.statusCode, 403);

  const reviewer = await signIn("admin");
  const decision = async (id: string, status: "active" | "revoked", revision: number) => {
    const result = await reviewer.request({
      method: "PUT", url: "/api/v1/admin/identity/accounts/" + id + "/products/farmer",
      headers: {"x-csrf-token": reviewer.session.csrf},
      payload: {role: "user", status, expectedRevision: revision, memberships: [],
        stepUp: {password, code: await factor(admin)}},
    });
    assert.equal(result.statusCode, 200, result.body);
  };
  await decision(member, "active", 1);
  const grant = await complete(await authorization("member", farmer, first), true);
  const claims = (await inspect(grant.token, farmer)).json();
  assert.deepEqual(claims.onesa_product_roles, {farmer: "user"});
  assert.deepEqual(claims.onesa_applications, ["farmer"]);
  assert.deepEqual(claims.onesa_roles, []);
  assert.deepEqual(claims.onesa_memberships, []);

  await db.query("UPDATE users SET role='viewer',mfa_secret=$2 WHERE id=$1", [outsider, encrypt("JBSWY3DPEHPK3PXP")]);
  const staffBrowser = browser();
  const login = await staffBrowser.request({method:"POST", url:"/api/v1/account/login",
    payload: {email: emails.outsider, password, code: await factor(outsider)}});
  assert.equal(login.statusCode, 200, login.body);
  const staff = await complete(await authorization("outsider", farmer, staffBrowser), true);
  assert.deepEqual((await inspect(staff.token, farmer)).json().onesa_product_roles, {farmer: "user"});
  await decision(outsider, "revoked", 0);
  await decision(member, "revoked", 2);
  assert.deepEqual((await inspect(staff.token, farmer)).json(), {active: false});
  assert.deepEqual((await inspect(grant.token, farmer)).json(), {active: false});
});

test("Farmer asks the same browser to authenticate again when its original Portal session expires", async () => {
  const farmer = config.clients.findIndex((client) => client.product === "farmer");
  await db.query("INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'farmer','user','active')", [member]);
  const client = browser();
  const first = await complete(await authorization("member", farmer, client));
  assert.equal((await inspect(first.token, farmer)).json().active, true);
  const expired = await db.query("UPDATE identity_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [member]);
  assert.equal(expired.rowCount, 1);
  assert.equal((await inspect(first.token, farmer)).json().active, false);
  const retry = await authorization("member", farmer, client);
  assert.equal(retry.details.account, null);
  const fresh = await complete(retry);
  const identity = (await inspect(fresh.token, farmer)).json();
  assert.equal(identity.active, true);
  assert.equal(identity.sub, member);
  assert.equal((await inspect(first.token, farmer)).json().active, false);
  await db.query("UPDATE identity_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [member]);
  const reviewer = await signIn("admin");
  const revoked = await reviewer.request({
    method: "PUT", url: "/api/v1/admin/identity/accounts/" + member + "/products/farmer",
    headers: {"x-csrf-token": reviewer.session.csrf},
    payload: {role: "user", status: "revoked", expectedRevision: 1, memberships: [],
      stepUp: {password, code: await factor(admin)}},
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await inspect(fresh.token, farmer)).json().active, false);
  const denied = await authorization("member", farmer, client);
  const attempt = await denied.request({
    method: "POST", url: "/api/v1/account/interaction/" + denied.uid + "/login",
    payload: {csrf: denied.details.csrf, email: emails.member, password},
  });
  assert.equal(attempt.statusCode, 403, attempt.body);
  assert.equal(attempt.json().error.code, "PRODUCT_ACCESS_REQUIRED");
});

test("Cancelling Farmer sign-in returns the original state without issuing a grant", async () => {
  const farmer = config.clients.findIndex((client) => client.product === "farmer");
  const flow = await authorization("member", farmer);
  const url = "/api/v1/account/interaction/" + flow.uid + "/cancel";
  assert.equal((await flow.request({method:"POST", url, payload:{csrf: "0".repeat(64)}})).statusCode, 403);
  const cancelled = await flow.request({method:"POST", url, payload:{csrf:flow.details.csrf}});
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  const resumed = await flow.request({url:cancelled.json().continuePath});
  assert.equal(resumed.statusCode, 303, resumed.body);
  const callback = new URL(String(resumed.headers.location));
  assert.equal(callback.origin + callback.pathname, config.clients[farmer].redirectUri);
  assert.equal(callback.searchParams.get("state"), flow.state);
  assert.equal(callback.searchParams.get("error"), "access_denied");
  assert.equal(callback.searchParams.has("code"), false);
  assert.equal((await db.query("SELECT count(*) FROM identity_grant_sessions")).rows[0].count, "0");
});

test("A real HTTPS cookie jar carries an administrator's signed interaction through the account API", async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "onesa-cookie-path-"));
  try {
    const { hostname } = new URL(origin);
    const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=" + hostname, "-addext", "subjectAltName=DNS:" + hostname,
      "-keyout", key, "-out", cert]);
    const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
      // The public TLS listener supplies the same private header as Portal's proxy.
      req.headers["x-portal-proxy-key"] = proxy["x-portal-proxy-key"];
      app.server.emit("request", req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      const jar = join(directory, "cookies"), body = join(directory, "response");
      async function request(path: string, input?: Record<string, string>) {
        const { stdout } = await run("curl", ["--silent", "--show-error", "--max-time", "10",
          "--noproxy", "*", "--connect-to", hostname + ":443:127.0.0.1:" + port,
          "--cacert", cert, "--cookie", jar, "--cookie-jar", jar, "--output", body,
          "--write-out", "%{response_code}\n%{redirect_url}",
          ...(input ? ["--header", "Origin: " + origin, "--header", "Content-Type: application/json",
                       "--data-binary", JSON.stringify(input)] : []), origin + path]);
        const [status, location] = stdout.split("\n");
        return { status: Number(status), location, json: async () => JSON.parse(await readFile(body, "utf8")) };
      }
      for (const existingSession of [false, true]) {
        const client = config.clients[existingSession ? 1 : 2], state = randomBytes(32).toString("base64url");
        const params = new URLSearchParams({
          client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code",
          scope: "openid email profile onesa", state, nonce: randomBytes(32).toString("base64url"),
          code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"), code_challenge_method: "S256",
        });
        const start = await request("/api/v1/identity/auth?" + params);
        assert.equal(start.status, 303);
        const form = new URL(start.location);
        assert.equal(form.origin, origin, existingSession ? "second product" : "first product");
        assert.match(form.pathname, /^\/account\/sign-in\/[A-Za-z0-9_-]+$/);
        const uid = form.pathname.split("/").pop()!;
        const interaction = "/api/v1/account/interaction/" + uid;
        const details = await request(interaction);
        assert.equal(details.status, 200);
        const account = await details.json();
        if (existingSession) assert.equal(account.account?.email, emails.admin);
        const submitted = existingSession
          ? await request(interaction + "/continue", { csrf: account.csrf })
          : await request(interaction + "/login", { csrf: account.csrf, email: emails.admin, password, code: await factor(admin) });
        assert.equal(submitted.status, 200);
        const resume = (await submitted.json()).continuePath;
        assert.match(resume, /^\/api\/v1\/identity\/auth\/[A-Za-z0-9_-]+$/);
        const result = await request(resume);
        assert.equal(result.status, 303);
        const callback = new URL(result.location);
        assert.equal(callback.origin + callback.pathname, client.redirectUri);
        assert.equal(callback.searchParams.get("state"), state);
        assert.ok(callback.searchParams.get("code"));
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [product, role] of [["logistics", "user"], ["pasofi", "customer"], ["factory", "user"]] as const) {
  test(`${product} customers need explicit approval, receive only their own role and lose access on revocation`, async () => {
    const index = config.clients.findIndex(client => client.product === product);
    const customer = await signIn("member");
    const requested = await customer.request({method: "POST", url: `/api/v1/account/products/${product}/request`, headers: {"x-csrf-token": customer.session.csrf}, payload: {}});
    assert.equal(requested.statusCode, 200, requested.body);
    assert.equal(requested.json().access.find((grant: {product: string}) => grant.product === product).status, "pending");
    const pending = await authorization("member", index, customer);
    assert.equal((await pending.request({method: "POST", url: `/api/v1/account/interaction/${pending.uid}/continue`, payload: {csrf: pending.details.csrf}})).statusCode, 403);
    const administrator = await signIn("admin");
    async function decision(status: "active" | "revoked", revision: number, selectedRole: string = role) {
      return administrator.request({method: "PUT", url: `/api/v1/admin/identity/accounts/${member}/products/${product}`, headers: {"x-csrf-token": administrator.session.csrf}, payload: {role: selectedRole, status, expectedRevision: revision, memberships: [], stepUp: {password, code: await factor(admin)}}});
    }
    assert.equal((await decision("active", 1, "admin")).statusCode, 400, "An ordinary product grant cannot grant global administration");
    const approved = await decision("active", 1);
    assert.equal(approved.statusCode, 200, approved.body);
    const grant = await complete(await authorization("member", index, customer), true);
    const claims = (await inspect(grant.token, index)).json();
    assert.equal(claims.active, true);
    assert.equal(claims.sub, member);
    assert.deepEqual(claims.onesa_roles, []);
    assert.deepEqual(claims.onesa_product_roles, {[product]: role});
    assert.deepEqual(claims.onesa_applications, [product]);
    assert.deepEqual(claims.onesa_memberships, []);
    const repeated = await complete(await authorization("member", index));
    assert.equal((await inspect(repeated.token, index)).json().sub, member);
    assert.equal((await decision("revoked", 2)).statusCode, 200);
    assert.equal((await inspect(repeated.token, index)).json().active, false);
  });
}

for (const [index, clientConfig] of config.clients.entries()) {
  test(`An expired Portal session requires fresh administrator authentication for ${clientConfig.product}`, async () => {
    const client = browser();
    const original = await complete(await authorization("admin", index, client));
    assert.equal((await inspect(original.token, index)).json().active, true);

    await db.query("UPDATE identity_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [admin]);
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [admin]);
    assert.equal((await inspect(original.token, index)).json().active, false);

    const login = await authorization("admin", index, client);
    assert.equal(login.details.account, null);
    const renewed = await complete(login);
    const claims = (await inspect(renewed.token, index)).json();
    assert.equal(claims.active, true);
    assert.equal(claims.sub, admin);
    assert.ok(claims.amr.includes("otp"));
    assert.equal((await inspect(original.token, index)).json().active, false);
  });
}
