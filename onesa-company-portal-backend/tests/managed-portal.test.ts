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
    scope = "portal",
    signedSubject = subject,
    signedUser = userId,
    role = "administrator",
    operationNonce: string | undefined,
    authenticationAge = 0;
  const sign = (claims: Record<string, unknown>, resource: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(signedSubject)
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
          [ns + "user_id"]: signedUser,
          [ns + "roles"]: [role],
          ...(operationNonce
            ? { [ns + "operation_mfa_nonce"]: operationNonce }
            : {}),
          [ns + "products"]: [scope],
          [ns + "mfa_time"]: Math.floor(Date.now() / 1000) - factorAge,
        };
        return Response.json({
          token_type: "Bearer",
          access_token: await sign(data, aud),
          id_token: await sign(
            {
              nonce,
              auth_time: Math.floor(Date.now() / 1000) - authenticationAge,
            },
            clientId,
          ),
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
    // A managed owner confirms one exact governance operation without disclosing local credentials.
    await db.query("UPDATE users SET role='owner' WHERE id=$1", [userId]);
    role = "owner";
    const ownerLogin = await app.inject(await start());
    const ownerCookie = cookies(ownerLogin);
    const ownerMe = await app.inject({
      url: "/api/v1/auth/me",
      headers: { cookie: ownerCookie },
    });
    const ownerHeaders = {
      cookie: ownerCookie,
      origin,
      "x-csrf-token": ownerMe.json().csrf,
    };
    const targetId = randomUUID();
    const hold = {
      id: randomUUID(),
      target: { kind: "enquiry", id: targetId },
      reason: "Synthetic retention verification",
      evidenceRefs: ["tests/managed-operation"],
    };
    const holdPath = "/api/v1/admin/governance/holds";
    const submit = (
      body: object,
      receipt?: string,
      authenticated = ownerHeaders,
    ) =>
      app.inject({
        method: "POST",
        url: holdPath,
        headers: authenticated,
        payload: {
          ...body,
          stepUp: { managed: true, ...(receipt ? { receipt } : {}) },
        },
      });
    async function requestChallenge() {
      const attempt = await submit(hold);
      assert.equal(attempt.statusCode, 403, attempt.body);
      assert.equal(attempt.json().error.code, "PROVIDER_STEP_UP_REQUIRED");
      const id = attempt.headers["x-onesa-step-up"];
      assert.equal(typeof id, "string");
      return id as string;
    }
    async function beginChallenge(id: string) {
      const challengeUrl = prefix + "/step-up?challenge=" + id;
      assert.equal((await app.inject({ url: challengeUrl })).statusCode, 403);
      const init = await app.inject({
        url: challengeUrl,
        headers: { cookie: ownerCookie },
      });
      assert.equal(init.statusCode, 303, init.body);
      const auth = new URL(init.headers.location!);
      assert.equal(auth.searchParams.get("max_age"), "0");
      assert.equal(auth.searchParams.get("prompt"), "login");
      assert.ok(
        auth.searchParams
          .get("acr_values")
          ?.split(" ")
          .includes("urn:onesa:authentication:operation-mfa"),
      );
      assert.equal(
        (
          await app.inject({
            url: challengeUrl,
            headers: { cookie: ownerCookie },
          })
        ).statusCode,
        403,
      );
      nonce = auth.searchParams.get("nonce")!;
      challenge = auth.searchParams.get("code_challenge")!;
      operationNonce = nonce;
      return {
        url:
          prefix +
          "/callback?" +
          new URLSearchParams({
            state: auth.searchParams.get("state")!,
            code: "single-use-test-code",
          }),
        headers: { cookie: cookies(init) },
      };
    }
    for (const invalid of [
      "factor",
      "primary",
      "nonce",
      "subject",
      "uuid",
      "grant",
    ]) {
      const callback = await beginChallenge(await requestChallenge());
      if (invalid === "factor") factorAge = 60;
      if (invalid === "primary") authenticationAge = 60;
      if (invalid === "nonce") operationNonce = "different-authentication";
      if (invalid === "subject") signedSubject = "different-provider-subject";
      if (invalid === "uuid") signedUser = randomUUID();
      if (invalid === "grant") role = "viewer";
      const rejected = await app.inject(callback);
      assert.equal(rejected.statusCode, 403, invalid + " " + rejected.body);
      factorAge = 0;
      authenticationAge = 0;
      signedSubject = subject;
      signedUser = userId;
      role = "owner";
    }
    const receipt = await requestChallenge();
    const callback = await beginChallenge(receipt);
    const verified = await app.inject(callback);
    assert.equal(
      verified.headers.location,
      "/admin/step-up-complete",
      verified.body,
    );
    assert.equal((await app.inject(callback)).statusCode, 403);
    assert.equal(
      (
        await submit(
          { ...hold, reason: "A materially different reason" },
          receipt,
        )
      ).json().error.code,
      "STEP_UP_FAILED",
    );
    const otherLogin = await app.inject(await start());
    const otherCookie = cookies(otherLogin);
    const otherMe = await app.inject({
      url: "/api/v1/auth/me",
      headers: { cookie: otherCookie },
    });
    const otherHeaders = {
      cookie: otherCookie,
      origin,
      "x-csrf-token": otherMe.json().csrf,
    };
    assert.equal(
      (await submit(hold, receipt, otherHeaders)).json().error.code,
      "STEP_UP_FAILED",
    );
    const missing = await submit(hold, receipt);
    assert.equal(missing.statusCode, 404, missing.body);
    await db.query(
      "INSERT INTO enquiries(id,category,name,email,message,locale) VALUES($1,'general','Synthetic operation','member@example.invalid','Isolated fixture only','en')",
      [targetId],
    );
    const completed = await submit(hold, receipt);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM portal_operation_challenges WHERE challenge_hash=$1",
          [hash(receipt)],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await submit({ ...hold, id: randomUUID() }, receipt)).json().error.code,
      "STEP_UP_FAILED",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM privacy_holds WHERE id=$1",
          [hold.id],
        )
      ).rows[0].n,
      1,
    );
    operationNonce = undefined;
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
