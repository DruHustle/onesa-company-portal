import { test } from "node:test";
import assert from "node:assert/strict";
import { engineeringSignInError } from "../src/lib/engineering-sign-in-errors.ts";

test("Expired interactions identify expiry regardless of sign-in method", () => {
  for (const action of ["details", "link", "password", "link-verify"] as const) {
    const value = engineeringSignInError(401, "ENGINEERING_INTERACTION", action);
    assert.match(value.message, /request has expired/);
    assert.equal(value.restart, true);
    assert.equal(value.registration, false);
  }
});
test("Missing password registration uses the server's explicit state", () => {
  const value = engineeringSignInError(401, "ENGINEERING_REGISTRATION_REQUIRED", "password");
  assert.match(value.message, /Complete Engineering Docs registration/);
  assert.equal(value.registration, true);
  assert.equal(value.restart, false);
});
test("Approval pending remains distinct from a password or registration error", () => {
  const value = engineeringSignInError(403, "ENGINEERING_APPROVAL_PENDING", "password");
  assert.match(value.message, /awaiting owner approval/);
  assert.equal(value.registration, false);
});
test("Credential failure never invents an unregistered account", () => {
  const value = engineeringSignInError(401, "CREDENTIALS", "password");
  assert.match(value.message, /Email or password is incorrect/);
  assert.equal(value.registration, false);
});
test("Invalid or consumed email links have an actionable link-specific message", () => {
  const value = engineeringSignInError(401, "ACCESS_LINK", "link-verify");
  assert.match(value.message, /invalid, expired or already used/);
  assert.equal(value.restart, true);
});
test("Rate limits and service failures never masquerade as incorrect credentials", () => {
  assert.match(engineeringSignInError(429, "RATE_LIMIT", "password").message, /Too many sign-in attempts/);
  assert.match(engineeringSignInError(503, "BACKEND_UNAVAILABLE", "password").message, /temporarily unavailable/);
});
test("Origin/proof failures require a fresh trusted sign-in page", () => {
  for (const code of ["ORIGIN", "ENGINEERING_PROOF", "ENGINEERING_PROXY", "ENGINEERING_PROTOCOL", "FILE_SIZE"]) {
    const value = engineeringSignInError(403, code, "password");
    assert.equal(value.restart, true);
    assert.match(value.message, /page could not be verified/);
  }
});
test("Unexpected backend errors do not copy private error text into the page", () => {
  const value = engineeringSignInError(400, "synthetic-private-server-detail", "link");
  assert.equal(value.message.includes("synthetic-private-server-detail"), false);
  assert.equal(value.restart, true);
  assert.doesNotThrow(() => engineeringSignInError(400, { toString: null }, "link"));
});
