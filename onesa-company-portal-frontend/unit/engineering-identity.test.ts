import { test } from "node:test";
import assert from "node:assert/strict";
import {
  engineeringProtocolPath,
  engineeringRedirectLocation,
} from "../src/lib/engineering-identity.ts";
const origin = "https://portal.example.invalid",
  callback = "https://synthetic.cloudflareaccess.com/cdn-cgi/access/callback";
test("Identity protocol has a narrow explicit path allowlist", () => {
  for (const path of [
    "engineering-identity/.well-known/openid-configuration",
    "engineering-identity/jwks",
    "engineering-identity/auth",
    "engineering-identity/auth/abcdefgh",
    "engineering-identity/token",
    "engineering-identity/me",
  ])
    assert.equal(engineeringProtocolPath(path.split("/")), true);
  for (const path of [
    "admin/users",
    "engineering-identity/../token",
    "engineering-identity/.well-known/other",
    "engineering-identity/token/extra",
    "engineering-identity/auth/a",
    "engineering-identity/auth/abcdefgh?x=y",
  ])
    assert.equal(engineeringProtocolPath(path.split("/")), false);
});
test("Interaction redirects stay on the trusted Portal without arbitrary queries", () => {
  for (const path of [
    "/engineering/sign-in/abcdefgh",
    "/api/v1/engineering-identity/auth/abcdefgh",
  ])
    assert.equal(
      engineeringRedirectLocation(path, origin, callback),
      origin + path,
    );
  for (const path of [
    "//attacker.invalid/engineering/sign-in/abcdefgh",
    "/admin",
    "/engineering/sign-in/abcdefgh?returnTo=https://attacker.invalid",
    "/engineering/sign-in/abcdefgh#token",
    "https://user:password@portal.example.invalid/engineering/sign-in/abcdefgh",
  ])
    assert.equal(engineeringRedirectLocation(path, origin, callback), null);
});
test("OIDC callbacks require the exact configured Access authority, path and claim parameters", () => {
  assert.equal(
    engineeringRedirectLocation(
      callback + "?code=synthetic&state=synthetic",
      origin,
      callback,
    ),
    callback + "?code=synthetic&state=synthetic",
  );
  for (const location of [
    callback + "?code=a&code=b",
    callback + "?code=a&next=https://attacker.invalid",
    callback + "?iss=https://attacker.invalid",
    callback + "/extra?code=a",
    callback.replace("synthetic.", "other.") + "?code=a",
  ])
    assert.equal(engineeringRedirectLocation(location, origin, callback), null);
  assert.equal(
    engineeringRedirectLocation(callback + "?code=a", origin, undefined),
    null,
  );
  assert.equal(
    engineeringRedirectLocation(
      callback + "?code=a",
      origin,
      "https://attacker.invalid/cdn-cgi/access/callback",
    ),
    null,
  );
});

import {accessLinkToken} from '../src/lib/access-link.ts';
test('Email proof accepts exactly one bounded fragment token and rejects duplicate/redirect parameters',()=>{
 const token='a'.repeat(64);assert.equal(accessLinkToken('#access-link='+token),token);
 for(const value of ['#access-link=short','#access-link='+token+'&access-link='+token,'#access-link='+token+'&next=https://attacker.invalid','#token='+token,'#access-link='+('A'.repeat(64))])assert.equal(accessLinkToken(value),null);
});
