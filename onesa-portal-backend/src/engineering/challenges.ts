import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { db, transaction } from "../services/db.js";
import { enqueue, HttpError } from "../services/workflows.js";
import { encrypt } from "../auth/crypto.js";
import {
  engineeringEmailAllowed,
  type EngineeringIdentityConfig,
} from "./config.js";
const hmac = (
  config: EngineeringIdentityConfig,
  purpose: string,
  value: string,
) =>
  createHmac("sha256", config.cookieKeys[0])
    .update("onesa-engineering:" + purpose + ":" + value)
    .digest("hex");
export const interactionProof = (
  config: EngineeringIdentityConfig,
  uid: string,
) => hmac(config, "csrf", uid);
export function proofValid(
  config: EngineeringIdentityConfig,
  uid: string,
  proof: string,
) {
  const expected = interactionProof(config, uid);
  return (
    /^[a-f0-9]{64}$/.test(proof) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(proof))
  );
}
export const emailRateKey = (
  config: EngineeringIdentityConfig,
  email: string,
) => hmac(config, "email-rate", email);
export async function beginEngineeringChallenge(
  config: EngineeringIdentityConfig,
  uid: string,
  email: string,
) {
  const code = String(randomInt(1000000)).padStart(6, "0");
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('engineering-challenge:'||$1,0))",
      [uid],
    );
    const existing = (
      await client.query(
        "SELECT 1 FROM engineering_email_challenges WHERE interaction_uid=$1 AND created_at>now()-interval '1 minute'",
        [uid],
      )
    ).rowCount;
    if (existing)
      throw new HttpError(
        429,
        "SIGN_IN_RATE",
        "Please wait before requesting another code.",
      );
    const member = engineeringEmailAllowed(email, config.externalEmails)
      ? (
          await client.query(
            "SELECT id,email FROM engineering_memberships WHERE email=$1 AND enabled",
            [email],
          )
        ).rows[0]
      : undefined;
    await client.query(
      "INSERT INTO engineering_email_challenges(interaction_uid,membership_id,code_hash,attempts,expires_at) VALUES($1,$2,$3,0,now()+interval '10 minutes') ON CONFLICT(interaction_uid) DO UPDATE SET membership_id=EXCLUDED.membership_id,code_hash=EXCLUDED.code_hash,attempts=0,expires_at=EXCLUDED.expires_at,consumed_at=NULL,created_at=now()",
      [uid, member?.id ?? null, hmac(config, "code", uid + ":" + code)],
    );
    if (member)
      await enqueue(
        client,
        "engineering-code:" + uid + ":" + hmac(config, "delivery", code),
        {
          to: member.email,
          subject: "Your Onesa Engineering sign-in code",
          encryptedText: encrypt(
            "Your Onesa Engineering sign-in code is " +
              code +
              ". It expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.",
          ),
        },
      );
  });
}
export async function consumeEngineeringChallenge(
  config: EngineeringIdentityConfig,
  uid: string,
  code: string,
): Promise<string> {
  const member = await transaction(async (client) => {
    const row = (
      await client.query(
        "SELECT interaction_uid,membership_id,code_hash,attempts,expires_at,consumed_at FROM engineering_email_challenges WHERE interaction_uid=$1 FOR UPDATE",
        [uid],
      )
    ).rows[0];
    if (
      !row ||
      row.consumed_at ||
      Number(row.attempts) >= 5 ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      return null;
    // A rejected proof must commit the attempt increment; throwing here would roll it back.
    await client.query(
      "UPDATE engineering_email_challenges SET attempts=attempts+1 WHERE interaction_uid=$1",
      [uid],
    );
    const supplied = hmac(config, "code", uid + ":" + code);
    if (
      !/^\d{6}$/.test(code) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(row.code_hash)) ||
      !row.membership_id
    )
      return null;
    const active = (
      await client.query(
        "SELECT id,email FROM engineering_memberships WHERE id=$1 AND enabled FOR KEY SHARE",
        [row.membership_id],
      )
    ).rows[0];
    if (
      !active ||
      !engineeringEmailAllowed(active.email, config.externalEmails)
    )
      return null;
    await client.query(
      "UPDATE engineering_email_challenges SET consumed_at=now() WHERE interaction_uid=$1",
      [uid],
    );
    return String(active.id);
  });
  if (!member)
    throw new HttpError(
      401,
      "SIGN_IN_CODE",
      "The code is invalid or expired. Request a new code if needed.",
    );
  return member;
}
export async function challengeExists(uid: string) {
  return Boolean(
    (
      await db.query(
        "SELECT 1 FROM engineering_email_challenges WHERE interaction_uid=$1 AND expires_at>now() AND consumed_at IS NULL",
        [uid],
      )
    ).rowCount,
  );
}
