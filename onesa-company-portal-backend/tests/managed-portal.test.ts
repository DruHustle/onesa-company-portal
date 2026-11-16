import "./local-environment.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { calculatePKCECodeChallenge } from "openid-client";

test("managed Portal callback verifies the signed grant and keeps an existing editorial account during issuer downtime", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw Error("Isolated loopback test database required");
  const origin = "https://portal.example.test",
    issuer = "https://identity.example.test/",
    audience = "https://portal-api.example.test",
    clientId = "portal-web";
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    PUBLIC_ORIGIN: origin,
    SESSION_KEY: randomUUID() + randomUUID(),
    ONESA_IDENTITY_PORTAL_LOGIN: "managed",
    ONESA_IDENTITY_ADMINISTRATION: "external",
    ONESA_IDENTITY_ISSUER: issuer,
    ONESA_IDENTITY_PORTAL_AUDIENCE: audience,
    ONESA_IDENTITY_PORTAL_CLIENT_ID: clientId,
    ONESA_IDENTITY_PORTAL_CLIENT_SECRET: randomUUID(),
  });
  const { buildApp } = await import("../src/app.js");
  const { managedConfig, portalProvider, portalReturnPath } =
    await import("../src/auth/managed-portal.js");
  const { db } = await import("../src/services/db.js");
  const { migrate } = await import("../src/services/migrate.js");
  const { hash } = await import("../src/auth/crypto.js");
  const userId = randomUUID(),
    subject = "verified-provider-user",
    ns = "https://onesa.eu/claims/";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  let nonce = "",
    challenge = "",
    aud = audience,
    offline = false,
    factorAge = 0,
    scope = "portal";
  const sign = (claims: Record<string, unknown>, resource: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const transport = async (
    input: string,
    init: { body?: unknown; method: string },
  ) => {
    if (offline) throw Error("test issuer offline");
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "authorize",
          token_endpoint: issuer + "oauth/token",
          jwks_uri: issuer + "jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      case "/jwks":
        return Response.json({ keys: [publicJwk] });
      case "/oauth/token": {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("code"), "single-use-test-code");
        assert.equal(
          await calculatePKCECodeChallenge(form.get("code_verifier")!),
          challenge,
        );
        const data = {
          [ns + "user_id"]: userId,
          [ns + "roles"]: ["administrator"],
          [ns + "products"]: [scope],
          [ns + "mfa_time"]: Math.floor(Date.now() / 1000) - factorAge,
        };
        return Response.json({
          token_type: "Bearer",
          access_token: await sign(data, aud),
          id_token: await sign({ nonce }, clientId),
        });
      }
      default:
        throw Error("Unexpected provider address");
    }
  };
  const provider = portalProvider(managedConfig(), transport);
  const app = await buildApp({
    logging: false,
    managedPortalProvider: provider,
  });
  const target = "/admin?section=Content&page=2",
    prefix = "/api/v1/auth/managed";
  const cookies = (response: { cookies: { name: string; value: string }[] }) =>
    response.cookies.map((c) => c.name + "=" + c.value).join("; ");
  async function start() {
    const r = await app.inject({
      url: prefix + "/start?" + new URLSearchParams({ next: target }),
    });
    assert.equal(r.statusCode, 303, r.body);
    const auth = new URL(r.headers.location!);
    assert.equal(auth.origin + auth.pathname, issuer + "authorize");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    nonce = auth.searchParams.get("nonce")!;
    challenge = auth.searchParams.get("code_challenge")!;
    return {
      url:
        prefix +
        "/callback?" +
        new URLSearchParams({
          state: auth.searchParams.get("state")!,
          code: "single-use-test-code",
        }),
      headers: { cookie: cookies(r) },
    };
  }
  try {
    await migrate();
    await migrate();
    await db.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES ($1,$2,'unused','administrator')",
      [userId, userId + "@example.invalid"],
    );
    const transaction = await start();
    assert.equal((await app.inject({ url: transaction.url })).statusCode, 403);
    const signed = await app.inject(transaction);
    assert.equal(
      signed.headers.location,
      target,
      signed.body + " " + signed.headers.location,
    );
    assert.equal((await app.inject(transaction)).statusCode, 403);
    const cookie = cookies(signed);
    offline = true;
    const me = await app.inject({
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.id, userId);
    const restarted = await buildApp({
      logging: false,
      managedPortalProvider: portalProvider(managedConfig(), transport),
    });
    try {
      const retained = await restarted.inject({
        url: "/api/v1/auth/me",
        headers: { cookie },
      });
      assert.equal(retained.statusCode, 200, retained.body);
      const interrupted = await restarted.inject({
        url: prefix + "/start?next=" + encodeURIComponent(target),
      });
      assert.ok(interrupted.headers.location!.includes("/retry?"));
    } finally {
      await restarted.close();
    }
    const headers = { cookie, origin, "x-csrf-token": me.json().csrf };
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/admin/content",
      headers,
      payload: {
        kind: "article",
        slug: "managed-" + userId,
        locale: "en",
        title: "Managed pilot",
        state: "draft",
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);
    assert.equal(
      (await app.inject({ url: "/api/v1/admin/identity/accounts", headers }))
        .statusCode,
      403,
    );
    const renewed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/renew",
      headers,
      payload: {},
    });
    assert.equal(renewed.statusCode, 200, renewed.body);
    const managedToken = renewed.cookies.find(
      (c) => c.name === "onesa_session",
    )!.value;
    const record = (
      await db.query(
        "SELECT expires_at=managed_expires_at AND expires_at<=now()+interval '5 minutes' AS bounded FROM sessions WHERE token_hash=$1",
        [hash(managedToken)],
      )
    ).rows[0];
    assert.equal(record.bounded, true);
    await db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(managedToken)],
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: cookies(renewed) },
        })
      ).statusCode,
      401,
    );
    offline = false;
    const waiting = await start();
    offline = true;
    const interrupted = await app.inject(waiting);
    assert.match(
      interrupted.headers.location!,
      /^\/api\/v1\/auth\/managed\/retry\?/,
    );
    const retry = await app.inject({ url: interrupted.headers.location! });
    assert.equal(retry.statusCode, 503);
    assert.ok(retry.body.includes(encodeURIComponent(target)));
    offline = false;
    aud = "wrong-resource";
    const wrong = await app.inject(await start());
    assert.ok(wrong.headers.location!.includes("/retry?"));
    assert.ok(!wrong.cookies.some((c) => c.name === "onesa_session"));
    aud = audience;
    factorAge = 30_000;
    assert.equal((await app.inject(await start())).statusCode, 403);
    factorAge = 0;
    scope = "engineering";
    assert.equal((await app.inject(await start())).statusCode, 403);
    assert.equal(portalReturnPath("//other.example/"), "/admin");
  } finally {
    await app.close();
    await db.end();
  }
});
