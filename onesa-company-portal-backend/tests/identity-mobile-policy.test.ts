import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mobileRoles,
  defaultProductRole,
  validProductRole,
  productRequiresMfa,
} from "../src/identity/config.js";

test("Mobile defaults to customer and every staff role requires MFA without changing existing product roles", () => {
  assert.equal(defaultProductRole("mobile"), "customer");
  assert.equal(defaultProductRole("ai"), "user");
  assert.equal(defaultProductRole("drone"), "viewer");
  assert.equal(defaultProductRole("robot"), "viewer");
  for (const role of mobileRoles) {
    assert.equal(validProductRole("mobile", role), true);
    assert.equal(productRequiresMfa("mobile", role), role !== "customer");
    if (role !== "admin")
      for (const product of ["ai", "drone", "robot"] as const)
        assert.equal(validProductRole(product, role), false);
  }
  for (const role of ["user", "viewer", "operator", "owner"])
    assert.equal(validProductRole("mobile", role), false);
  for (const product of ["ai", "drone", "robot"]) {
    assert.equal(productRequiresMfa(product, "admin"), true);
    assert.equal(
      productRequiresMfa(product, product === "ai" ? "user" : "operator"),
      false,
    );
  }
});
