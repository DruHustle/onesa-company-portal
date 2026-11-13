import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type InfrastructureObservation, readInfrastructureSnapshot, serviceRegistry, snapshotSchema } from "../onesa-company-portal-backend/src/operations/infrastructure.js";

async function readPublicProbe(url: string) {
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
  // An HTML maintenance page or SPA fallback must never count as healthy.
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json") || !response.body) {
    await response.body?.cancel();
    throw Error("Expected JSON health response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        throw Error("Health response exceeds 16 KiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function publicObservations() {
  return Promise.all(serviceRegistry.filter(service => service.health !== null).map(async service => {
    let state: "available" | "unavailable" | "not_observed" = "not_observed";
    let revision: string | null = null;
    if (service.health) {
      try {
        const [data, ready] = await Promise.all([
          readPublicProbe(service.health),
          service.id === "ai" ? readPublicProbe("https://platform.onesa.eu/ready") : undefined,
        ]);
        // A live Robot process can still reject operator work during journal recovery.
        const available = service.id === "robot"
          ? data?.status === "ready"
          : ["ok", "healthy", "ready"].includes(data?.status) || (service.id === "factory" && data?.status === "live");
        state = available && (service.id !== "ai" || ready?.status === "ready") ? "available" : "unavailable";
        // Only these two APIs publish the revision of their responding backend.
        const reported = service.id === "ai" ? data?.source_commit
          : service.id === "logistics" ? data?.release?.revision : null;
        if (state === "available" && typeof reported === "string" && /^[a-f0-9]{40}$/.test(reported))
          revision = reported;
      } catch { state = "unavailable"; }
    }
    return { id: service.id, observedAt: new Date().toISOString(), state, source: "public_http" as const, environment: "production" as const, revision };
  }));
}

async function publish(output: string, observations: InfrastructureObservation[]) {
  const result = snapshotSchema.parse({ version: 1, observations });
  const temporary = output + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  console.log(JSON.stringify({ observed: observations.length, available: observations.filter(item => item.state === "available").length, unavailable: observations.filter(item => item.state === "unavailable").length, notObserved: observations.filter(item => item.state === "not_observed").length }));
}

// Zod accepts UTC timestamps with differing subsecond precision. Compare the
// full fractional value while retaining the producer's original timestamp.
function timestampKey(value: string) {
  const seconds = new Date(value).toISOString().slice(0, 19);
  const fraction = /\.(\d+)Z$/.exec(value)?.[1].replace(/0+$/, "") ?? "";
  return seconds + "." + fraction;
}

const publicIds = new Set<string>(serviceRegistry.filter(service => service.health !== null).map(service => service.id));
function selectObservations(rows: InfrastructureObservation[]) {
  const selected = new Map<string, InfrastructureObservation>();
  for (const row of rows) {
    if (row.environment !== "production" || (row.source === "public_http" && !publicIds.has(row.id)))
      throw Error("Unexpected observation source or environment");
    const prior = selected.get(row.id);
    if (prior) {
      const time = timestampKey(row.observedAt), previous = timestampKey(prior.observedAt);
      if (time < previous) continue;
      if (time === previous) {
        if (row.source === prior.source && (row.state !== prior.state || row.revision !== prior.revision))
          throw Error("Conflicting observations with the same timestamp and source");
        if (prior.source === "owner_runtime" || row.source === prior.source) continue;
      }
    }
    selected.set(row.id, row);
  }
  return serviceRegistry.flatMap(service => {
    const row = selected.get(service.id);
    return row ? [row] : [];
  });
}

async function merge(publicFile: string, privateFile: string, output: string) {
  const files = [publicFile, privateFile, output];
  if (!files.every(file => isAbsolute(file))) throw Error("Absolute snapshot paths required");
  // Resolve directory aliases without following an input file's final symlink.
  const canonical = await Promise.all(files.map(async file => join(await realpath(dirname(file)), basename(file))));
  if (new Set(canonical).size !== files.length) throw Error("Three distinct snapshot paths required");
  const directory = await open(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    if ((await directory.stat()).mode & 0o022) throw Error("Protected output directory required");
    // flock locks the inherited open file description. The parent keeps it
    // through the rename; process exit releases it without stale lock files.
    execFileSync("flock", ["-x", "-w", "10", "3"], { stdio: ["ignore", "ignore", "ignore", directory.fd] });
    const [publicSnapshot, privateSnapshot] = await Promise.all([readInfrastructureSnapshot(publicFile), readInfrastructureSnapshot(privateFile)]);
    if (publicSnapshot.observations.some(row => row.source !== "public_http") || privateSnapshot.observations.some(row => row.source !== "owner_runtime"))
      throw Error("Observation does not belong to its producer");
    let prior: InfrastructureObservation[] = [];
    try { prior = (await readInfrastructureSnapshot(output)).observations; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await publish(output, selectObservations([...prior, ...publicSnapshot.observations, ...privateSnapshot.observations]));
  } finally { await directory.close(); }
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && isAbsolute(args[0])) {
    await mkdir(dirname(args[0]), { recursive: true });
    await publish(args[0], await publicObservations());
  } else if (args.length === 4 && args[0] === "--merge") {
    await merge(args[1], args[2], args[3]);
  } else { throw Error("Usage: observe-infrastructure.mts OUTPUT or --merge PUBLIC PRIVATE OUTPUT"); }
} catch {
  console.error("Infrastructure observation publication failed. Check the mode, protected paths, snapshot sources and UTC timestamps.");
  process.exitCode = 1;
}
