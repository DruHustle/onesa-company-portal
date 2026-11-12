import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { infrastructureOverview } from "../src/operations/infrastructure.js";
const directory = await mkdtemp(join(tmpdir(), "onesa-infrastructure-"));
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.parse("2026-11-11T12:00:00Z");
async function snapshot(name: string, observations: unknown[]) {
  const file = join(directory, name);
  await writeFile(file, JSON.stringify({ version: 1, observations }), { mode: 0o600 });
  return file;
}
const observed = (id: string, state = "available", age = 0) => ({ id, state, observedAt: new Date(now - age).toISOString(), source: "public_http", environment: "production", revision: null });
test("All nine products and both management services remain unknown without observations", async () => {
  const view = await infrastructureOverview("", now);
  assert.equal(view.services.length, 11);
  assert.equal(view.observationState, "not_configured");
  assert.ok(view.services.every(service => service.status === "not_observed" && service.observedAt === null));
});
test("Recent failure, stale success and missing evidence have distinct states", async () => {
  const file = await snapshot("states.json", [observed("portal"), observed("ai", "unavailable"), observed("factory", "available", 300000)]);
  const view = await infrastructureOverview(file, now);
  assert.equal(view.observationState, "loaded");
  assert.equal(view.services.find(item => item.id === "portal")!.status, "available");
  assert.equal(view.services.find(item => item.id === "ai")!.status, "unavailable");
  assert.equal(view.services.find(item => item.id === "factory")!.status, "stale");
  assert.equal(view.services.find(item => item.id === "factory")!.lastObservedState, "available");
  assert.equal(view.services.find(item => item.id === "kubernetes")!.status, "not_observed");
});
test("Malformed, duplicate, future and secret-bearing observations fail closed", async () => {
  for (const [name, observations] of Object.entries({
    future: [observed("portal", "available", -1)], duplicate: [observed("portal"), observed("portal")],
    unknown: [observed("foreign-service")], secret: [{ ...observed("portal"), token: "must-not-escape" }],
  })) {
    const view = await infrastructureOverview(await snapshot(name + ".json", observations), now);
    assert.equal(view.observationState, "unavailable");
    assert.ok(view.services.every(service => service.status === "not_observed"));
    assert.ok(!JSON.stringify(view).includes("must-not-escape"));
  }
});
test("Missing, oversized, writable or symlinked files cannot report healthy infrastructure", async () => {
  const writable = await snapshot("writable.json", [observed("portal")]);
  await chmod(writable, 0o666);
  const large = join(directory, "large.json"); await writeFile(large, " ".repeat(65537));
  const target = await snapshot("target.json", [observed("portal")]);
  const link = join(directory, "link.json"); await symlink(target, link);
  for (const file of [join(directory, "missing"), writable, large, link, "relative.json"])
    assert.equal((await infrastructureOverview(file, now)).observationState, "unavailable");
});
test("A FIFO without a writer is rejected without blocking a filesystem worker", () => {
  const fifo = join(directory, "observations.pipe");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  // Isolate the regression: a blocked filesystem open cannot be cancelled by a
  // Promise timeout, so kill the child if the regular-file guard is unreachable.
  const moduleUrl = new URL("../src/operations/infrastructure.js", import.meta.url).href;
  const script = `const { infrastructureOverview } = await import(process.argv[1]);
    const result = await infrastructureOverview(process.argv[2]);
    if (result.observationState !== "unavailable" || result.services.some(service => service.status !== "not_observed")) process.exit(1);`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, moduleUrl, fifo],
    { timeout: 5000, killSignal: "SIGKILL", stdio: "pipe" });
});
