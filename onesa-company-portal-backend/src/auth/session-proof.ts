import type { FastifyRequest } from "fastify";
import { Signer } from "@fastify/cookie";
import { createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { hash } from "./crypto.js";

export const mfaSessionCookie = "onesa_mfa_session";
export const mfaSessionLifetime = 28800_000;
// A purpose-separated key prevents other application cookies from becoming MFA evidence.
const signer = new Signer(createHmac("sha256", env.SESSION_KEY).update("onesa:portal-mfa-session:v1").digest());
function validTime(at: unknown): at is number {
  const now = Date.now();
  return typeof at === "number" && Number.isSafeInteger(at) && at > 0 && at <= now && now - at < mfaSessionLifetime;
}
/** Called only after successful MFA; contains no password, factor key or bearer token. */
export function signSessionAuthentication(session: string, at: number): string {
  if (!/^[a-f0-9]{64}$/.test(session) || !validTime(at)) throw new Error("Invalid session authentication evidence");
  return signer.sign(Buffer.from(JSON.stringify([1, hash(session), at])).toString("base64url"));
}
/** A legacy/renewed timestamp alone is never proof of when MFA occurred. */
export function sessionAuthenticationTime(request: Pick<FastifyRequest, "cookies">): number | null {
  const session = request.cookies.onesa_session, proof = request.cookies[mfaSessionCookie];
  if (!session || !/^[a-f0-9]{64}$/.test(session) || !proof || proof.length > 512) return null;
  try {
    const checked = signer.unsign(proof);
    if (!checked.valid || !checked.value) return null;
    const value: unknown = JSON.parse(Buffer.from(checked.value, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== hash(session) || !validTime(value[2])) return null;
    return value[2];
  } catch { return null; }
}
