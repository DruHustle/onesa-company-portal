import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceRegistry } from "../src/operations/infrastructure.js";

// An application link is diagnostic navigation, never evidence of private
// Kubernetes or Portainer health. Both remain owner-runtime-only observations.
test("Portainer diagnostics open the protected Onesa console, not Docs or the Portal landing page", () => {
  const portainer = serviceRegistry.find(service => service.id === "portainer");
  assert.ok(portainer, "The infrastructure service registry must include Portainer");
  assert.equal(portainer.url, "https://portainer.onesa.eu");
  assert.equal(portainer.health, null);
  assert.equal(new URL(portainer.url).protocol, "https:");
});

test("Kubernetes and Portainer require private runtime checks", () => {
  const privateIds = new Set(["kubernetes", "portainer"]);
  const privateServices = serviceRegistry.filter(service => privateIds.has(service.id));
  assert.equal(privateServices.length, privateIds.size);
  assert.ok(privateServices.every(service => service.health === null));
});
