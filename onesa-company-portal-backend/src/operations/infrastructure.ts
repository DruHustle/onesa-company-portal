import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Role } from "../access/roles.js";
import { error } from "../api/contracts.js";

// Deployment plans do not prove runtime health. Only timestamped observations
// below can produce an available/unavailable result.
export const serviceRegistry = [
  { id: "portal", name: "Company Portal", hosting: "Vercel frontend · Oracle API", url: "https://portal.onesa.eu", health: "https://portal.onesa.eu/api/v1/health", dependencies: ["Portal PostgreSQL", "private file storage", "email", "scanner"] },
  { id: "ai", name: "Onesa AI Platform", hosting: "Vercel frontend · Oracle API", url: "https://platform.onesa.eu", health: "https://platform.onesa.eu/health", dependencies: ["Portal identity", "PostgreSQL/pgvector", "configured inference provider"] },
  { id: "robot", name: "Onesa Robot", hosting: "Vercel frontend · independent Robot API", url: "https://robot.onesa.eu", health: "https://robot.onesa.eu/api/v1/health", dependencies: ["Portal identity", "Robot API", "supervised device bridge"] },
  { id: "farmer", name: "Smart Farmer", hosting: "Independent Farmer service; hosting requires readback", url: "https://farmer.onesa.eu", health: "https://farmer.onesa.eu/health", dependencies: ["Portal identity", "Farmer PostgreSQL", "field gateways"] },
  { id: "drone", name: "Onesa Drone", hosting: "Vercel frontend · independent Drone API", url: "https://drone.onesa.eu", health: "https://drone.onesa.eu/api/v1/health", dependencies: ["Portal identity", "Drone database", "supported aircraft interface"] },
  { id: "logistics", name: "Smart Logistics", hosting: "Vercel frontend · Oracle services", url: "https://logistics.onesa.eu", health: "https://logistics.onesa.eu/health", dependencies: ["Portal identity", "Logistics database", "warehouse/GPS integrations"] },
  { id: "mobile", name: "Onesa Mobile", hosting: "Vercel frontend · independent Mobile API", url: "https://mobile.onesa.eu", health: "https://mobile.onesa.eu/api/healthz", dependencies: ["Portal identity", "Mobile database", "provider activation pending"] },
  { id: "factory", name: "Smart Factory", hosting: "Vercel frontend · Oracle API/workers · field edge", url: "https://factory.onesa.eu", health: "https://factory.onesa.eu/health/live", dependencies: ["Factory database", "Node-RED", "Python Edge Agent", "MQTT/TLS", "BaSyx"] },
  { id: "pasofi", name: "PasoFi", hosting: "Vercel frontend · Oracle services · site routers", url: "https://pasofi.mobile.onesa.eu", health: "https://api.pasofi.onesa.eu/health/live", dependencies: ["Portal identity", "PasoFi databases", "Stripe", "RADIUS", "site routers"] },
  { id: "kubernetes", name: "Kubernetes", hosting: "Private k3s cluster on Oracle Onesa UG Backend", url: "https://docs.engineering.onesa.eu", health: null, dependencies: ["qualified VM", "private cluster API", "persistent volumes"] },
  { id: "portainer", name: "Portainer", hosting: "Private Kubernetes service on Oracle Onesa UG Backend", url: "https://docs.engineering.onesa.eu", health: null, dependencies: ["Kubernetes", "private authenticated management access"] },
] as const;
const serviceId = z.enum(serviceRegistry.map(service => service.id));
const observation = z.object({
  id: serviceId,
  observedAt: z.iso.datetime(),
  state: z.enum(["available", "unavailable", "not_observed"]),
  source: z.enum(["public_http", "owner_runtime"]),
  environment: z.enum(["production", "staging", "local"]),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
}).strict();
export const snapshotSchema = z.object({ version: z.literal(1), observations: z.array(observation).max(serviceRegistry.length) }).strict()
  .refine(value => new Set(value.observations.map(item => item.id)).size === value.observations.length, "Duplicate service observation");
export const infrastructureSchema = z.object({
  checkedAt: z.iso.datetime(), staleAfterSeconds: z.literal(300),
  observationState: z.enum(["loaded", "not_configured", "unavailable"]),
  services: z.array(z.object({
    id: serviceId, name: z.string(), hosting: z.string(), url: z.url(), dependencies: z.array(z.string()),
    status: z.enum(["available", "unavailable", "not_observed", "stale"]),
    lastObservedState: observation.shape.state.nullable(), observedAt: z.iso.datetime().nullable(),
    source: observation.shape.source.nullable(), environment: observation.shape.environment.nullable(),
    revision: observation.shape.revision, scope: z.string(),
  })),
});
export async function infrastructureOverview(file = process.env.INFRASTRUCTURE_OBSERVATIONS_FILE, now = Date.now()) {
  let observations: z.infer<typeof observation>[] = [];
  let observationState: "loaded" | "not_configured" | "unavailable" = "not_configured";
  if (file) {
    let handle;
    try {
      if (!isAbsolute(file)) throw Error("Absolute observation file required");
      // A FIFO must reach the regular-file check without waiting for a writer.
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022) !== 0) throw Error("Unsafe observation file");
      // Bound allocation even if a producer changes the file after fstat.
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw Error("Oversized observation file");
      const content = buffer.toString("utf8", 0, bytesRead);
      observations = snapshotSchema.parse(JSON.parse(content)).observations;
      if (observations.some(item => Date.parse(item.observedAt) > now)) throw Error("Future observation");
      observationState = "loaded";
    } catch { observationState = "unavailable"; observations = []; }
    finally { await handle?.close(); }
  }
  return infrastructureSchema.parse({
    checkedAt: new Date(now).toISOString(), staleAfterSeconds: 300, observationState,
    services: serviceRegistry.map(service => {
      const observed = observations.find(item => item.id === service.id);
      return { id: service.id, name: service.name, hosting: service.hosting, url: service.url,
        dependencies: [...service.dependencies],
        status: !observed ? "not_observed" : now - Date.parse(observed.observedAt) >= 300000 ? "stale" : observed.state,
        lastObservedState: observed?.state ?? null, observedAt: observed?.observedAt ?? null,
        source: observed?.source ?? null, environment: observed?.environment ?? null, revision: observed?.revision ?? null,
        scope: observed?.source === "public_http" ? "Public API liveness only; account, provider and customer journeys require separate acceptance." : "Private runtime observation required for workloads, storage and operational readiness.",
      };
    }),
  });
}
export async function registerInfrastructure(app: FastifyInstance, allow: (roles: readonly Role[]) => (req: FastifyRequest) => Promise<void>) {
  app.withTypeProvider<ZodTypeProvider>().get("/api/v1/admin/infrastructure", {
    preHandler: allow(["administrator"]),
    schema: { operationId: "infrastructureOverview", tags: ["Infrastructure"], security: [{ sessionCookie: [] }],
      description: "Administrator-only sanitized, timestamped infrastructure observations. No provider credentials or raw diagnostics.",
      response: { 200: infrastructureSchema, 400: error, 401: error, 403: error, 500: error, 503: error } },
  }, async () => infrastructureOverview());
}
