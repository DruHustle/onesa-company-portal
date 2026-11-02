import { test } from "node:test";
import assert from "node:assert/strict";
import { identityProtocolPath, identityRedirectLocation } from "../src/lib/onesa-identity.ts";
const origin = "https://account.example.invalid", callback = "https://ai.example.invalid/api/v1/auth/identity/callback";
const configured = JSON.stringify([callback]);
test("Only exact shared identity protocol routes admit protocol punctuation and server credentials", () => {
  for (const path of ["identity/auth", "identity/auth/abcde123456", "identity/.well-known/openid-configuration", "identity/token", "identity/session", "identity/revoke", "identity/me", "identity/jwks"]) assert.equal(identityProtocolPath(path.split("/")), true);
  for (const path of ["identity/../../admin", "identity/register", "identity/client/foreign", "identity/.well-known/other", "identity/session/extra"]) assert.equal(identityProtocolPath(path.split("/")), false);
});
test("Identity redirects admit only account interaction, protocol resume and exact product callback", () => {
  assert.equal(identityRedirectLocation("/account/sign-in/abcdefgh12345", origin, configured), origin + "/account/sign-in/abcdefgh12345");
  assert.equal(identityRedirectLocation("/api/v1/identity/auth/abcdefgh12345", origin, configured), origin + "/api/v1/identity/auth/abcdefgh12345");
  const approved = callback + "?code=one-use&state=bound&iss=" + encodeURIComponent(origin + "/api/v1/identity");
  assert.equal(identityRedirectLocation(approved, origin, configured), approved);
  for (const value of ["https://foreign.invalid/callback?code=x", callback + "/other?code=x", callback + "?code=x&code=y", callback + "?returnTo=https://foreign.invalid", callback + "?iss=https://foreign.invalid", callback + "#code=secret", "https://user:password@ai.example.invalid/api/v1/auth/identity/callback", "/account/sign-in/abcdefgh12345?next=https://foreign.invalid"]) assert.equal(identityRedirectLocation(value, origin, configured), null);
  assert.equal(identityRedirectLocation(approved, origin, undefined), null);
  assert.equal(identityRedirectLocation(approved, origin, "not JSON"), null);
});
