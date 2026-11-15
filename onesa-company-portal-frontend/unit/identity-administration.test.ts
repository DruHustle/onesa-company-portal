import assert from "node:assert/strict";
import { test } from "node:test";
import { identityAdministrationRequired, identityAdministrationUrl } from "../src/lib/identity-administration.ts";

const keys = ["NODE_ENV", "ONESA_IDENTITY_ADMINISTRATION", "ONESA_IDENTITY_UI_ORIGIN", "PORTAL_URL", "PUBLIC_ORIGIN", "SITE_URL"] as const;
function withEnvironment(values: Record<string, string>, run: () => void) {
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { run(); }
  finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("deployed Portal always delegates global account administration and fails closed without a link", () => {
  withEnvironment({ NODE_ENV: "production" }, () => {
    assert.equal(identityAdministrationRequired(), true);
    assert.equal(identityAdministrationUrl(), null);
  });
  withEnvironment({ NODE_ENV: "development" }, () => {
    assert.equal(identityAdministrationRequired(), true);
    assert.equal(identityAdministrationUrl(), null);
  });
});

test("Portal and company-site origins are never accepted as the Identity administration destination", () => {
  for (const key of ["PORTAL_URL", "PUBLIC_ORIGIN", "SITE_URL"] as const) {
    withEnvironment({ NODE_ENV: "production", [key]: "https://portal.example.test", ONESA_IDENTITY_UI_ORIGIN: "https://portal.example.test" }, () => {
      assert.equal(identityAdministrationRequired(), true);
      assert.equal(identityAdministrationUrl(), null);
    });
  }
});

test("only an exact HTTPS Identity origin receives the fixed account-admin destination", () => {
  withEnvironment({ NODE_ENV: "test", ONESA_IDENTITY_ADMINISTRATION: "external", ONESA_IDENTITY_UI_ORIGIN: "https://identity.example.test" }, () => {
    assert.equal(identityAdministrationRequired(), true);
    assert.equal(identityAdministrationUrl(), "https://identity.example.test/admin#accounts");
  });
  for (const origin of ["http://identity.example.test", "https://identity.example.test/", "https://user:pass@identity.example.test", "not a URL"]) {
    withEnvironment({ NODE_ENV: "production", ONESA_IDENTITY_UI_ORIGIN: origin }, () => {
      assert.equal(identityAdministrationRequired(), true);
      assert.equal(identityAdministrationUrl(), null);
    });
  }
});
