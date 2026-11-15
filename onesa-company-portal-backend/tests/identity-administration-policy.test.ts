import assert from "node:assert/strict";
import { test } from "node:test";
import { delegatedAccountOperation, externalIdentityAdministration } from "../src/identity/administration.js";

test("global account administration is delegated outside isolated test runs", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdministration = process.env.ONESA_IDENTITY_ADMINISTRATION;
  try {
    delete process.env.ONESA_IDENTITY_ADMINISTRATION;
    process.env.NODE_ENV = "production";
    assert.equal(externalIdentityAdministration(), true);
    process.env.NODE_ENV = "development";
    assert.equal(externalIdentityAdministration(), true);
    process.env.NODE_ENV = "test";
    assert.equal(externalIdentityAdministration(), false);
    process.env.ONESA_IDENTITY_ADMINISTRATION = "external";
    assert.equal(externalIdentityAdministration(), true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdministration === undefined) delete process.env.ONESA_IDENTITY_ADMINISTRATION;
    else process.env.ONESA_IDENTITY_ADMINISTRATION = previousAdministration;
  }
});

test("Portal delegates every global account and approval operation", () => {
  for (const operation of [
    "listUsers", "createUser", "updateUser", "listAccessRequests", "reviewAccessRequest",
    "listEngineeringMemberships", "saveEngineeringMembership", "listOnesaAccounts",
    "setOnesaMemberStatus", "setOnesaProductAccess", "setOnesaAdministrator",
    "requestAccessRegistration", "confirmAccessRegistration", "enrollOnesaAdministratorForDocs",
    "registerOnesaAccount", "confirmOnesaAccount", "requestOnesaProductAccess",
  ]) assert.equal(delegatedAccountOperation(operation), true, operation);
  assert.equal(delegatedAccountOperation("createContent"), false);
});
