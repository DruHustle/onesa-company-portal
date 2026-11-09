import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { db } from "../services/db.js";
import { HttpError } from "../services/workflows.js";
import {
  currentAccount,
  identityAccount,
  isGlobalAdmin,
  lockAccountSession,
  type AccountSession,
} from "../identity/accounts.js";
import { engineeringEmailAllowed } from "./config.js";

export const sharedEngineeringEnabled = () =>
  process.env.ONESA_IDENTITY_ENABLED === "true";

/** The account must prove its own verified identity; email alone never links it. */
export async function engineeringCentralAccount(request: FastifyRequest) {
  if (!sharedEngineeringEnabled()) return null;
  const session = await currentAccount(request);
  if (
    !session?.account.email_verified_at ||
    (isGlobalAdmin(session.account.role) && !session.amr.includes("otp"))
  )
    return null;
  return session;
}

export async function engineeringLinkChoice(
  request: FastifyRequest,
  externalEmails: readonly string[],
) {
  const session = await engineeringCentralAccount(request);
  if (
    !session ||
    !engineeringEmailAllowed(session.account.email, externalEmails)
  )
    return null;
  const row = (
    await db.query(
      "SELECT m.id FROM engineering_memberships m WHERE m.email=$1 AND m.enabled AND NOT EXISTS(SELECT 1 FROM identity_engineering_links l WHERE l.membership_id=m.id OR l.user_id=$2)",
      [session.account.email, session.account.id],
    )
  ).rows[0];
  return row ? { email: session.account.email } : null;
}

export async function linkedEngineeringSession(
  request: FastifyRequest,
  externalEmails: readonly string[],
) {
  const session = await engineeringCentralAccount(request);
  if (
    !session ||
    !engineeringEmailAllowed(session.account.email, externalEmails)
  )
    return null;
  const row = (
    await db.query(
      "SELECT m.id FROM identity_engineering_links l JOIN engineering_memberships m ON m.id=l.membership_id WHERE l.user_id=$1 AND m.email=$2 AND m.enabled",
      [session.account.id, session.account.email],
    )
  ).rows[0];
  return row ? { session, membershipId: row.id as string } : null;
}

/** Called inside the proof-consumption transaction, after the user opted in. */
export async function linkEngineeringAccount(
  connection: PoolClient,
  session: AccountSession,
  membershipId: string,
  externalEmails: readonly string[],
  requestId: string,
) {
  await lockAccountSession(connection, session);
  const account = await identityAccount(session.account.id, connection);
  const member = (
    await connection.query(
      "SELECT email,enabled FROM engineering_memberships WHERE id=$1 FOR NO KEY UPDATE",
      [membershipId],
    )
  ).rows[0];
  if (
    !account?.email_verified_at ||
    !member?.enabled ||
    account.email !== member.email ||
    !engineeringEmailAllowed(member.email, externalEmails) ||
    (isGlobalAdmin(account.role) && !session.amr.includes("otp"))
  )
    throw new HttpError(
      403,
      "ENGINEERING_ACCOUNT_PROOF",
      "Sign in to the matching verified Onesa account before linking Engineering Docs.",
    );
  const inserted = await connection.query(
    "INSERT INTO identity_engineering_links(membership_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING membership_id",
    [membershipId, account.id],
  );
  const link = (
    await connection.query(
      "SELECT user_id FROM identity_engineering_links WHERE membership_id=$1",
      [membershipId],
    )
  ).rows[0];
  if (!link || link.user_id !== account.id)
    throw new HttpError(
      409,
      "ENGINEERING_ACCOUNT_CONFLICT",
      "This Engineering identity is already linked to another Onesa account. Contact the owner.",
    );
  if (inserted.rowCount) {
    // Existing Access cookies remain an independent revocation boundary.
    await connection.query(
      "DELETE FROM engineering_identity_records WHERE account_id=$1",
      [membershipId],
    );
    await connection.query(
      "INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,'identity.engineering_linked',$2,$3)",
      [account.id, membershipId, requestId],
    );
  }
}

/** A linked identity can no longer authenticate through an independent password. */
export async function engineeringProofSession(
  request: FastifyRequest,
  connection: PoolClient,
  membershipId: string,
  externalEmails: readonly string[],
  linkRequested: boolean,
) {
  const session = await engineeringCentralAccount(request);
  if (session) await lockAccountSession(connection, session);
  if (linkRequested) {
    if (!session)
      throw new HttpError(
        401,
        "ONESA_SESSION_REQUIRED",
        "Sign in to your verified Onesa account, then confirm the Engineering link.",
      );
    await linkEngineeringAccount(
      connection,
      session,
      membershipId,
      externalEmails,
      request.id,
    );
  }
  const link = (
    await connection.query(
      "SELECT user_id FROM identity_engineering_links WHERE membership_id=$1",
      [membershipId],
    )
  ).rows[0];
  if (!link) return null;
  if (!sharedEngineeringEnabled())
    throw new HttpError(
      503,
      "IDENTITY_UNAVAILABLE",
      "Shared Onesa sign-in is unavailable for this linked Engineering identity. Contact the owner.",
    );
  if (!session || link.user_id !== session.account.id)
    throw new HttpError(
      401,
      "ONESA_SESSION_REQUIRED",
      "This Engineering identity uses Onesa sign-in. Sign in to the linked Onesa account to continue.",
    );
  const member = (
    await connection.query(
      "SELECT email,enabled FROM engineering_memberships WHERE id=$1 FOR SHARE",
      [membershipId],
    )
  ).rows[0];
  if (
    !member?.enabled ||
    member.email !== session.account.email ||
    !engineeringEmailAllowed(member.email, externalEmails)
  )
    throw new HttpError(
      403,
      "ENGINEERING_ACCOUNT_PROOF",
      "Your current Engineering approval does not match this Onesa account. Contact the owner.",
    );
  return session;
}
