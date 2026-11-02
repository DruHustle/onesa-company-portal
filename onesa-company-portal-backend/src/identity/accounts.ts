import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { db } from "../services/db.js";
import { hash } from "../auth/crypto.js";
import { sessionAuthenticationTime } from "../auth/session-proof.js";
import { HttpError } from "../services/workflows.js";
import { products } from "./config.js";

export const accountCookie = "onesa_account";
export const isGlobalAdmin = (role: string) =>
  role === "owner" || role === "administrator";
export type IdentityAccount = {
  id: string;
  email: string;
  role: string;
  display_name: string;
  email_verified_at: Date | null;
  mfa_enrolled: boolean;
};
export async function identityAccount(
  id: string,
  connection: Pick<PoolClient, "query"> = db,
): Promise<IdentityAccount | undefined> {
  return (
    await connection.query<IdentityAccount>(
      "SELECT u.id,u.email,u.role,coalesce(p.display_name,u.email) AS display_name,p.email_verified_at,(u.mfa_secret IS NOT NULL) AS mfa_enrolled FROM users u LEFT JOIN identity_profiles p ON p.user_id=u.id WHERE u.id=$1 AND NOT u.disabled",
      [id],
    )
  ).rows[0];
}
export type AccountSession = {
  account: IdentityAccount;
  csrf: string;
  authenticatedAt: number;
  amr: string[];
  source: "account" | "portal";
  sourceHash: string;
};
export async function currentAccount(
  req: FastifyRequest,
): Promise<AccountSession | null> {
  const raw = req.cookies[accountCookie];
  if (raw && /^[a-f0-9]{64}$/.test(raw)) {
    const session = (
      await db.query(
        "SELECT user_id,csrf,authenticated_at,amr FROM identity_sessions WHERE token_hash=$1 AND expires_at>now()",
        [hash(raw)],
      )
    ).rows[0];
    const account = session && (await identityAccount(session.user_id));
    if (account)
      return {
        account,
        csrf: session.csrf,
        authenticatedAt: Math.floor(
          new Date(session.authenticated_at).getTime() / 1000,
        ),
        amr: session.amr,
        source: "account",
        sourceHash: hash(raw),
      };
  }
  const authenticatedAt = sessionAuthenticationTime(req);
  const portal = req.cookies.onesa_session;
  if (portal && authenticatedAt !== null) {
    const session = (
      await db.query(
        "SELECT user_id,csrf FROM sessions WHERE token_hash=$1 AND expires_at>now()",
        [hash(portal)],
      )
    ).rows[0];
    const account = session && (await identityAccount(session.user_id));
    if (account?.mfa_enrolled)
      return {
        account,
        csrf: session.csrf,
        authenticatedAt: Math.floor(authenticatedAt / 1000),
        amr: ["otp"],
        source: "portal",
        sourceHash: hash(portal),
      };
  }
  return null;
}
export async function requireAccount(
  req: FastifyRequest,
  mutation = false,
): Promise<AccountSession> {
  const session = await currentAccount(req);
  if (!session)
    throw new HttpError(
      401,
      "ACCOUNT_REQUIRED",
      "Sign in to your Onesa account.",
    );
  if (mutation && req.headers["x-csrf-token"] !== session.csrf)
    throw new HttpError(
      403,
      "CSRF",
      "Refresh your account before trying again.",
    );
  return session;
}
export async function accountAccess(
  account: IdentityAccount,
  connection: Pick<PoolClient, "query"> = db,
) {
  const access = (
    await connection.query(
      "SELECT product,role,status,revision FROM identity_product_access WHERE user_id=$1 ORDER BY product",
      [account.id],
    )
  ).rows;
  const memberships = (
    await connection.query(
      "SELECT tenant_id,role,label FROM identity_drone_memberships WHERE user_id=$1 ORDER BY label,tenant_id",
      [account.id],
    )
  ).rows;
  const admin = isGlobalAdmin(account.role);
  return {
    onesa_roles: admin ? ["global_admin" as const] : [],
    onesa_applications: admin
      ? [...products]
      : access
          .filter((row) => row.status === "active")
          .map((row) => row.product),
    onesa_product_roles: admin
      ? { ai: "admin", drone: "admin", robot: "admin" }
      : Object.fromEntries(
          access
            .filter((row) => row.status === "active")
            .map((row) => [row.product, row.role]),
        ),
    onesa_memberships: memberships.map((row) => ({
      product: "drone" as const,
      tenant_id: row.tenant_id,
      role: row.role,
    })),
    access,
    memberships,
  };
}
export async function revokeAccountIdentity(
  connection: Pick<PoolClient, "query">,
  userId: string,
) {
  await connection.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
    userId,
  ]);
  await connection.query(
    "DELETE FROM identity_grant_sessions WHERE user_id=$1",
    [userId],
  );
  await connection.query("DELETE FROM identity_sessions WHERE user_id=$1", [
    userId,
  ]);
  await connection.query("DELETE FROM identity_records WHERE account_id=$1", [
    userId,
  ]);
}

/** Recheck after the account lock: admission before a concurrent logout is insufficient. */
export async function lockAccountSession(
  connection: PoolClient,
  session: AccountSession,
) {
  const account = (
    await connection.query(
      "SELECT id FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
      [session.account.id],
    )
  ).rows[0];
  const table = session.source === "account" ? "identity_sessions" : "sessions";
  const current = (
    await connection.query(
      `SELECT csrf,expires_at FROM ${table} WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE`,
      [session.sourceHash, session.account.id],
    )
  ).rows[0];
  if (!account || !current || current.csrf !== session.csrf)
    throw new HttpError(
      401,
      "ACCOUNT_REQUIRED",
      "Your Onesa session has ended. Sign in again.",
    );
  return new Date(current.expires_at);
}
export async function liveGrantSession(
  grantId: string,
  userId: string,
  connection: Pick<PoolClient, "query"> = db,
) {
  const binding = (
    await connection.query(
      "SELECT source_token_hash,source_kind,authenticated_at,amr,expires_at FROM identity_grant_sessions WHERE grant_id=$1 AND user_id=$2 AND expires_at>now()",
      [grantId, userId],
    )
  ).rows[0];
  if (!binding) return null;
  const table =
    binding.source_kind === "account" ? "identity_sessions" : "sessions";
  const source = (
    await connection.query(
      `SELECT expires_at FROM ${table} WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()`,
      [binding.source_token_hash, userId],
    )
  ).rows[0];
  return source
    ? {
        authenticatedAt: Math.floor(
          new Date(binding.authenticated_at).getTime() / 1000,
        ),
        amr: binding.amr as string[],
        expiresAt: Math.floor(
          Math.min(
            new Date(binding.expires_at).getTime(),
            new Date(source.expires_at).getTime(),
          ) / 1000,
        ),
      }
    : null;
}
