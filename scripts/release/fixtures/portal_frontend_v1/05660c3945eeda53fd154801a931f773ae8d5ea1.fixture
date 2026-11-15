import assert from "node:assert/strict";
import test from "node:test";
import { accountReturnPath, accountReauthenticationRequired, accountSetupReturnPath, engineeringAccountSignInPath } from "../src/lib/account-return.ts";

test("Onesa login returns only to the exact local Engineering interaction", () => {
  const path = "/engineering/sign-in/synthetic_interaction-123";
  const target = engineeringAccountSignInPath("synthetic_interaction-123");
  assert.equal(target, "/account?returnTo=" + encodeURIComponent(path));
  assert.equal(accountReturnPath(new URL(target!, "https://portal.example.test").search), path);
  for (const value of ["https://attacker.example.test/", "//attacker.example.test/", "/admin", "/account",
    path + "?next=//attacker.example.test", path + "#token", path + "/../other", "/engineering/sign-in/short",
    "/engineering/sign-in/" + "a".repeat(129), "/engineering/sign-in/\\attacker", " " + path,
    encodeURIComponent(path), path + "\n"]) {
    assert.equal(accountReturnPath("?returnTo=" + encodeURIComponent(value)), null);
  }
  assert.equal(accountReturnPath("?returnTo=" + encodeURIComponent(path) + "&returnTo=" + encodeURIComponent(path)), null);
  assert.equal(accountReturnPath("?next=/admin"), null);
  assert.equal(engineeringAccountSignInPath("../../admin"), null);
  assert.equal(accountReauthenticationRequired("?reauthenticate=1"), false);
  assert.equal(accountReauthenticationRequired(target!.slice("/account".length) + "&reauthenticate=1"), true);
  assert.equal(accountReauthenticationRequired(target!.slice("/account".length) + "&reauthenticate=1&reauthenticate=1"), false);
  assert.equal(accountReauthenticationRequired("?returnTo=https://attacker.example.test/&reauthenticate=1"), false);
});

test("MFA enrollment preserves a fixed Docs return through fresh central login", () => {
  const docs = "/engineering/sign-in/synthetic_docs_interaction";
  const product = "/account/sign-in/synthetic_product_interaction";
  assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(docs)), "/account?returnTo=" + encodeURIComponent(docs) + "&reauthenticate=1");
  assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(product)), product);
  for (const target of ["https://attacker.example.test/", "//attacker.example.test/", "/admin", docs + "?redirect=//attacker.example.test/", product + "#token", "/account?returnTo=" + encodeURIComponent(docs)]) {
    assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(target)), "/account");
  }
  assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(docs) + "&returnTo=" + encodeURIComponent(product)), "/account");
  assert.equal(accountSetupReturnPath(""), "/account");
});
