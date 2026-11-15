import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
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

test("The collector maps deployed health contracts to the administrator's observations", async () => {
  const file = join(directory, "public-observations.json");
  const transport = join(directory, "public-health-fixture.mjs");
  await writeFile(transport, `
    const health = new Map([
      ["https://factory.onesa.eu/health/live", [{ status: "live" }, 200]],
      ["https://factory.onesa.eu/health/ready", process.env.FACTORY_FIXTURE_READY === "1"
        ? [{ status: "ready" }, 200] : [{ status: "not-ready", dependency: "redis" }, 503]],
      ["https://robot.onesa.eu/api/v1/health", [{ status: "live", mode: "simulation" }, 200]],
      ["https://robot.onesa.eu/api/v1/ready", process.env.ROBOT_FIXTURE_READY === "1"
        ? [{ status: "ready", mode: "simulation", physical_actuation: false }, 200]
        : [{ detail: "Remote simulation journal requires recovery" }, 503]],
      ["https://mobile.onesa.eu/api/healthz", [{ status: "ok", serviceStatus: "prelaunch" }, 200]],
      ["https://api.pasofi.onesa.eu/health/live", [{ status: "ok", service: "gateway" }, 200]],
      ["https://portal.onesa.eu/api/v1/health", [{ status: "ok" }, 503]],
      ["https://platform.onesa.eu/ready", process.env.AI_FIXTURE_READY === "1"
        ? [{ status: "ready", backend: "cloudflare" }, 200]
        : [{ detail: "dependency_unavailable" }, 503]],
      ["https://platform.onesa.eu/health", [{ status: "ok", source_commit: "a".repeat(40) }, 200]],
      ["https://logistics.onesa.eu/health", [{ status: "ok", release: { revision: "b".repeat(40) } }, 200]],
      ["https://drone.onesa.eu/api/v1/health", [{ status: "live", source_commit: "c".repeat(40) }, 200]],
    ]);
    globalThis.fetch = async url => {
      const entry = health.get(String(url));
      return entry ? Response.json(entry[0], { status: entry[1] })
        : new Response("<html>maintenance</html>", { headers: { "Content-Type": "text/html" } });
    };
  `);
  const collector = new URL("../../scripts/observe-infrastructure.mts", import.meta.url);
  const collect = (robotReady: boolean, aiReady: boolean, factoryReady: boolean) => execFileSync(process.execPath,
    ["--import", "tsx", "--import", transport, collector.pathname, file],
    { timeout: 10000, env: { ...process.env, FACTORY_FIXTURE_READY: factoryReady ? "1" : "0", AI_FIXTURE_READY: aiReady ? "1" : "0", ROBOT_FIXTURE_READY: robotReady ? "1" : "0" } });
  collect(false, true, false);
  const result = await infrastructureOverview(file);
  assert.equal(result.observationState, "loaded");
  const states = Object.fromEntries(result.services.map(service => [service.id, service.status]));
  assert.deepEqual(states, {
    portal: "unavailable", ai: "available", robot: "unavailable", farmer: "unavailable",
    drone: "unavailable", logistics: "available", mobile: "available", factory: "unavailable",
    pasofi: "available", kubernetes: "not_observed", portainer: "not_observed",
  });
  assert.deepEqual(result.services.filter(service => service.revision !== null).map(service => [service.id, service.revision]), [
    ["ai", "a".repeat(40)], ["logistics", "b".repeat(40)],
  ]);
  collect(true, false, true);
  const recovered = await infrastructureOverview(file);
  assert.equal(recovered.services.find(service => service.id === "robot")?.status, "available");
  assert.equal(recovered.services.find(service => service.id === "factory")?.status, "available");
  const ai = recovered.services.find(service => service.id === "ai");
  assert.equal(ai?.status, "unavailable");
  assert.equal(ai?.revision, null);
});

test("Aggregation retains private observations and timestamps across scheduled public refreshes", async () => {
  const collector = new URL("../../scripts/observe-infrastructure.mts", import.meta.url);
  const output = join(directory, "published.json");
  const publicFile = await snapshot("public-source.json", [observed("portal"), observed("ai")]);
  const cluster = { ...observed("kubernetes", "available", 600000), source: "owner_runtime" };
  const localProbe = { ...observed("ai", "unavailable"), source: "owner_runtime" };
  const privateFile = await snapshot("private-source.json", [cluster, localProbe]);
  function merge(publicPath = publicFile, ownerPath = privateFile, target = output) {
    return execFileSync(process.execPath, ["--import", "tsx", collector.pathname, "--merge", publicPath, ownerPath, target],
      { timeout: 8000, stdio: "pipe" });
  }
  merge();
  const initial = await infrastructureOverview(output, now);
  assert.equal(initial.observationState, "loaded");
  const rows = Object.fromEntries(initial.services.map(row => [row.id, row]));
  assert.equal(rows.kubernetes.status, "stale");
  assert.equal(rows.kubernetes.observedAt, cluster.observedAt);
  assert.equal(rows.kubernetes.lastObservedState, "available");
  assert.equal(rows.portainer.status, "not_observed");
  assert.equal(rows.ai.source, "owner_runtime", "Private runtime takes precedence at identical observation time");
  assert.equal(rows.ai.status, "unavailable");
  const newer = { ...observed("ai"), observedAt: new Date(now + 1000).toISOString() };
  await snapshot("public-source.json", [newer]);
  merge();
  const refreshed = await infrastructureOverview(output, now + 1000);
  assert.equal(refreshed.services.find(row => row.id === "ai")?.source, "public_http");
  assert.equal(refreshed.services.find(row => row.id === "kubernetes")?.observedAt, cluster.observedAt);
  const previous = await readFile(output);
  await snapshot("public-source.json", [observed("ai", "unavailable")]);
  await snapshot("private-source.json", []);
  merge();
  assert.deepEqual(await readFile(output), previous, "A stale replay or omitted row cannot roll back the published timestamp");
  await snapshot("public-source.json", [newer]);
  await snapshot("private-source.json", [cluster]);
  const alternate = await snapshot("public-alternate.json", [observed("robot")]);
  const concurrent = join(directory, "concurrent.json");
  const asyncExec = promisify(execFile);
  await Promise.all([publicFile, alternate].map(source => asyncExec(process.execPath,
    ["--import", "tsx", collector.pathname, "--merge", source, privateFile, concurrent], {timeout: 10000})));
  const combined = await infrastructureOverview(concurrent, now + 1000);
  assert.deepEqual(combined.services.filter(row => row.observedAt).map(row => row.id), ["ai", "robot", "kubernetes"]);
  await snapshot("public-source.json", [{...newer, state:"unavailable"}]);
  assert.throws(() => merge(), "A single source cannot contradict itself at the same timestamp");
  assert.deepEqual(await readFile(output), previous);
  await snapshot("public-source.json", [newer]);
  for (const invalid of [[{...observed("robot"), source: "public_http"}], [{...cluster, environment:"staging"}],
    [{...cluster, observedAt:"2099-01-01T00:00:00Z"}], [cluster, cluster]]) {
    await snapshot("private-source.json", invalid);
    assert.throws(() => merge());
    assert.deepEqual(await readFile(output), previous);
  }
  await snapshot("private-source.json", [cluster]);
  await snapshot("public-source.json", [observed("portainer")]);
  assert.throws(() => merge());
  await snapshot("public-source.json", [newer]);
  assert.throws(() => merge(publicFile, privateFile, privateFile));
  const linked = join(directory, "private-source-link.json");
  await symlink(privateFile, linked);
  assert.throws(() => merge(publicFile, linked));
  assert.throws(() => merge(publicFile, join(directory,"missing-private-source.json")));
  assert.deepEqual(await readFile(output), previous);
});
