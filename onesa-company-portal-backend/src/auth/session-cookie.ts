import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

const preference = "onesa_remember_browser";
const options = () => ({ httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "strict" as const, path: "/" });
/** Persistence only: the server still expires sessions after eight hours and requires MFA. */
export function setSessionCookie(reply: FastifyReply, session: string, rememberBrowser: boolean) {
  reply.setCookie("onesa_session", session, { ...options(), ...(rememberBrowser ? { maxAge: 28800 } : {}) });
  if (rememberBrowser) reply.setCookie(preference, "1", { ...options(), maxAge: 28800 });
  else reply.clearCookie(preference, options());
}
/** This cookie never authenticates a request or changes server-side expiry. */
export function remembersBrowser(request: FastifyRequest) { return request.cookies[preference] === "1"; }
export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie("onesa_session", options());
  reply.clearCookie(preference, options());
}
