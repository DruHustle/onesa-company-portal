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
export const productNames = { ai: "Onesa AI", drone: "Onesa Drone", robot: "Onesa Robot" };
export type Product = keyof typeof productNames;
export type Account = { id: string; email: string; name: string; globalAdmin: boolean; owner: boolean; portalAccess: boolean; emailVerified: boolean; mfaEnrolled: boolean };
export type Access = { product: Product; role: string; status: "pending" | "active" | "revoked" | "rejected"; revision: number };
export type Membership = { tenant_id: string; role: "viewer" | "operator" | "admin"; label: string };
export type AccountSession = { account: Account; csrf: string; access: Access[]; memberships: Membership[]; applications: { product: Product; url: string }[] };
