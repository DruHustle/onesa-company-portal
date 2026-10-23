import "./local-environment.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
  verify,
} from "node:crypto";
if (!process.env.TEST_DATABASE_URL)
  throw Error("Isolated loopback test database required");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_KEY = randomBytes(32).toString("hex");
process.env.PUBLIC_ORIGIN = "https://portal.example.invalid";
process.env.COMPANY_ORIGIN = "";
process.env.PROXY_SHARED_KEY = randomBytes(32).toString("hex");
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  issuer: process.env.PUBLIC_ORIGIN + "/api/v1/engineering-identity",
  clientId: "synthetic_engineering_client",
  clientSecret: randomBytes(48).toString("hex"),
  redirectUri:
    "https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/callback",
  cookieKeys: [randomBytes(48).toString("hex")],
  externalEmails: ["approved@example.invalid"],
  jwks: {
    keys: [
      {
        ...key.privateKey.export({ format: "jwk" }),
        kid: "synthetic_key_01",
        alg: "RS256",
        use: "sig",
      },
    ],
  },
};
process.env.ENGINEERING_IDENTITY_ENABLED = "true";
process.env.ENGINEERING_OIDC_CONFIG_B64 = Buffer.from(
  JSON.stringify(config),
).toString("base64");
const { db } = await import("../src/services/db.js");
const { migrate } = await import("../src/services/migrate.js");
const { buildApp } = await import("../src/app.js");
const { decrypt, encrypt, passwordHash, hash } = await import("../src/auth/crypto.js");
const { prepareEngineeringHandoff, readEngineeringHandoff, engineeringHandoffCookie } = await import("../src/engineering/link-handoff.js");
const { EngineeringIdentityAdapter } =
  await import("../src/engineering/adapter.js");
const { beginEngineeringChallenge, consumeEngineeringChallenge } =
  await import("../src/engineering/challenges.js");
const { engineeringIdentityConfiguration } =
  await import("../src/engineering/config.js");
const app = await buildApp({ logging: false }),
  ownerId = randomUUID(),
  memberId = randomUUID(),
  ownerPassword = randomBytes(32).toString("hex");
before(async () => {
  await migrate();
  await db.query(
    "TRUNCATE users,audit,rate_limits,engineering_memberships,engineering_identity_records,engineering_email_challenges,jobs CASCADE",
  );
  await db.query(
    "INSERT INTO users(id,email,password_hash,role) VALUES($1,'owner@example.invalid',$2,'owner')",
    [ownerId, passwordHash(ownerPassword)],
  );
  await db.query(
    "INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,'engineer@onesa.eu',true,'Synthetic exact-email policy fixture',$2)",
    [memberId, ownerId],
  );
  await app.ready();
});
after(async () => {
  await app.close();
  await db.end();
});
const proxy = { "x-portal-proxy-key": process.env.PROXY_SHARED_KEY! };
test("Disabled or malformed identity configuration cannot activate a provider", () => {
  assert.equal(
    engineeringIdentityConfiguration({}, process.env.PUBLIC_ORIGIN!),
    null,
  );
  for (const change of [
    { redirectUri: "https://attacker.invalid/callback" },
    { issuer: "https://attacker.invalid/api/v1/engineering-identity" },
    { externalEmails: ["*@onesa.eu"] },
    { clientSecret: "short" },
  ])
    assert.throws(
      () =>
        engineeringIdentityConfiguration(
          {
            ENGINEERING_IDENTITY_ENABLED: "true",
            ENGINEERING_OIDC_CONFIG_B64: Buffer.from(
              JSON.stringify({ ...config, ...change }),
            ).toString("base64"),
          },
          process.env.PUBLIC_ORIGIN!,
        ),
      /^Error: Engineering identity configuration rejected$/,
    );
});
test("Protocol requires the Portal proxy; public metadata contains no signing secret", async () => {
  const denied = await app.inject({
    url: "/api/v1/engineering-identity/.well-known/openid-configuration",
  });
  assert.equal(denied.statusCode, 403);
  const metadata = await app.inject({
    url: "/api/v1/engineering-identity/.well-known/openid-configuration",
    headers: proxy,
  });
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.json().issuer, config.issuer);
  assert.ok(metadata.json().code_challenge_methods_supported.includes("S256"));
  const jwks = await app.inject({
    url: "/api/v1/engineering-identity/jwks",
    headers: proxy,
  });
  assert.equal(jwks.statusCode, 200);
  assert.equal(jwks.json().keys[0].d, undefined);
  assert.equal(jwks.json().keys[0].p, undefined);
});
test("Encrypted adapter binds identity and consumes an authorization artifact once under concurrency", async () => {
  const clients = new EngineeringIdentityAdapter("Client");
  assert.equal(await clients.find("unknown"), undefined);
  await assert.rejects(clients.upsert("unknown", {}), /fixed configuration/);
  const adapter = new EngineeringIdentityAdapter("AuthorizationCode"),
    id = randomUUID();
  await adapter.upsert(
    id,
    { accountId: memberId, grantId: "synthetic-grant" },
    60,
  );
  const stored = (
    await db.query(
      "SELECT encrypted_payload FROM engineering_identity_records WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.ok(!stored.encrypted_payload.includes(memberId));
  const results = await Promise.allSettled([
    adapter.consume(id),
    adapter.consume(id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.ok((await adapter.find(id))?.consumed);
  await adapter.revokeByGrantId("synthetic-grant");
  assert.equal(await adapter.find(id), undefined);
});
async function codeFor(uid: string) {
  const jobs = (
    await db.query("SELECT payload FROM jobs WHERE dedupe_key LIKE $1", [
      "engineering-code:" + uid + ":%",
    ])
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.text, undefined);
  const code = decrypt(jobs[0].payload.encryptedText).match(
    /code is (\d{6})\./,
  )?.[1];
  assert.ok(code);
  return code;
}
test("Email proofs have bounded attempts, expiry, membership and one-use controls without delivering real email", async () => {
  const typed = engineeringIdentityConfiguration(
    process.env,
    process.env.PUBLIC_ORIGIN!,
  )!;
  const uid = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, uid, "engineer@onesa.eu");
  const code = await codeFor(uid);
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      consumeEngineeringChallenge(
        typed,
        uid,
        code === "000000" ? "111111" : "000000",
      ),
    );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT attempts FROM engineering_email_challenges WHERE interaction_uid=$1",
          [uid],
        )
      ).rows[0].attempts,
    ),
    5,
  );
  await assert.rejects(consumeEngineeringChallenge(typed, uid, code));
  const one = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, one, "engineer@onesa.eu");
  const once = await codeFor(one);
  assert.equal(await consumeEngineeringChallenge(typed, one, once), memberId);
  await assert.rejects(consumeEngineeringChallenge(typed, one, once));
  const unknown = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, unknown, "unknown@onesa.eu");
  assert.equal(
    (
      await db.query("SELECT id FROM jobs WHERE dedupe_key LIKE $1", [
        "engineering-code:" + unknown + ":%",
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(consumeEngineeringChallenge(typed, unknown, "000000"));
  const expired = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, expired, "engineer@onesa.eu");
  const expiryCode = await codeFor(expired);
  await db.query(
    "UPDATE engineering_email_challenges SET expires_at=now()-interval '1 second' WHERE interaction_uid=$1",
    [expired],
  );
  await assert.rejects(consumeEngineeringChallenge(typed, expired, expiryCode));
});
for (const method of ["otp", "email_link", "pwd", "cross_browser_link", "pwd_remember", "portal_mfa", "portal_mfa_remember"]) test("OIDC cookie/PKCE and signed identity with " + method, async () => {
  const jar = new Map<string, string>();
  async function request(options: InjectOptions) {
    const response = await app.inject({
      ...options,
      headers: {
        ...proxy,
        cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
        ...options.headers,
      },
    });
    for (const c of response.cookies) jar.set(c.name, c.value);
    return response;
  }
  let verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(24).toString("hex"),
    nonce = randomBytes(24).toString("hex"),
    query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
  const auth = await request({
    url: "/api/v1/engineering-identity/auth?" + query,
  });
  assert.equal(auth.statusCode, 303, auth.body);
  const location = new URL(String(auth.headers.location));
  assert.equal(location.origin, process.env.PUBLIC_ORIGIN);
  assert.match(location.pathname, /^\/engineering\/sign-in\/[A-Za-z0-9_-]+$/);
  let uid = location.pathname.split("/").pop()!;
  const details = await request({
    url: "/api/v1/engineering-sign-in/" + uid + "/details",
  });
  assert.equal(details.statusCode, 200, details.body);
  let csrf = details.json().csrf;
  assert.equal(
    (
      await request({
        method: "POST",
        url: "/api/v1/engineering-sign-in/" + uid + "/start",
        headers: { origin: "https://attacker.invalid" },
        payload: { csrf, email: "engineer@onesa.eu" },
      })
    ).statusCode,
    403,
  );
  let finished;
  if (method.startsWith("portal_mfa")) {
    const id=randomUUID(), email="engineer@onesa.eu", password="Synthetic portal MFA password";
    const existing=(await db.query("SELECT id FROM users WHERE email=$1",[email])).rows[0];
    const userId=existing?.id??id;
    if(!existing)await db.query("INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,'viewer',$4)",[id,email,passwordHash(password),encrypt("JBSWY3DPEHPK3PXP")]);
    const code=randomUUID();await db.query("INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)",[userId,hash(code)]);
    const signed=await request({method:"POST",url:"/api/v1/auth/login",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{email,password,code,rememberBrowser:method.endsWith("remember")}});
    assert.equal(signed.statusCode,200,signed.body);
    const available=await request({url:"/api/v1/engineering-sign-in/"+uid+"/details"});
    assert.deepEqual(available.json().onesaAccount,{email});
    const before=(await db.query("SELECT count(*)::int AS n FROM engineering_identity_records WHERE model='Grant'")).rows[0].n;
    await db.query("DELETE FROM rate_limits WHERE key LIKE 'engineering-session:%'");
    for (const changes of [
      {headers:{origin:"https://attacker.invalid"},payload:{csrf}},
      {headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf:"0".repeat(64)}}
    ]) assert.equal((await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",...changes})).statusCode,403);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM engineering_identity_records WHERE model='Grant'")).rows[0].n,before);
    await db.query("UPDATE engineering_memberships SET enabled=false WHERE id=$1",[memberId]);
    assert.equal((await request({url:"/api/v1/engineering-sign-in/"+uid+"/details"})).json().onesaAccount,undefined);
    assert.equal((await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf}})).statusCode,401);
    await db.query("UPDATE engineering_memberships SET enabled=true WHERE id=$1",[memberId]);
    const sessionHash=hash(jar.get("onesa_session")!);
    await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[sessionHash]);
    assert.equal((await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf}})).statusCode,401);
    await db.query("UPDATE sessions SET expires_at=now()+interval '1 hour' WHERE token_hash=$1",[sessionHash]);
    await db.query("UPDATE users SET mfa_secret=NULL WHERE id=$1",[userId]);
    assert.equal((await request({url:"/api/v1/engineering-sign-in/"+uid+"/details"})).json().onesaAccount,undefined);
    assert.equal((await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf}})).statusCode,401);
    await db.query("UPDATE users SET mfa_secret=$2 WHERE id=$1",[userId,encrypt("JBSWY3DPEHPK3PXP")]);
    finished=await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,rememberBrowser:method.endsWith("remember")}});
  } else if (method === "pwd" || method === "pwd_remember") {
    await db.query("INSERT INTO engineering_credentials(membership_id,password_hash) VALUES($1,$2) ON CONFLICT(membership_id) DO NOTHING",[memberId,passwordHash("synthetic engineering password")]);
    finished = await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/password",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,email:"engineer@onesa.eu",password:"synthetic engineering password",rememberBrowser:method.endsWith("remember")}});
  } else if (method === "cross_browser_link") {
    const oldUid = uid;
    const start = await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/link",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,email:"engineer@onesa.eu"}});
    assert.equal(start.statusCode,200,start.body);
    const job=(await db.query("SELECT payload FROM jobs WHERE dedupe_key LIKE 'access-link:%' AND payload->>'to'='engineer@onesa.eu' ORDER BY created_at DESC LIMIT 1")).rows[0];
    const text=decrypt(job.payload.encryptedText),raw=text.match(/#access-link=([a-f0-9]{64})/)?.[1];assert.ok(raw);assert.match(text,/any browser/);
    const withoutCookie=await app.inject({url:"/api/v1/engineering-sign-in/"+uid+"/details",headers:proxy});
    assert.equal(withoutCookie.statusCode,401);assert.equal(withoutCookie.json().error.code,"ENGINEERING_INTERACTION");
    const path="/api/v1/engineering-sign-in/"+uid+"/link-prepare";
    const foreign=await app.inject({method:"POST",url:path,headers:{...proxy,origin:"https://attacker.invalid"},payload:{token:raw}});assert.equal(foreign.statusCode,403);
    const prepared=await app.inject({method:"POST",url:path,headers:{...proxy,origin:process.env.PUBLIC_ORIGIN},payload:{token:raw}});
    assert.equal(prepared.statusCode,200,prepared.body);assert.deepEqual(prepared.json(),{continuePath:"/engineering"});
    const cookie=prepared.cookies.find(c=>c.name===engineeringHandoffCookie);assert.ok(cookie);assert.equal(cookie.path,"/");assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.domain,undefined);assert.ok(Number(cookie.maxAge)<=300);
    assert.equal((await db.query("SELECT consumed_at FROM access_links WHERE token_hash=$1",[hash(raw)])).rows[0].consumed_at,null);
    // A new browser has neither the original interaction nor its PKCE/state.
    jar.clear();for(const c of prepared.cookies)jar.set(c.name,c.value);
    await db.query("UPDATE engineering_identity_records SET expires_at=now()-interval '1 second' WHERE model='Interaction' AND id=$1",[oldUid]);
    verifier=randomBytes(48).toString("base64url");state=randomBytes(24).toString("hex");nonce=randomBytes(24).toString("hex");
    query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:"code",scope:"openid email profile",state,nonce,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
    const fresh=await request({url:"/api/v1/engineering-identity/auth?"+query});assert.equal(fresh.statusCode,303,fresh.body);uid=new URL(String(fresh.headers.location)).pathname.split("/").pop()!;assert.notEqual(uid,oldUid);
    const current=await request({url:"/api/v1/engineering-sign-in/"+uid+"/details"});assert.equal(current.statusCode,200,current.body);assert.equal(current.json().linkEmail,"engineer@onesa.eu");csrf=current.json().csrf;
    const before=(await db.query("SELECT count(*)::int AS n FROM engineering_identity_records WHERE model='Grant'")).rows[0].n;
    const badProof=await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/handoff-verify",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf:"0".repeat(64)}});assert.equal(badProof.statusCode,403);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM engineering_identity_records WHERE model='Grant'")).rows[0].n,before);
    finished=await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/handoff-verify",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf}});
    assert.equal(finished.statusCode,200,finished.body);assert.ok((await db.query("SELECT consumed_at FROM access_links WHERE token_hash=$1",[hash(raw)])).rows[0].consumed_at);
    const replay=await app.inject({method:"POST",url:path,headers:{...proxy,origin:process.env.PUBLIC_ORIGIN},payload:{token:raw}});assert.equal(replay.statusCode,401);
  } else if (method === "email_link") {
    const start = await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/link",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,email:"engineer@onesa.eu"}});assert.equal(start.statusCode,200,start.body);
    const job=(await db.query("SELECT payload FROM jobs WHERE dedupe_key LIKE 'access-link:%' AND payload->>'to'='engineer@onesa.eu' ORDER BY created_at DESC LIMIT 1")).rows[0];
    const raw=decrypt(job.payload.encryptedText).match(/#access-link=([a-f0-9]{64})/)?.[1];assert.ok(raw);
    finished=await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/link-verify",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,token:raw}});
  } else {
    const start = await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/start",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,email:"engineer@onesa.eu"}});assert.equal(start.statusCode,200,start.body);
    finished=await request({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/verify",headers:{origin:process.env.PUBLIC_ORIGIN},payload:{csrf,code:await codeFor(uid)}});
  }
  assert.equal(finished.statusCode, 200, finished.body);
  const resume = await request({ url: finished.json().continuePath });
  assert.equal(resume.statusCode, 303, resume.body);
  const sessionCookie=resume.cookies.find(c=>c.name==="onesa_engineering_session");
  assert.ok(sessionCookie, "actual provider session cookie");
  assert.equal(Boolean(sessionCookie.expires),method.endsWith("remember"));
  if(sessionCookie.expires)assert.ok(new Date(sessionCookie.expires).getTime()-Date.now()<=28800_000);
  assert.equal(sessionCookie.httpOnly,true);assert.equal(sessionCookie.secure,true);assert.equal(sessionCookie.domain,undefined);
  const callback = new URL(String(resume.headers.location));
  assert.equal(callback.origin, new URL(config.redirectUri).origin);
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  const exchange = {
    method: "POST" as const,
    url: "/api/v1/engineering-identity/token",
    headers: {
      // Token exchange is a server backchannel, never the browser cookie jar.
      cookie: "",
      authorization:
        "Basic " +
        Buffer.from(config.clientId + ":" + config.clientSecret).toString(
          "base64",
        ),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }).toString(),
  };
  const token = await request(exchange);
  assert.equal(token.statusCode, 200, token.body);
  const [head, payload, signature] = String(token.json().id_token).split(".");
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(head + "." + payload),
      key.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, config.issuer);
  assert.equal(claims.aud, config.clientId);
  assert.equal(claims.sub, memberId);
  assert.equal(claims.email, "engineer@onesa.eu");
  assert.equal(claims.email_verified, true);
  const userinfo = await request({
    url: "/api/v1/engineering-identity/me",
    headers: { authorization: "Bearer " + token.json().access_token },
  });
  assert.equal(userinfo.statusCode, 200, userinfo.body);
  assert.equal(userinfo.json().sub, memberId);
  assert.equal(userinfo.json().email, "engineer@onesa.eu");
  assert.equal(userinfo.json().email_verified, true);
  assert.equal(userinfo.json().role, undefined);
  assert.equal(claims.nonce, nonce);
  assert.ok(claims.exp - claims.iat <= 300);
  assert.equal(claims.role, undefined);
  assert.equal(token.json().refresh_token, undefined);
  assert.equal((await request(exchange)).statusCode, 400);
  assert.equal(
    (await app.inject({ url: "/api/v1/admin/engineering/memberships" }))
      .statusCode,
    401,
  );
});

test("Cross-browser handoffs reject tampering, other origins, expiry and disabled membership", async () => {
  const {requestEngineeringLink}=await import("../src/auth/access.js");
  const original="synthetic_handoff_"+randomUUID();await requestEngineeringLink("engineer@onesa.eu",original,config.externalEmails);
  const job=(await db.query("SELECT payload FROM jobs WHERE dedupe_key LIKE 'access-link:%' AND payload->>'to'='engineer@onesa.eu' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const raw=decrypt(job.payload.encryptedText).match(/#access-link=([a-f0-9]{64})/)?.[1];assert.ok(raw);
  const value=await prepareEngineeringHandoff(raw,original,process.env.PUBLIC_ORIGIN!,config.externalEmails);
  assert.equal((await readEngineeringHandoff(value.cookie,process.env.PUBLIC_ORIGIN!,config.externalEmails)).email,"engineer@onesa.eu");
  assert.equal(value.cookie.includes(raw),false);
  const bytes=Buffer.from(value.cookie,"base64");bytes[15]^=1;
  await assert.rejects(readEngineeringHandoff(bytes.toString("base64"),process.env.PUBLIC_ORIGIN!,config.externalEmails));
  await assert.rejects(readEngineeringHandoff(value.cookie,"https://other.example.invalid",config.externalEmails));
  const parsed=JSON.parse(decrypt(value.cookie));
  for(const change of [{purpose:"admin"},{expiresAt:Date.now()-1},{expiresAt:Date.now()+600_000}])await assert.rejects(readEngineeringHandoff(encrypt(JSON.stringify({...parsed,...change})),process.env.PUBLIC_ORIGIN!,config.externalEmails));
  await db.query("UPDATE engineering_memberships SET enabled=false WHERE id=$1",[memberId]);
  try{await assert.rejects(readEngineeringHandoff(value.cookie,process.env.PUBLIC_ORIGIN!,config.externalEmails));}finally{await db.query("UPDATE engineering_memberships SET enabled=true WHERE id=$1",[memberId]);}
  assert.equal((await db.query("SELECT consumed_at FROM access_links WHERE token_hash=$1",[hash(raw)])).rows[0].consumed_at,null);
});

test("Unknown interactions and unapproved redirects cannot send a code or grant access", async () => {
  const unknown = "synthetic_" + randomUUID();
  const before = Number(
    (await db.query("SELECT count(*) FROM jobs")).rows[0].count,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/engineering-sign-in/" + unknown + "/details",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/engineering-sign-in/" + unknown + "/start",
        headers: { origin: process.env.PUBLIC_ORIGIN },
        payload: { csrf: "a".repeat(64), email: "engineer@onesa.eu" },
      })
    ).statusCode,
    401,
  );
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: "https://attacker.invalid/callback",
    response_type: "code",
    scope: "openid email",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
  const result = await app.inject({
    url: "/api/v1/engineering-identity/auth?" + query,
    headers: proxy,
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.headers.location, undefined);
  assert.equal(
    Number((await db.query("SELECT count(*) FROM jobs")).rows[0].count),
    before,
  );
});
test("Disabling membership invalidates a prepared proof and concurrent redemption succeeds once", async () => {
  const typed = engineeringIdentityConfiguration(
      process.env,
      process.env.PUBLIC_ORIGIN!,
    )!,
    uid = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, uid, "engineer@onesa.eu");
  const code = await codeFor(uid);
  const outcomes = await Promise.allSettled([
    consumeEngineeringChallenge(typed, uid, code),
    consumeEngineeringChallenge(typed, uid, code),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const disabled = "synthetic_" + randomUUID();
  await beginEngineeringChallenge(typed, disabled, "engineer@onesa.eu");
  const disabledCode = await codeFor(disabled);
  try {
    await db.query(
      "UPDATE engineering_memberships SET enabled=false WHERE id=$1",
      [memberId],
    );
    await assert.rejects(
      consumeEngineeringChallenge(typed, disabled, disabledCode),
    );
  } finally {
    await db.query(
      "UPDATE engineering_memberships SET enabled=true WHERE id=$1",
      [memberId],
    );
  }
});

test("Membership management requires owner role, CSRF, fresh proof and a matching revision; no Portal account is created", async () => {
  const raw = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hash(raw), ownerId, csrf],
  );
  const headers = {
    cookie: "onesa_session=" + raw,
    "x-csrf-token": csrf,
    origin: process.env.PUBLIC_ORIGIN!,
  };
  const passwordProof = async () => {
    const code = randomUUID();
    await db.query(
      "INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)",
      [ownerId, hash(code)],
    );
    return { password: ownerPassword, code };
  };
  const email = "synthetic-second@onesa.eu",
    before = Number(
      (await db.query("SELECT count(*) FROM users")).rows[0].count,
    ),
    body = {
      email,
      enabled: true,
      evidence: "Synthetic verified exact-email policy fixture",
      expectedRevision: 0,
      ...(await passwordProof()),
    };
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/engineering/memberships",
        payload: body,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/engineering/memberships",
        headers: { ...headers, "x-csrf-token": "invalid" },
        payload: body,
      })
    ).statusCode,
    403,
  );
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/engineering/memberships",
    headers,
    payload: body,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 1);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/engineering/memberships",
        headers,
        payload: { ...body, ...(await passwordProof()) },
      })
    ).statusCode,
    409,
  );
  const disabled = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/engineering/memberships",
    headers,
    payload: {
      ...body,
      enabled: false,
      expectedRevision: 1,
      ...(await passwordProof()),
    },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().enabled, false);
  assert.equal(disabled.json().revision, 2);
  const listing = await app.inject({
    url: "/api/v1/admin/engineering/memberships",
    headers,
  });
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.json().configured, true);
  assert.equal(
    Number((await db.query("SELECT count(*) FROM users")).rows[0].count),
    before,
  );
  const administrator = randomUUID(),
    token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO users(id,email,password_hash,role) VALUES($1,'synthetic-admin@example.invalid',$2,'administrator')",
    [administrator, passwordHash(ownerPassword)],
  );
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [hash(token), administrator, csrf],
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/admin/engineering/memberships",
        headers: { ...headers, cookie: "onesa_session=" + token },
      })
    ).statusCode,
    403,
  );
});

test("Protocol initiation is bounded before creating an identity interaction", async () => {
  const before = Number(
    (
      await db.query(
        "SELECT count(*) FROM engineering_identity_records WHERE model='Interaction'",
      )
    ).rows[0].count,
  );
  for (let i = 0; i < 30; i++) {
    const result = await app.inject({
      url: "/api/v1/engineering-identity/auth?client_id=unknown",
      headers: { ...proxy, "x-portal-client-ip": "127.0.0.2" },
    });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/engineering-identity/auth?client_id=unknown",
        headers: { ...proxy, "x-portal-client-ip": "127.0.0.2" },
      })
    ).statusCode,
    429,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM engineering_identity_records WHERE model='Interaction'",
        )
      ).rows[0].count,
    ),
    before,
  );
});
test("Isolated restore lockdown invalidates Docs grants, codes and memberships without deleting membership evidence", async () => {
  const { execFileSync } = await import("node:child_process");
  const typed = engineeringIdentityConfiguration(
      process.env,
      process.env.PUBLIC_ORIGIN!,
    )!,
    uid = "synthetic_restore_" + randomUUID();
  await beginEngineeringChallenge(typed, uid, "engineer@onesa.eu");
  await new EngineeringIdentityAdapter("Session").upsert(
    "synthetic-restored-session",
    { accountId: memberId },
    300,
  );
  const sql = execFileSync(
    "python3",
    [
      "-c",
      "import sys;sys.path.insert(0,'../scripts/release');import restore_lockdown;print(restore_lockdown.SQL)",
    ],
    { encoding: "utf8" },
  );
  const before = Number(
    (await db.query("SELECT count(*) FROM engineering_memberships")).rows[0]
      .count,
  );
  await db.query(sql);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM engineering_memberships WHERE enabled",
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (await db.query("SELECT count(*) FROM engineering_memberships")).rows[0]
        .count,
    ),
    before,
  );
  assert.equal(
    Number(
      (await db.query("SELECT count(*) FROM engineering_identity_records"))
        .rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (await db.query("SELECT count(*) FROM engineering_email_challenges"))
        .rows[0].count,
    ),
    0,
  );
});

test("Existing Portal MFA sessions cannot satisfy forced reauthentication or exceeded max_age",async()=>{
  const userId=randomUUID(),email="freshness@onesa.eu",session=randomBytes(32).toString("hex");
  await db.query("INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,'viewer',$4)",[userId,email,passwordHash("Synthetic freshness test password"),encrypt("JBSWY3DPEHPK3PXP")]);
  await db.query("INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,$2,true,'Synthetic freshness test approval',$3)",[randomUUID(),email,ownerId]);
  await db.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES($1,$2,$3,now()+interval '1 hour',now()-interval '5 minutes')",[hash(session),userId,randomBytes(32).toString("hex")]);
  for(const extra of [{prompt:"login"},{max_age:"0"},{max_age:"60"}] as Record<string,string>[]){
    const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:"code",scope:"openid email profile",state:randomBytes(24).toString("hex"),nonce:randomBytes(24).toString("hex"),code_challenge:createHash("sha256").update(randomBytes(48)).digest("base64url"),code_challenge_method:"S256",...extra});
    const auth=await app.inject({url:"/api/v1/engineering-identity/auth?"+query,headers:proxy});assert.equal(auth.statusCode,303,auth.body);
    const uid=new URL(String(auth.headers.location)).pathname.split("/").pop();
    const cookie=[...auth.cookies.map(c=>c.name+"="+c.value),"onesa_session="+session].join("; ");
    const details=await app.inject({url:"/api/v1/engineering-sign-in/"+uid+"/details",headers:{...proxy,cookie}});assert.equal(details.statusCode,200,details.body);assert.equal(details.json().onesaAccount,undefined);
    const denied=await app.inject({method:"POST",url:"/api/v1/engineering-sign-in/"+uid+"/session",remoteAddress:"2001:db8:10::1",headers:{...proxy,cookie,origin:process.env.PUBLIC_ORIGIN},payload:{csrf:details.json().csrf}});assert.equal(denied.statusCode,401,denied.body);
  }
});
