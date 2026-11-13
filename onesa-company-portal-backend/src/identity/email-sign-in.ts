import type { PoolClient } from "pg";
import { encrypt, decrypt, hash, token } from "../auth/crypto.js";
import { env } from "../config/env.js";
import { transaction } from "../services/db.js";
import { enqueue, HttpError } from "../services/workflows.js";

// Kept with the account's identity records so logout, credential changes and
// revocation retire pending links under the same user lock as active sessions.
const model = "AccountEmailSignIn";
const credentialBinding = (user: { email: string; password_hash: string; mfa_secret: string | null }) =>
  hash(JSON.stringify([user.email, user.password_hash, user.mfa_secret]));
const invalid = () => new HttpError(401, "CREDENTIALS", "Unable to sign in with these credentials.");

export async function requestAccountEmailLink(email: string, interactionId?: string) {
  await transaction(async client => {
    const account = (await client.query(
      "SELECT u.id,u.email,u.password_hash,u.mfa_secret FROM users u JOIN identity_profiles p ON p.user_id=u.id WHERE u.email=$1 AND NOT u.disabled AND p.email_verified_at IS NOT NULL FOR NO KEY UPDATE OF u",
      [email],
    )).rows[0];
    if (!account) return;
    const recent = await client.query(
      "SELECT 1 FROM identity_records WHERE model=$1 AND account_id=$2 AND uid IS NOT DISTINCT FROM $3 AND expires_at>now()+interval '14 minutes 30 seconds'",
      [model,account.id,interactionId ?? null],
    );
    if (recent.rowCount) return;
    await client.query("DELETE FROM identity_records WHERE model=$1 AND account_id=$2 AND (uid IS NOT DISTINCT FROM $3 OR expires_at<=now())", [model,account.id,interactionId ?? null]);
    const raw = token();
    await client.query("INSERT INTO identity_records(model,id,encrypted_payload,uid,account_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",
      [model,hash(raw),encrypt(credentialBinding(account)),interactionId ?? null,account.id]);
    const entry = interactionId ? "/admin?interaction=" + interactionId : "/admin?next=/admin";
    await enqueue(client,"identity-sign-in:"+hash(raw),{
      to:account.email,subject:"Your Onesa account sign-in link",
      encryptedText:encrypt("Confirm your Onesa sign-in:\n"+env.PUBLIC_ORIGIN+entry+"#signin-link="+raw+"\nEnter the email address that received this link. It expires in 15 minutes and can be used once. If you did not request it, ignore this message."),
    });
  });
}

export async function consumeAccountEmailLink(client: PoolClient, raw: string, user: { id: string; email: string; password_hash: string; mfa_secret: string | null }, interactionId?: string) {
  const result = await client.query(
    "DELETE FROM identity_records WHERE model=$1 AND id=$2 AND account_id=$3 AND uid IS NOT DISTINCT FROM $4 AND expires_at>now() RETURNING encrypted_payload",
    [model,hash(raw),user.id,interactionId ?? null],
  );
  if (result.rowCount !== 1 || decrypt(result.rows[0].encrypted_payload) !== credentialBinding(user)) throw invalid();
}
