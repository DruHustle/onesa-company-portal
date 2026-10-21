import { z } from "zod";
import { decrypt, encrypt } from "../auth/crypto.js";
import { inspectEngineeringLink } from "../auth/access.js";
import { HttpError } from "../services/workflows.js";

export const engineeringHandoffCookie = "__Host-onesa_docs_link_handoff";
export const engineeringHandoffOptions = {
  path: "/", httpOnly: true, secure: true, sameSite: "lax" as const,
};
const handoff = z.object({
  purpose: z.literal("engineering-link-handoff-v1"),
  origin: z.url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  interaction: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  expiresAt: z.number().int().positive(),
}).strict();
const invalid = () => new HttpError(401, "ACCESS_LINK", "This sign-in link is invalid, expired or already used. Request a new link.");

/** Preparation grants no session/role. The original link remains unconsumed. */
export async function prepareEngineeringHandoff(
  raw: string, interaction: string, origin: string, externalEmails: readonly string[],
) {
  const target = await inspectEngineeringLink(raw, interaction, externalEmails);
  const expiresAt = Math.min(target.expiresAt, Date.now() + 300_000);
  const value = handoff.parse({ purpose: "engineering-link-handoff-v1", origin, token: raw, interaction, expiresAt });
  return { cookie: encrypt(JSON.stringify(value)), maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)) };
}

/** Cookie is encrypted, origin-bound and short-lived; membership is rechecked. */
export async function readEngineeringHandoff(
  cookie: string, origin: string, externalEmails: readonly string[],
) {
  let value: z.infer<typeof handoff>;
  try {
    if (cookie.length > 2048) throw invalid();
    value = handoff.parse(JSON.parse(decrypt(cookie)));
    if (value.origin !== origin || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300_000)
      throw invalid();
  } catch { throw invalid(); }
  const target = await inspectEngineeringLink(value.token, value.interaction, externalEmails);
  return { ...value, email: target.email };
}
