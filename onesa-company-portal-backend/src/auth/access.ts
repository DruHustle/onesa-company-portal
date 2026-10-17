import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db, transaction } from "../services/db.js";
import { enqueue, HttpError } from "../services/workflows.js";
import { env } from "../config/env.js";
import {
  decrypt,
  encrypt,
  hash,
  passwordHash,
  passwordValid,
  token,
  validStep,
} from "./crypto.js";
import { engineeringEmailAllowed } from "../engineering/config.js";

export type Audience = "admin" | "engineering";
export type AccessConfiguration = {
  ownerId: string;
  preapprovedEmails: string[];
  policyEvidence: string;
};
export function accessConfiguration(
  values: NodeJS.ProcessEnv = process.env,
): AccessConfiguration | null {
  if (values.ACCESS_REGISTRATION_ENABLED !== "true") return null;
  try {
    return z
      .object({
        ownerId: z.uuid(),
        preapprovedEmails: z
          .array(
            z
              .email()
              .toLowerCase()
              .refine((e) => !e.includes("*")),
          )
          .max(10),
        policyEvidence: z.string().min(10).max(2000),
      })
      .parse({
        ownerId: values.ACCESS_APPROVAL_OWNER_ID,
        preapprovedEmails: JSON.parse(values.ACCESS_PREAPPROVED_EMAILS || "[]"),
        policyEvidence: values.ACCESS_POLICY_EVIDENCE,
      });
  } catch {
    throw Error("Access registration configuration rejected");
  }
}
export const invalidLink = () =>
  new HttpError(
    401,
    "ACCESS_LINK",
    "This sign-in link is invalid or expired. Request a new link.",
  );
const dummy = passwordHash("unusable-access-password-timing-fixture");
async function owner(client: PoolClient, config: AccessConfiguration) {
  const r = (
    await client.query(
      "SELECT id,email FROM users WHERE id=$1 AND role='owner' AND NOT disabled",
      [config.ownerId],
    )
  ).rows[0];
  if (!r)
    throw new HttpError(
      503,
      "ACCESS_APPROVAL_UNAVAILABLE",
      "Registration is temporarily unavailable.",
    );
  return r;
}
async function link(
  client: PoolClient,
  purpose: Audience | "registration",
  target: {
    registration?: string;
    user?: string;
    member?: string;
    interaction?: string;
    identityHash?: string;
  },
  recipient: string,
) {
  const raw = token();
  await client.query(
    "INSERT INTO access_links(token_hash,purpose,registration_id,user_id,membership_id,interaction_uid,identity_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes')",
    [
      hash(raw),
      purpose,
      target.registration ?? null,
      target.user ?? null,
      target.member ?? null,
      target.interaction ?? null,
      target.identityHash ?? null,
    ],
  );
  const path =
    purpose === "registration"
      ? "/access/confirm"
      : purpose === "admin"
        ? "/admin"
        : "/engineering/sign-in/" + target.interaction;
  await enqueue(client, "access-link:" + hash(raw), {
    to: recipient,
    subject:
      purpose === "registration"
        ? "Complete your Onesa registration"
        : "Your Onesa sign-in link",
    encryptedText: encrypt(
      "Open this Onesa link to " +
        (purpose === "registration"
          ? "verify your email and complete registration"
          : "sign in") +
        ":\n" +
        env.PUBLIC_ORIGIN +
        path +
        "#access-link=" +
        raw +
        "\nThe link expires in 15 minutes and can be used once. Opening the email alone does not sign you in. If you did not request this, ignore it.",
    ),
  });
}
export async function requestRegistration(
  config: AccessConfiguration,
  email: string,
  audience: Audience,
  displayName: string,
) {
  await transaction(async (c) => {
    await owner(c, config);
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('access-registration:'||$1||':'||$2,0))",
      [email, audience],
    );
    // Registration must never replace an existing password or reactivate a rejected/disabled account.
    const existing =
      audience === "admin"
        ? await c.query("SELECT id FROM users WHERE email=$1", [email])
        : await c.query(
            "SELECT c.membership_id FROM engineering_credentials c JOIN engineering_memberships m ON m.id=c.membership_id WHERE m.email=$1",
            [email],
          );
    if (existing.rowCount) return;
    const old = (
      await c.query(
        "SELECT id,state FROM access_registrations WHERE email=$1 AND audience=$2",
        [email, audience],
      )
    ).rows[0];
    if (old && old.state !== "unverified") return;
    const id = old?.id ?? randomUUID();
    if (!old)
      await c.query(
        "INSERT INTO access_registrations(id,email,audience,display_name) VALUES($1,$2,$3,$4)",
        [id, email, audience, displayName],
      );
    await link(c, "registration", { registration: id }, email);
  });
}
type Registration = {
  id: string;
  email: string;
  audience: Audience;
  password_hash: string;
  state: string;
};
export async function provisionAccess(
  c: PoolClient,
  request: Registration,
  reviewer: string,
  evidence: string,
  role = "administrator",
) {
  if (request.audience === "admin") {
    // No public registration or approval route can create an owner or overwrite an existing account.
    await c.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING",
      [randomUUID(), request.email, request.password_hash, role],
    );
  } else {
    const existing = (
      await c.query(
        "SELECT id,enabled FROM engineering_memberships WHERE email=$1 FOR UPDATE",
        [request.email],
      )
    ).rows[0];
    if (existing && !existing.enabled)
      throw new HttpError(
        409,
        "ACCESS_DISABLED",
        "Review the disabled membership separately before granting access.",
      );
    const id = existing?.id ?? randomUUID();
    if (!existing)
      await c.query(
        "INSERT INTO engineering_memberships(id,email,enabled,access_policy_evidence,approved_by) VALUES($1,$2,true,$3,$4)",
        [id, request.email, evidence, reviewer],
      );
    await c.query(
      "INSERT INTO engineering_credentials(membership_id,password_hash) VALUES($1,$2) ON CONFLICT(membership_id) DO NOTHING",
      [id, request.password_hash],
    );
  }
  await c.query(
    "UPDATE access_registrations SET state='approved',reviewed_by=$2,review_note=$3,password_hash=NULL,revision=revision+1,updated_at=now() WHERE id=$1",
    [request.id, reviewer, evidence],
  );
  await c.query(
    "INSERT INTO audit(actor_id,action,record_id) VALUES($1,'access.registration_approved',$2)",
    [reviewer, request.id],
  );
}
export async function confirmRegistration(
  config: AccessConfiguration,
  raw: string,
  password: string,
  externalEmails: readonly string[],
) {
  const encoded = passwordHash(password);
  return transaction(async (c) => {
    const decisionOwner = await owner(c, config);
    const proof = (
      await c.query(
        "SELECT * FROM access_links WHERE token_hash=$1 AND purpose='registration' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",
        [hash(raw)],
      )
    ).rows[0];
    if (!proof) throw invalidLink();
    const request = (
      await c.query(
        "SELECT * FROM access_registrations WHERE id=$1 AND state='unverified' FOR UPDATE",
        [proof.registration_id],
      )
    ).rows[0];
    if (!request) throw invalidLink();
    await c.query(
      "UPDATE access_links SET consumed_at=now() WHERE registration_id=$1 AND consumed_at IS NULL",
      [request.id],
    );
    await c.query(
      "UPDATE access_registrations SET password_hash=$2,state='pending',email_verified_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",
      [request.id, encoded],
    );
    const alreadyApproved = config.preapprovedEmails.includes(request.email);
    if (
      alreadyApproved &&
      (request.audience === "admin" ||
        engineeringEmailAllowed(request.email, externalEmails))
    ) {
      await provisionAccess(
        c,
        { ...request, password_hash: encoded },
        decisionOwner.id,
        config.policyEvidence,
      );
      return {
        status: "approved" as const,
        audience: request.audience as Audience,
      };
    }
    await enqueue(c, "access-approval:" + request.id, {
      to: decisionOwner.email,
      subject: "Onesa access request awaiting your approval",
      encryptedText: encrypt(
        "A verified registration requests " +
          request.audience +
          " access. Review request " +
          request.id +
          " in Onesa Portal → Users → Access requests. No access has been granted.\n" +
          env.PUBLIC_ORIGIN +
          "/admin",
      ),
    });
    await c.query(
      "INSERT INTO audit(action,record_id) VALUES('access.registration_requested',$1)",
      [request.id],
    );
    return {
      status: "pending" as const,
      audience: request.audience as Audience,
    };
  });
}
export async function requestAdminLink(email: string) {
  await transaction(async (c) => {
    const u = (
      await c.query(
        "SELECT id,password_hash,mfa_secret FROM users WHERE email=$1 AND NOT disabled",
        [email],
      )
    ).rows[0];
    if (u)
      await link(
        c,
        "admin",
        {
          user: u.id,
          identityHash: hash(u.password_hash + ":" + String(u.mfa_secret)),
        },
        email,
      );
  });
}
export async function consumeAdminLink(raw: string, code: string) {
  // A failed factor consumes a bounded attempt without consuming a valid link or rolling the count back.
  const result = await transaction(async (c) => {
    const target = (
      await c.query(
        "SELECT user_id FROM access_links WHERE token_hash=$1 AND purpose='admin'",
        [hash(raw)],
      )
    ).rows[0];
    if (!target) return null;
    // Account → capability → session matches account-change/revocation lock order.
    const u = (
      await c.query(
        "SELECT * FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
        [target.user_id],
      )
    ).rows[0];
    const proof = (
      await c.query(
        "SELECT * FROM access_links WHERE token_hash=$1 AND purpose='admin' AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() AND attempts<5 FOR UPDATE",
        [hash(raw), target.user_id],
      )
    ).rows[0];
    if (!proof) return null;
    await c.query(
      "UPDATE access_links SET attempts=attempts+1 WHERE token_hash=$1",
      [hash(raw)],
    );
    if (
      !u ||
      proof.identity_hash !== hash(u.password_hash + ":" + String(u.mfa_secret))
    )
      return null;
    if (!u.mfa_secret) return { enrollment: true as const };
    const step = validStep(
      decrypt(u.mfa_secret),
      code,
      Number(u.mfa_last_step),
    );
    if (step === null) {
      if (
        !(
          await c.query(
            "DELETE FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2 RETURNING user_id",
            [u.id, hash(code)],
          )
        ).rowCount
      )
        return null;
    } else
      await c.query("UPDATE users SET mfa_last_step=$1 WHERE id=$2", [
        step,
        u.id,
      ]);
    await c.query(
      "UPDATE access_links SET consumed_at=now() WHERE token_hash=$1",
      [hash(raw)],
    );
    const session = token(),
      csrf = token();
    await c.query(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
      [hash(session), u.id, csrf],
    );
    await c.query(
      "INSERT INTO audit(actor_id,action,record_id) VALUES($1,'auth.email_link_login',$2)",
      [u.id, hash(raw)],
    );
    return { user: u, csrf, session };
  });
  if (!result) throw invalidLink();
  if ("enrollment" in result)
    throw new HttpError(
      403,
      "MFA_ENROLLMENT_REQUIRED",
      "Enroll your administrator authenticator with your registered password before signing in.",
    );
  return result;
}
export async function requestEngineeringLink(
  email: string,
  interaction: string,
  externalEmails: readonly string[],
) {
  await transaction(async (c) => {
    const member = engineeringEmailAllowed(email, externalEmails)
      ? (
          await c.query(
            "SELECT id,revision FROM engineering_memberships WHERE email=$1 AND enabled",
            [email],
          )
        ).rows[0]
      : null;
    if (member)
      await link(
        c,
        "engineering",
        {
          member: member.id,
          interaction,
          identityHash: String(member.revision),
        },
        email,
      );
  });
}
export async function consumeEngineeringLink(
  raw: string,
  interaction: string,
  externalEmails: readonly string[],
) {
  return transaction(async (c) => {
    const target = (
      await c.query(
        "SELECT membership_id FROM access_links WHERE token_hash=$1 AND purpose='engineering'",
        [hash(raw)],
      )
    ).rows[0];
    if (!target) throw invalidLink();
    // Membership first: offboarding locks the same row before removing its links.
    await c.query(
      "SELECT id FROM engineering_memberships WHERE id=$1 FOR KEY SHARE",
      [target.membership_id],
    );
    const r = (
      await c.query(
        "SELECT l.token_hash,m.id,m.email FROM access_links l JOIN engineering_memberships m ON m.id=l.membership_id WHERE l.token_hash=$1 AND l.purpose='engineering' AND l.interaction_uid=$2 AND l.consumed_at IS NULL AND l.expires_at>now() AND m.enabled AND l.identity_hash=m.revision::text FOR UPDATE OF l",
        [hash(raw), interaction],
      )
    ).rows[0];
    if (!r || !engineeringEmailAllowed(r.email, externalEmails))
      throw invalidLink();
    await c.query(
      "UPDATE access_links SET consumed_at=now() WHERE token_hash=$1",
      [r.token_hash],
    );
    return String(r.id);
  });
}
export async function engineeringPasswordAccount(
  email: string,
  password: string,
  externalEmails: readonly string[],
) {
  const r = engineeringEmailAllowed(email, externalEmails)
    ? (
        await db.query(
          "SELECT m.id,c.password_hash FROM engineering_memberships m JOIN engineering_credentials c ON c.membership_id=m.id WHERE m.email=$1 AND m.enabled",
          [email],
        )
      ).rows[0]
    : undefined;
  const matches = passwordValid(password, r?.password_hash ?? dummy);
  if (!r || !matches)
    throw new HttpError(
      401,
      "CREDENTIALS",
      "Unable to sign in with these credentials.",
    );
  return String(r.id);
}
