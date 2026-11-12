import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { serviceRegistry, snapshotSchema } from "../onesa-company-portal-backend/src/operations/infrastructure.js";

// Credential-free public liveness only. Private runtime observations are produced
// separately with scoped observer credentials, never by browser code.
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw Error("Provide an absolute snapshot output path");
const observations = await Promise.all(serviceRegistry.filter(service => service.health !== null).map(async service => {
  let state: "available" | "unavailable" | "not_observed" = "not_observed";
  let revision: string | null = null;
  if (service.health) {
    try {
      const response = await fetch(service.health, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      // An HTML maintenance page or SPA fallback must never count as healthy.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json") || !response.body) {
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
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const liveStatus = (service.id === "factory" || service.id === "robot") && data?.status === "live";
      const available = ["ok", "healthy", "ready"].includes(data?.status) || liveStatus;
      state = response.ok && available ? "available" : "unavailable";
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
