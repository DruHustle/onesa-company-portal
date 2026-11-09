import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";

export const identityPath = "/api/v1/identity";
export const products = ["ai", "drone", "robot", "mobile"] as const;
export const mobileRoles = [
  "admin",
  "operations",
  "support",
  "finance",
  "agent",
  "auditor",
  "customer",
] as const;
export function defaultProductRole(product: Product): string {
  return product === "ai"
    ? "user"
    : product === "mobile"
      ? "customer"
      : "viewer";
}
export function validProductRole(product: Product, role: string): boolean {
  const allowed: readonly string[] =
    product === "ai"
      ? ["user", "admin"]
      : product === "mobile"
        ? mobileRoles
        : ["viewer", "operator", "admin"];
  return allowed.includes(role);
}
export function productRequiresMfa(product: string, role: unknown): boolean {
  return (
    role === "admin" ||
    (product === "mobile" && typeof role === "string" && role !== "customer")
  );
}
export type Product = (typeof products)[number];
const absoluteHttps = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const client = z
  .object({
    product: z.enum(products),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    clientSecret: z.string().min(48).max(256),
    redirectUri: absoluteHttps,
    applicationUrl: absoluteHttps,
  })
  .strict();
const schema = z
  .object({
    issuer: absoluteHttps,
    clients: z.array(client).min(1).max(4),
    cookieKeys: z.array(z.string().min(48).max(256)).min(1).max(2),
    jwks: z
      .object({ keys: z.array(z.record(z.string(), z.string())).length(1) })
      .strict(),
  })
  .strict();
export type IdentityConfig = z.infer<typeof schema>;
export type IdentityClient = IdentityConfig["clients"][number];
/** Explicit, independent issuer; no guessed host, client, wildcard callback or secret. */
export function identityConfiguration(
  values: NodeJS.ProcessEnv,
  origin: string,
): IdentityConfig | null {
  if (values.ONESA_IDENTITY_ENABLED !== "true") return null;
  try {
    const raw = values.ONESA_IDENTITY_CONFIG_B64;
    if (!raw || raw.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
      throw Error();
    const config = schema.parse(
      JSON.parse(Buffer.from(raw, "base64").toString("utf8")),
    );
    if (config.issuer !== origin + identityPath) throw Error();
    for (const key of [
      "product",
      "clientId",
      "clientSecret",
      "redirectUri",
    ] as const)
      if (
        new Set(config.clients.map((c) => c[key])).size !==
        config.clients.length
      )
        throw Error();
    for (const c of config.clients) {
      if (new URL(c.redirectUri).origin !== new URL(c.applicationUrl).origin)
        throw Error();
      if (new URL(c.redirectUri).pathname === "/") throw Error();
    }
    const key = config.jwks.keys[0];
    if (
      key.kty !== "RSA" ||
      key.alg !== "RS256" ||
      key.use !== "sig" ||
      !key.d ||
      !key.p ||
      !key.q ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(key.kid ?? "")
    )
      throw Error();
    const privateKey = createPrivateKey({ key, format: "jwk" });
    if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw Error();
    createPublicKey(privateKey);
    return config;
  } catch {
    throw Error("Onesa identity configuration rejected");
  }
}
