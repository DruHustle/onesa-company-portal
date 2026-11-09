import "./local-environment.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";

if (!process.env.TEST_DATABASE_URL)
  throw Error("Isolated loopback test database required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_KEY = randomBytes(32).toString("hex");
process.env.PUBLIC_ORIGIN = "https://portal.example.invalid";
process.env.PROXY_SHARED_KEY = randomBytes(32).toString("hex");
const origin = process.env.PUBLIC_ORIGIN;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = {
  keys: [
    {
      ...key.privateKey.export({ format: "jwk" }),
      kid: "synthetic_link_key",
      alg: "RS256",
      use: "sig",
    },
  ],
};
const docs = {
  issuer: origin + "/api/v1/engineering-identity",
  clientId: "synthetic_engineering_client",
  clientSecret: randomBytes(48).toString("hex"),
  redirectUri:
    "https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/callback",
  cookieKeys: [randomBytes(48).toString("hex")],
  externalEmails: [],
  jwks,
};
process.env.ENGINEERING_IDENTITY_ENABLED = "true";
process.env.ENGINEERING_OIDC_CONFIG_B64 = Buffer.from(
  JSON.stringify(docs),
).toString("base64");
process.env.ONESA_IDENTITY_ENABLED = "true";
process.env.ONESA_IDENTITY_CONFIG_B64 = Buffer.from(
  JSON.stringify({
    issuer: origin + "/api/v1/identity",
    cookieKeys: [randomBytes(48).toString("hex")],
    jwks,
    clients: [
      {
        product: "robot",
        clientId: "synthetic_robot_client",
        clientSecret: randomBytes(48).toString("hex"),
        redirectUri: "https://robot.example.invalid/auth/onesa/callback",
        applicationUrl: "https://robot.example.invalid",
      },
    ],
  }),
).toString("base64");
const { db } = await import("../src/services/db.js");
const { migrate } = await import("../src/services/migrate.js");
const { buildApp } = await import("../src/app.js");
const { passwordHash, hash, decrypt, encrypt } =
  await import("../src/auth/crypto.js");
const { EngineeringIdentityAdapter } =
  await import("../src/engineering/adapter.js");
const { engineeringHandoffCookie } =
  await import("../src/engineering/link-handoff.js");
const app = await buildApp({ logging: false });
const owner = randomUUID(),
  password = "Synthetic central account password",
  docsPassword = "Different synthetic Engineering password";
before(async () => {
  await migrate();
  await db.query(
    "TRUNCATE users,audit,rate_limits,engineering_memberships,jobs CASCADE",
  );
  await db.query(
    "INSERT INTO users(id,email,password_hash,role) VALUES($1,'fixture-owner@example.invalid',$2,'owner')",
    [owner, passwordHash(password)],
  );
  await app.ready();
});
after(async () => {
  await app.close();
  await db.end();
});
let address = 0;
function browser(cookies?: Map<string, string>) {
  const jar = new Map(cookies),
    remoteAddress = "2001:db8::" + (++address).toString(16);
  const request = async (input: InjectOptions) => {
    const result = await app.inject({
      ...input,
      remoteAddress,
      headers: {
        "x-portal-proxy-key": process.env.PROXY_SHARED_KEY!,
        cookie: [...jar].map(([name, value]) => name + "=" + value).join("; "),
        ...(input.method === "POST" ? { origin } : {}),
        ...input.headers,
      },
    });
    for (const cookie of result.cookies) jar.set(cookie.name, cookie.value);
    return result;
  };
  return { jar, request };
}
async function fixture(name: string, role = "member", enabled = true) {
  const id = randomUUID(),
    membership = randomUUID(),
    email = name + "@onesa.eu";
  await db.query(
    "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)",
    [id, email, passwordHash(password), role],
  );
  await db.query(
    "INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,$2,now())",
    [id, name],
  );
  await db.query(
    "INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,$2,$3,'Synthetic exact-email approval retained',$4)",
    [membership, email, enabled, owner],
  );
  await db.query(
    "INSERT INTO engineering_credentials(membership_id,password_hash) VALUES($1,$2)",
    [membership, passwordHash(docsPassword)],
  );
  return { id, membership, email };
}
async function signIn(
  identity: Awaited<ReturnType<typeof fixture>>,
  client = browser(),
  code = "",
) {
  const result = await client.request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: identity.email, password, code },
  });
  assert.equal(result.statusCode, 200, result.body);
  return { ...client, account: result.json() };
}
async function authorization(
  client = browser(),
  extra: Record<string, string> = {},
) {
  const verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(24).toString("hex");
  const result = await client.request({
    url:
      "/api/v1/engineering-identity/auth?" +
      new URLSearchParams({
        client_id: docs.clientId,
        redirect_uri: docs.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce: randomBytes(24).toString("hex"),
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        ...extra,
      }),
  });
  assert.equal(result.statusCode, 303, result.body);
  const location = new URL(String(result.headers.location));
  assert.match(location.pathname, /^\/engineering\/sign-in\/[A-Za-z0-9_-]+$/);
  const uid = location.pathname.split("/").pop()!;
  const response = await client.request({
    url: "/api/v1/engineering-sign-in/" + uid + "/details",
  });
  assert.equal(response.statusCode, 200, response.body);
  return { ...client, uid, verifier, state, details: response.json() };
}
type Flow = Awaited<ReturnType<typeof authorization>>;
const submit = (
  flow: Flow,
  action: string,
  input: Record<string, unknown> = {},
) =>
  flow.request({
    method: "POST",
    url: "/api/v1/engineering-sign-in/" + flow.uid + "/" + action,
    payload: { csrf: flow.details.csrf, ...input },
  });
async function exchange(flow: Flow, continuePath: string) {
  const resumed = await flow.request({ url: continuePath });
  assert.equal(resumed.statusCode, 303, resumed.body);
  const callback = new URL(String(resumed.headers.location));
  assert.equal(callback.origin + callback.pathname, docs.redirectUri);
  assert.equal(callback.searchParams.get("state"), flow.state);
  assert.ok(callback.searchParams.get("code"));
  return app.inject({
    method: "POST",
    url: "/api/v1/engineering-identity/token",
    headers: {
      "x-portal-proxy-key": process.env.PROXY_SHARED_KEY!,
      authorization:
        "Basic " +
        Buffer.from(docs.clientId + ":" + docs.clientSecret).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: docs.redirectUri,
      code_verifier: flow.verifier,
    }).toString(),
  });
}
async function linkWithPassword(identity: Awaited<ReturnType<typeof fixture>>) {
  const signed = await signIn(identity),
    flow = await authorization(signed);
  const linked = await submit(flow, "password", {
    email: identity.email,
    password: docsPassword,
    linkOnesaAccount: true,
  });
  assert.equal(linked.statusCode, 200, linked.body);
  return { signed, flow, linked };
}

test("catalog recognition cannot commission future applications or grant their access", async () => {
  const response = await app.inject({ url: "/api/v1/account/config" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().applications, [
    { product: "robot", url: "https://robot.example.invalid" },
  ]);
  const catalog = response.json().catalog;
  assert.deepEqual(
    catalog
      .filter((entry: { connected: boolean }) => entry.connected)
      .map((entry: { product: string }) => entry.product),
    ["robot"],
  );
  assert.deepEqual(
    catalog.map((entry: { product: string }) => entry.product),
    [
      "ai",
      "drone",
      "robot",
      "farmer",
      "logistics",
      "factory",
      "pasofi",
      "mobile",
    ],
  );
  const counts = () =>
    db.query(
      "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM identity_registration_links) AS links, (SELECT count(*) FROM identity_product_access) AS access, (SELECT count(*) FROM jobs) AS jobs",
    );
  const before = (await counts()).rows;
  for (const [product, status] of [
    ["farmer", 400],
    ["logistics", 400],
    ["factory", 400],
    ["pasofi", 400],
    // Mobile has a published vocabulary, but this fixed-client registry does not
    // commission it. Preserve its existing unavailable-client contract.
    ["mobile", 503],
  ] as const) {
    const result = await browser().request({
      method: "POST",
      url: "/api/v1/account/register",
      payload: {
        name: "Synthetic future",
        email: product + "@example.invalid",
        products: [product],
      },
    });
    assert.equal(result.statusCode, status, product + ": " + result.body);
    if (product === "mobile")
      assert.equal(result.json().error.code, "PRODUCT_UNAVAILABLE");
  }
  assert.deepEqual((await counts()).rows, before);
});

test("linking is explicit, requires both passwords' authorities, and preserves identity and approval records", async () => {
  const identity = await fixture("dual-proof"),
    signed = await signIn(identity),
    flow = await authorization(signed);
  const before = (
    await db.query(
      "SELECT row(u.id,u.password_hash,u.role,u.mfa_secret,m.id,m.enabled,m.access_policy_evidence,m.approved_by,m.approved_at,m.revision,c.password_hash)::text AS evidence FROM users u JOIN engineering_memberships m ON m.email=u.email JOIN engineering_credentials c ON c.membership_id=m.id WHERE u.id=$1",
      [identity.id],
    )
  ).rows[0].evidence;
  assert.equal(flow.details.onesaAccount, undefined);
  assert.deepEqual(flow.details.onesaLink, { email: identity.email });
  assert.equal(
    flow.details.onesaSignInPath,
    "/account?returnTo=" +
      encodeURIComponent("/engineering/sign-in/" + flow.uid),
  );
  assert.equal(
    (
      await submit(flow, "password", {
        email: identity.email,
        password,
        linkOnesaAccount: true,
      })
    ).statusCode,
    401,
  );
  const ordinary = await submit(flow, "password", {
    email: identity.email,
    password: docsPassword,
  });
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM identity_engineering_links WHERE user_id=$1",
        [identity.id],
      )
    ).rows[0].n,
    0,
  );
  const next = await authorization(browser(signed.jar));
  const linked = await submit(next, "password", {
    email: identity.email,
    password: docsPassword,
    linkOnesaAccount: true,
  });
  assert.equal(linked.statusCode, 200, linked.body);
  const token = await exchange(next, linked.json().continuePath);
  assert.equal(token.statusCode, 200, token.body);
  const [head, payload, signature] = token.json().id_token.split(".");
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(head + "." + payload),
      key.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.equal(
    JSON.parse(Buffer.from(payload, "base64url").toString()).sub,
    identity.membership,
  );
  const after = (
    await db.query(
      "SELECT row(u.id,u.password_hash,u.role,u.mfa_secret,m.id,m.enabled,m.access_policy_evidence,m.approved_by,m.approved_at,m.revision,c.password_hash)::text AS evidence FROM users u JOIN engineering_memberships m ON m.email=u.email JOIN engineering_credentials c ON c.membership_id=m.id WHERE u.id=$1",
      [identity.id],
    )
  ).rows[0].evidence;
  assert.equal(after, before);
  const sources = (
    await db.query("SELECT amr FROM identity_grant_sessions WHERE user_id=$1", [
      identity.id,
    ])
  ).rows;
  assert.ok(sources.length > 0);
  assert.ok(
    sources.every((source) => JSON.stringify(source.amr) === '["pwd"]'),
    "a normal account session is not relabeled as MFA",
  );
  const centralOnly = browser(
    new Map([["onesa_account", signed.jar.get("onesa_account")!]]),
  );
  const reused = await authorization(centralOnly);
  assert.deepEqual(reused.details.onesaAccount, { email: identity.email });
  assert.equal(reused.details.onesaLink, undefined);
  const continued = await submit(reused, "session");
  assert.equal(continued.statusCode, 200, continued.body);
  assert.equal(
    (await exchange(reused, continued.json().continuePath)).statusCode,
    200,
  );
  const alone = await authorization();
  const refused = await submit(alone, "password", {
    email: identity.email,
    password: docsPassword,
  });
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.json().error.code, "ONESA_SESSION_REQUIRED");
  const enabled = process.env.ONESA_IDENTITY_ENABLED;
  process.env.ONESA_IDENTITY_ENABLED = "false";
  try {
    const fallback = await authorization();
    assert.equal(fallback.details.onesaAccount, undefined);
    assert.equal(fallback.details.onesaSignInPath, undefined);
    const blocked = await submit(fallback, "password", {
      email: identity.email,
      password: docsPassword,
    });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.code, "IDENTITY_UNAVAILABLE");
  } finally {
    process.env.ONESA_IDENTITY_ENABLED = enabled;
  }
});

test("same email without a central session, wrong account and an immutable collision cannot link", async () => {
  const target = await fixture("collision-target"),
    other = await fixture("collision-other");
  const anonymous = await authorization();
  assert.equal(
    (
      await submit(anonymous, "password", {
        email: target.email,
        password: docsPassword,
        linkOnesaAccount: true,
      })
    ).statusCode,
    401,
  );
  const wrong = await authorization(await signIn(other));
  assert.equal(
    (
      await submit(wrong, "password", {
        email: target.email,
        password: docsPassword,
        linkOnesaAccount: true,
      })
    ).statusCode,
    403,
  );
  await linkWithPassword(target);
  await db.query(
    "UPDATE users SET email='former-collision-target@onesa.eu' WHERE id=$1",
    [target.id],
  );
  await db.query("UPDATE users SET email=$1 WHERE id=$2", [
    target.email,
    other.id,
  ]);
  const replacement = await authorization(
    await signIn({ ...other, email: target.email }),
  );
  assert.equal(replacement.details.onesaLink, undefined);
  const collision = await submit(replacement, "password", {
    email: target.email,
    password: docsPassword,
    linkOnesaAccount: true,
  });
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error.code, "ENGINEERING_ACCOUNT_CONFLICT");
  assert.equal(
    (
      await db.query(
        "SELECT user_id FROM identity_engineering_links WHERE membership_id=$1",
        [target.membership],
      )
    ).rows[0].user_id,
    target.id,
  );
  await assert.rejects(
    db.query(
      "UPDATE identity_engineering_links SET user_id=$1 WHERE membership_id=$2",
      [other.id, target.membership],
    ),
    /cannot be reassigned/,
  );
  await assert.rejects(db.query("DELETE FROM users WHERE id=$1", [target.id]), {
    code: "23503",
  });
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM users u JOIN identity_engineering_links l ON l.user_id=u.id JOIN engineering_memberships m ON m.id=l.membership_id WHERE u.id=$1",
        [target.id],
      )
    ).rows[0].n,
    1,
  );
});

test("approved mail proof links once under concurrency and failed account proof does not consume it", async () => {
  const identity = await fixture("email-link"),
    wrongIdentity = await fixture("email-wrong");
  const flow = await authorization(await signIn(wrongIdentity));
  assert.equal(
    (await submit(flow, "link", { email: identity.email })).statusCode,
    200,
  );
  const job = (
    await db.query(
      "SELECT payload FROM jobs WHERE payload->>'to'=$1 ORDER BY created_at DESC LIMIT 1",
      [identity.email],
    )
  ).rows[0];
  const raw = decrypt(job.payload.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )?.[1];
  assert.ok(raw);
  assert.equal(
    (await submit(flow, "link-verify", { token: raw, linkOnesaAccount: true }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await db.query(
        "SELECT consumed_at FROM access_links WHERE token_hash=$1",
        [hash(raw)],
      )
    ).rows[0].consumed_at,
    null,
  );
  await signIn(identity, flow);
  const attempts = await Promise.all(
    [1, 2].map(() =>
      submit(flow, "link-verify", { token: raw, linkOnesaAccount: true }),
    ),
  );
  assert.deepEqual(
    attempts.map((result) => result.statusCode).sort(),
    [200, 401],
  );
  const linked = attempts.find((result) => result.statusCode === 200)!;
  assert.equal(
    (await submit(flow, "link-verify", { token: raw, linkOnesaAccount: true }))
      .statusCode,
    401,
  );
  assert.equal(
    (await exchange(flow, linked.json().continuePath)).statusCode,
    200,
  );
});

test("cross-browser email handoff survives central-login recovery without extending or consuming its proof", async () => {
  const identity = await fixture("handoff-link"),
    original = await authorization();
  assert.equal(
    (await submit(original, "link", { email: identity.email })).statusCode,
    200,
  );
  const job = (
    await db.query(
      "SELECT payload FROM jobs WHERE payload->>'to'=$1 ORDER BY created_at DESC LIMIT 1",
      [identity.email],
    )
  ).rows[0];
  const token = decrypt(job.payload.encryptedText).match(
    /#access-link=([a-f0-9]{64})/,
  )?.[1];
  assert.ok(token);
  const receiving = browser();
  const prepared = await receiving.request({
    method: "POST",
    url: "/api/v1/engineering-sign-in/" + original.uid + "/link-prepare",
    payload: { token },
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const handoff = receiving.jar.get(engineeringHandoffCookie);
  assert.ok(handoff);
  const flow = await authorization(receiving);
  assert.equal(flow.details.linkEmail, identity.email);
  const missing = await submit(flow, "handoff-verify", {
    linkOnesaAccount: true,
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error.code, "ONESA_SESSION_REQUIRED");
  assert.equal(
    flow.jar.get(engineeringHandoffCookie),
    handoff,
    "auth recovery does not clear or renew the original five-minute cookie",
  );
  assert.equal(
    (
      await db.query(
        "SELECT consumed_at FROM access_links WHERE token_hash=$1",
        [hash(token)],
      )
    ).rows[0].consumed_at,
    null,
  );
  await signIn(identity, flow);
  const continued = await submit(flow, "handoff-verify", {
    linkOnesaAccount: true,
  });
  assert.equal(continued.statusCode, 200, continued.body);
  assert.equal(Boolean(flow.jar.get(engineeringHandoffCookie)), false);
  assert.equal(
    (await exchange(flow, continued.json().continuePath)).statusCode,
    200,
  );
  assert.ok(
    (
      await db.query(
        "SELECT consumed_at FROM access_links WHERE token_hash=$1",
        [hash(token)],
      )
    ).rows[0].consumed_at,
  );
});

test("administrator linking retains MFA and cannot bypass an unapproved Engineering identity", async () => {
  const admin = await fixture("admin-no-factor", "administrator");
  const refused = await browser().request({
    method: "POST",
    url: "/api/v1/account/login",
    payload: { email: admin.email, password },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error.code, "MFA_ENROLLMENT_REQUIRED");
  await db.query("UPDATE users SET mfa_secret=$1 WHERE id=$2", [
    encrypt("JBSWY3DPEHPK3PXP"),
    admin.id,
  ]);
  const factor = randomUUID();
  await db.query("INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)", [
    admin.id,
    hash(factor),
  ]);
  const flow = await authorization(await signIn(admin, browser(), factor));
  assert.equal(flow.details.onesaAccount, undefined);
  assert.deepEqual(flow.details.onesaLink, { email: admin.email });
  await db.query(
    "UPDATE engineering_memberships SET enabled=false,revision=revision+1 WHERE id=$1",
    [admin.membership],
  );
  const refusedLink = await submit(flow, "password", {
    email: admin.email,
    password: docsPassword,
    linkOnesaAccount: true,
  });
  assert.equal(refusedLink.statusCode, 401);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM identity_engineering_links WHERE user_id=$1",
        [admin.id],
      )
    ).rows[0].n,
    0,
  );
});

test("global logout invalidates linked issuer artifacts and late writes without claiming to clear Cloudflare cookies", async () => {
  const identity = await fixture("global-logout"),
    { signed, flow, linked } = await linkWithPassword(identity);
  const exchanged = await exchange(flow, linked.json().continuePath);
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const row = (
    await db.query(
      "SELECT id FROM engineering_identity_records WHERE model='Grant' AND account_id=$1",
      [identity.membership],
    )
  ).rows[0];
  const adapter = new EngineeringIdentityAdapter("Grant"),
    saved = await adapter.find(row.id);
  assert.ok(saved);
  const logout = await signed.request({
    method: "POST",
    url: "/api/v1/account/logout",
    headers: { "x-csrf-token": signed.account.csrf },
    payload: {},
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.equal(
    logout.cookies.some((cookie) => cookie.name === "CF_Authorization"),
    false,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM engineering_identity_records WHERE account_id=$1",
        [identity.membership],
      )
    ).rows[0].n,
    0,
  );
  await adapter.upsert(row.id, saved, 60);
  assert.equal(await adapter.find(row.id), undefined);
  const userinfo = await app.inject({
    url: "/api/v1/engineering-identity/me",
    headers: {
      "x-portal-proxy-key": process.env.PROXY_SHARED_KEY!,
      authorization: "Bearer " + exchanged.json().access_token,
    },
  });
  assert.equal(userinfo.statusCode, 401);
  const next = await authorization(
    browser(
      new Map([
        ["onesa_account", signed.jar.get("onesa_account") || "expired"],
      ]),
    ),
  );
  assert.equal(next.details.onesaAccount, undefined);
  assert.equal((await submit(next, "session")).statusCode, 401);
  assert.equal(
    (
      await db.query(
        "SELECT enabled FROM engineering_memberships WHERE id=$1",
        [identity.membership],
      )
    ).rows[0].enabled,
    true,
  );
});

test("forced authentication and disabled central accounts cannot reuse a linked Docs session", async () => {
  const identity = await fixture("fresh-required"),
    { signed } = await linkWithPassword(identity);
  await db.query(
    "UPDATE identity_sessions SET authenticated_at=now()-interval '5 minutes' WHERE user_id=$1",
    [identity.id],
  );
  const fresh = await authorization(
    browser(new Map([["onesa_account", signed.jar.get("onesa_account")!]])),
    { prompt: "login", max_age: "0" },
  );
  assert.equal(fresh.details.onesaAccount, undefined);
  assert.equal(fresh.details.onesaReauthRequired, true);
  const staleSession = await submit(fresh, "session");
  assert.equal(staleSession.statusCode, 403);
  assert.equal(staleSession.json().error.code, "ONESA_REAUTH_REQUIRED");
  const stale = await submit(fresh, "password", {
    email: identity.email,
    password: docsPassword,
  });
  assert.equal(stale.statusCode, 403);
  assert.equal(stale.json().error.code, "ONESA_REAUTH_REQUIRED");
  await signIn(identity, fresh);
  const refreshed = await fresh.request({
    url: "/api/v1/engineering-sign-in/" + fresh.uid + "/details",
  });
  assert.equal(refreshed.json().onesaReauthRequired, undefined);
  assert.deepEqual(refreshed.json().onesaAccount, { email: identity.email });
  const confirmed = await submit(fresh, "session");
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  await db.query("UPDATE users SET disabled=true WHERE id=$1", [identity.id]);
  const resumed = await fresh.request({ url: confirmed.json().continuePath });
  assert.ok(
    resumed.statusCode !== 303 ||
      !new URL(String(resumed.headers.location)).searchParams.has("code"),
  );
  assert.equal(
    (
      await db.query(
        "SELECT user_id FROM identity_engineering_links WHERE membership_id=$1",
        [identity.membership],
      )
    ).rows[0].user_id,
    identity.id,
  );
});

test("a session preceding a forced interaction within the same second is not fresh authentication", async () => {
  const identity = await fixture("same-second"),
    { signed } = await linkWithPassword(identity);
  const flow = await authorization(
    browser(new Map([["onesa_account", signed.jar.get("onesa_account")!]])),
    { prompt: "login", max_age: "0" },
  );
  const interaction = await new EngineeringIdentityAdapter("Interaction").find(
    flow.uid,
  );
  assert.ok(interaction && typeof interaction.iat === "number");
  await db.query(
    "UPDATE identity_sessions SET authenticated_at=to_timestamp($1) WHERE user_id=$2",
    [interaction.iat, identity.id],
  );
  await db.query(
    "UPDATE engineering_identity_records SET created_at=to_timestamp($1)+interval '1 millisecond' WHERE model='Interaction' AND id=$2",
    [interaction.iat, flow.uid],
  );
  const details = await flow.request({
    url: "/api/v1/engineering-sign-in/" + flow.uid + "/details",
  });
  assert.equal(details.json().onesaAccount, undefined);
  assert.equal(details.json().onesaReauthRequired, true);
  const result = await submit(flow, "session");
  assert.equal(result.statusCode, 403);
  assert.equal(result.json().error.code, "ONESA_REAUTH_REQUIRED");
});
