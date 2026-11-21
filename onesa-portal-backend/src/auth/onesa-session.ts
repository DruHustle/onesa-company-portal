import { sessionAuthenticationTime } from "./session-proof.js";
import type { FastifyRequest } from "fastify";
import { hash } from "./crypto.js";
import { db } from "../services/db.js";

/** Reuse an already MFA-authenticated Onesa identity, never infer product membership. */
export async function onesaSession(request: FastifyRequest) {
  const raw = request.cookies.onesa_session, authenticatedAt = sessionAuthenticationTime(request);
  if (!raw || authenticatedAt === null || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const user = (await db.query<{id:string;email:string}>(
    "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.mfa_secret IS NOT NULL",
    [hash(raw)],
  )).rows[0];
  return user ? { ...user, authenticated_at: new Date(authenticatedAt) } : null;
}
