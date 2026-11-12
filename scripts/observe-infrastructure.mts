import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { serviceRegistry, snapshotSchema } from "../onesa-company-portal-backend/src/operations/infrastructure.js";

// Credential-free public API probes. Private runtime observations are produced
// separately with scoped observer credentials, never by browser code.
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw Error("Provide an absolute snapshot output path");
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

const observations = await Promise.all(serviceRegistry.filter(service => service.health !== null).map(async service => {
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
const result = snapshotSchema.parse({ version: 1, observations });
await mkdir(dirname(output), { recursive: true });
const temporary = output + "." + randomUUID() + ".tmp";
await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
await chmod(temporary, 0o600);
await rename(temporary, output);
console.log(JSON.stringify({ observed: observations.length, available: observations.filter(item => item.state === "available").length, unavailable: observations.filter(item => item.state === "unavailable").length, notObserved: observations.filter(item => item.state === "not_observed").length }));
