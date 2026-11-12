import assert from "node:assert/strict";
import test from "node:test";
import { adminAccountEntry, adminWorkspaceReturn, accountDestination, docsAccountPath, accountReturnPath, accountReauthenticationRequired, accountSetupReturnPath, engineeringAccountSignInPath } from "../src/lib/account-return.ts";

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
  assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent("/admin")), "/account?next=/admin");
  for (const target of ["https://attacker.example.test/", "//attacker.example.test/", "/admin?next=/engineering", docs + "?redirect=//attacker.example.test/", product + "#token", "/account?returnTo=" + encodeURIComponent(docs)]) {
    assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(target)), "/account");
  }
  assert.equal(accountSetupReturnPath("?returnTo=" + encodeURIComponent(docs) + "&returnTo=" + encodeURIComponent(product)), "/account");
  assert.equal(accountSetupReturnPath(""), "/account");
});

test("shared registration retains one bounded, local destination", () => {
  const uid = "synthetic_docs_destination";
  assert.equal(docsAccountPath(uid), "/account?docs=" + uid);
  assert.equal(accountDestination("?docs=" + uid), "/account?docs=" + uid);
  assert.equal(accountDestination("?returnTo=" + encodeURIComponent("/engineering/sign-in/" + uid)), "/account?docs=" + uid);
  for (const next of ["/admin", "/engineering", "/account/delete"]) assert.equal(accountDestination("?next=" + next), "/account?next=" + next);
  for (const query of ["?docs=short", "?docs=" + uid + "&docs=" + uid, "?docs=" + uid + "&next=/admin", "?next=//example.test", "?returnTo=/admin", "?next=/admin&next=/engineering"]) assert.equal(accountDestination(query), "/account");
});

test("staff sign-in restores only Portal workspace filters and privacy anchors", () => {
  const original = new URL("https://portal.example.invalid/admin?section=Users&page=2&unrelated=private#privacy/documents/abc-123");
  const entry = new URL(adminAccountEntry(original), original.origin);
  assert.equal(entry.pathname, "/account");
  assert.equal(entry.search, "?next=/admin");
  assert.equal(adminWorkspaceReturn(entry.hash), "/admin?section=Users&page=2#privacy/documents/abc-123");
  assert.equal(adminAccountEntry(new URL("/admin#access-link=secret", original)), "/account?next=/admin");
  for (const hash of ["#workspace=https%3A%2F%2Fother.example", "#workspace=//other.example", "#workspace=%23access-link%3Dsecret", "#workspace=%3FreturnTo%3D%2F%2Fother.example", "#workspace=%23privacy&workspace=%3Fpage%3D2"]) {
    assert.equal(adminWorkspaceReturn(hash), "/admin");
  }
});
