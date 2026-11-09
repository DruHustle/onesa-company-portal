import type { IdentityConfig } from "./config.js";

// Recognition is not commissioning: only the existing fixed-client registry may
// connect an application. Catalog entries never grant access or accept callbacks.
export const catalogProducts = [
  "ai",
  "drone",
  "robot",
  "farmer",
  "logistics",
  "factory",
  "pasofi",
  "mobile",
] as const;
const names: Record<(typeof catalogProducts)[number], string> = {
  ai: "Onesa AI",
  drone: "Onesa Drone",
  robot: "Onesa Robot",
  farmer: "Smart Farmer",
  logistics: "Smart Logistics",
  factory: "Smart Factory",
  pasofi: "PasoFi",
  mobile: "Onesa Mobile",
};
export function identityCatalog(config: IdentityConfig | null) {
  return catalogProducts.map((product) => ({
    product,
    name: names[product],
    connected: Boolean(
      config?.clients.some((client) => client.product === product),
    ),
  }));
}
