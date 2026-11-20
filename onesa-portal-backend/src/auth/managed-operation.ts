import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { Role } from "../access/roles.js";
import { transaction } from "../services/db.js";
import { HttpError } from "../services/errors.js";
import { hash, token } from "./crypto.js";

export const operationRequest = new AsyncLocalStorage<FastifyRequest>();
export const failedProof = () =>
  new HttpError(
    403,
    "STEP_UP_FAILED",
    "Verification expired or does not match this action. Start the action again.",
  );

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(
    entries.map(([key, child]) => [key, canonical(child)]),
  );
}

export class OperationChallengeRequired extends HttpError {
  constructor(
    readonly sessionHash: string,
    readonly userId: string,
    readonly operationHash: string,
  ) {
    super(403, "PROVIDER_STEP_UP_REQUIRED", "Verify this action with Onesa.");
  }
}

type Session = { userId: string; token: string; csrf: string };
type ManagedProof = { managed: true; receipt?: string };

export async function authorizeOperation(
  client: PoolClient,
  session: Session,
  proof?: ManagedProof,
): Promise<Role> {
  const request = operationRequest.getStore();
  if (
    !request ||
    !request.body ||
    typeof request.body !== "object" ||
    !["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
  )
    throw failedProof();
  const body = { ...request.body } as Record<string, unknown>;
  delete body.stepUp;
  const digest = hash(
    JSON.stringify([request.method, request.url, canonical(body)]),
  );
  const sessionHash = hash(session.token);
  const current = (
    await client.query(
      `SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND u.id=$2 AND s.csrf=$3 AND s.expires_at>now()
      AND s.managed_expires_at>now() AND s.managed_role=u.role AND NOT u.disabled
      AND s.managed_subject IS NOT NULL AND s.managed_issuer IS NOT NULL
      FOR NO KEY UPDATE OF u, s`,
      [sessionHash, session.userId, session.csrf],
    )
  ).rows[0];
  if (!current)
    throw new HttpError(
      401,
      "AUTH_REQUIRED",
      "Sign in again before confirming this action.",
    );
  if (!proof?.receipt)
    throw new OperationChallengeRequired(sessionHash, session.userId, digest);
  const consumed = await client.query(
    `DELETE FROM portal_operation_challenges WHERE challenge_hash=$1 AND session_hash=$2
      AND operation_hash=$3 AND verified_at IS NOT NULL AND expires_at>now() RETURNING challenge_hash`,
    [hash(proof.receipt), sessionHash, digest],
  );
  if (!consumed.rowCount) throw failedProof();
  return current.role as Role;
}

// The caller's transaction has rolled back before the unfulfilled challenge is stored.
export async function issueOperationChallenge(
  error: OperationChallengeRequired,
) {
  const challenge = token();
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM portal_operation_challenges WHERE expires_at<=now()",
    );
    const session = (
      await client.query(
        `SELECT expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()
          AND managed_expires_at>now() FOR UPDATE`,
        [error.sessionHash, error.userId],
      )
    ).rows[0];
    if (!session) throw failedProof();
    const pending = await client.query(
      "SELECT count(*)::int AS n FROM portal_operation_challenges WHERE session_hash=$1",
      [error.sessionHash],
    );
    if (pending.rows[0].n >= 20)
      throw new HttpError(
        429,
        "RATE_LIMIT",
        "Wait before starting another verification.",
      );
    await client.query(
      `INSERT INTO portal_operation_challenges (challenge_hash,session_hash,operation_hash,expires_at)
       VALUES ($1,$2,$3,least($4::timestamptz,now()+interval '5 minutes'))`,
      [
        hash(challenge),
        error.sessionHash,
        error.operationHash,
        session.expires_at,
      ],
    );
  });
  return challenge;
}
