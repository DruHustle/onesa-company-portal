import "./local-environment.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("a Portal administrator can edit company content but cannot manage Identity after delegation", async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error("Isolated loopback test database required");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_KEY = randomUUID() + randomUUID();
  process.env.PUBLIC_ORIGIN = "https://portal.example.test";
  process.env.ONESA_IDENTITY_ADMINISTRATION = "external";
  const { buildApp } = await import("../src/app.js");
  const { migrate } = await import("../src/services/migrate.js");
  const { db } = await import("../src/services/db.js");
  const { accountAccess, identityAccount } = await import("../src/identity/accounts.js");
  const { encrypt, hash, passwordHash } = await import("../src/auth/crypto.js");
  const app = await buildApp({logging:false});
  const userId = randomUUID(), email = userId + "@example.invalid", password = randomUUID(), code = randomUUID();
  try {
    await migrate();
    await db.query("INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,'administrator',$4)",
      [userId,email,passwordHash(password),encrypt("JBSWY3DPEHPK3PXP")]);
    await db.query("INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,'Portal Admin Test',now())",[userId]);
    await db.query("INSERT INTO mfa_recovery VALUES($1,$2)",[userId,hash(code)]);
    const login = await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{email,password,code}});
    assert.equal(login.statusCode,200,login.body);
    const headers = { origin:process.env.PUBLIC_ORIGIN, cookie:login.cookies.map(c => c.name+"="+c.value).join("; "), "x-csrf-token":login.json().csrf };
    const draft = {kind:"article",locale:"en",slug:"migration-"+userId,title:"Pilot editorial review",state:"draft"};
    const created = await app.inject({method:"POST",url:"/api/v1/admin/content",headers,payload:draft});
    assert.equal(created.statusCode,201,created.body);
    const changed = await app.inject({method:"PATCH",url:"/api/v1/admin/content/"+created.json().id,headers,
      payload:{...draft,title:"Revised editorial review",revision:created.json().revision}});
    assert.equal(changed.statusCode,200,changed.body);
    assert.equal(changed.json().title,"Revised editorial review");
    const access = await accountAccess((await identityAccount(userId))!);
    assert.deepEqual(access.onesa_roles,[]);
    assert.deepEqual(access.onesa_applications,[]);
    const endpoints = [
      ["GET","/api/v1/admin/users"],["POST","/api/v1/admin/users"],["PATCH","/api/v1/admin/users/"+userId],
      ["GET","/api/v1/admin/engineering/memberships"],["PUT","/api/v1/admin/engineering/memberships"],
      ["GET","/api/v1/admin/access/requests"],["POST","/api/v1/admin/access/requests/"+userId+"/review"],
      ["GET","/api/v1/admin/identity/accounts"],["PUT","/api/v1/admin/identity/accounts/"+userId+"/products/ai"],
      ["PUT","/api/v1/admin/identity/accounts/"+userId+"/member-status"],["PUT","/api/v1/admin/identity/accounts/"+userId+"/administrator"],
      ["POST","/api/v1/engineering-sign-in/fixture001/enroll"],["POST","/api/v1/access/register"],["POST","/api/v1/access/confirm"],
      ["POST","/api/v1/account/register"],["POST","/api/v1/account/confirm"],["POST","/api/v1/account/products/farmer/request"],
    ] as const;
    for (const [method,url] of endpoints) {
      const response = await app.inject({method,url,headers});
      assert.equal(response.statusCode,403,method+" "+url+" "+response.body);
      assert.equal(response.json().error.code,"IDENTITY_ADMINISTRATION_MOVED");
    }
  } finally {
    await app.close();
    await db.end();
  }
});
