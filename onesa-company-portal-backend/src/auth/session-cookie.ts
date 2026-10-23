import type { FastifyReply, FastifyRequest } from "fastify";
import { mfaSessionCookie, mfaSessionLifetime, signSessionAuthentication } from "./session-proof.js";
import { env } from "../config/env.js";

const preference = "onesa_remember_browser";
const options = () => ({ httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "strict" as const, path: "/" });
/** Persistence only: the server still expires sessions after eight hours and requires MFA. */
export function setSessionCookie(reply: FastifyReply, session: string, rememberBrowser: boolean, authenticatedAt: number | null) {
  const evidence = authenticatedAt !== null && Date.now() - authenticatedAt < mfaSessionLifetime ? signSessionAuthentication(session, authenticatedAt) : null;
  reply.setCookie("onesa_session", session, { ...options(), ...(rememberBrowser ? { maxAge: 28800 } : {}) });
  if (rememberBrowser) reply.setCookie(preference, "1", { ...options(), maxAge: 28800 });
  else reply.clearCookie(preference, options());
  if (evidence !== null && authenticatedAt !== null) {
    const remaining = Math.max(1, Math.floor((authenticatedAt + mfaSessionLifetime - Date.now()) / 1000));
    reply.setCookie(mfaSessionCookie, evidence, { ...options(), ...(rememberBrowser ? { maxAge: remaining } : {}) });
  } else reply.clearCookie(mfaSessionCookie, options());
}
/** This cookie never authenticates a request or changes server-side expiry. */
export function remembersBrowser(request: FastifyRequest) { return request.cookies[preference] === "1"; }
export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie("onesa_session", options());
  reply.clearCookie(preference, options());
  reply.clearCookie(mfaSessionCookie, options());
}
