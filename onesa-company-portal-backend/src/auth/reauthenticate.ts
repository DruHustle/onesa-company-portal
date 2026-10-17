import type { PoolClient } from 'pg';
import type { Role } from '../access/roles.js';
import { decrypt, hash, passwordValid, validStep } from './crypto.js';
import { HttpError } from '../services/workflows.js';

type Proof = { password: string; code: string };
type Session = { userId: string; token: string; csrf: string };

/** Consume a fresh factor in the same transaction as the sensitive operation. */
export async function reauthenticate(client: PoolClient, session: Session, proof?: Proof): Promise<Role> {
  if (!proof) throw new HttpError(403, 'STEP_UP_REQUIRED', 'Confirm your password and a fresh authenticator or unused recovery code.');
  // Serialize credential/account changes without blocking audit foreign-key reads.
  // FOR UPDATE can deadlock with a deletion holding its target identity lock while
  // step-up waits for that same target and the deletion records its actor.
  const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [session.userId])).rows[0];
  const current = (await client.query('SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE', [hash(session.token), session.userId])).rows[0];
  if (!user || user.disabled || !current || current.csrf !== session.csrf) throw new HttpError(401, 'AUTH_REQUIRED', 'Session expired');
  if (!passwordValid(proof.password, user.password_hash)) throw new HttpError(403, 'STEP_UP_FAILED', 'Unable to confirm your credentials.');
  const step = user.mfa_secret ? validStep(decrypt(user.mfa_secret), proof.code, Number(user.mfa_last_step)) : null;
  if (step === null) {
    const consumed = await client.query('DELETE FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2 RETURNING user_id', [session.userId, hash(proof.code)]);
    if (!consumed.rowCount) throw new HttpError(403, 'STEP_UP_FAILED', 'Unable to confirm your credentials.');
  } else {
    await client.query('UPDATE users SET mfa_last_step=$1 WHERE id=$2', [step, session.userId]);
  }
  return user.role as Role;
}
