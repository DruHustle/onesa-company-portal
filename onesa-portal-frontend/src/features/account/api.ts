export class AccountError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function accountRequest<T>(path: string, input?: unknown, csrf?: string, method = "POST"): Promise<T> {
  const response = await fetch(path, {
    method: input === undefined ? "GET" : method,
    credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: input === undefined ? {} : { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new AccountError(body?.error?.message || "The request could not be completed. Please try again.", body?.error?.code || "REQUEST_FAILED", response.status);
  return body as T;
}
export const productNames = { ai: "Onesa AI Platform", drone: "Onesa Drone", robot: "Onesa Robot", mobile: "Onesa Mobile", farmer: "Smart Farmer", logistics: "Smart Logistics", pasofi: "PasoFi", factory: "Smart Factory" };
export const adminProductNames = {};
export type Product = keyof typeof productNames;
export type ApplicationProduct = Product | keyof typeof adminProductNames;
export function enabledProducts(applications: { product: ApplicationProduct }[]): Product[] {
  return (Object.keys(productNames) as Product[]).filter(product => ["ai", "drone", "robot"].includes(product) || applications.some(application => application.product === product));
}

export const futureProductNames = { farmer: "Smart Farmer", logistics: "Smart Logistics", factory: "Smart Factory", pasofi: "PasoFi", mobile: "Onesa Mobile" };
export type ProductCatalog = { product: Product | "portal" | "engineering"; name: string; connected: boolean }[];
export type AccountConfig = { enabled: boolean; applications?: { product: ApplicationProduct }[]; catalog?: ProductCatalog };
export type Account = { id: string; email: string; name: string; globalAdmin: boolean; owner: boolean; portalAccess: boolean; emailVerified: boolean; mfaEnrolled: boolean };
export type Access = { product: Product; role: string; status: "pending" | "active" | "revoked" | "rejected"; revision: number };
export type Membership = { tenant_id: string; role: "viewer" | "operator" | "admin"; label: string };
export type AccountSession = { account: Account; csrf: string; access: Access[]; memberships: Membership[]; applications: { product: ApplicationProduct; url: string }[]; catalog?: ProductCatalog };
