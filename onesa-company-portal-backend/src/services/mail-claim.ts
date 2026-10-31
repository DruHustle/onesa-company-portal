import type {PoolClient} from 'pg';

/** Lock the job and persist its presentation before the first external request.
 * Previously attempted jobs without a version retain their original plain body.
 * Retries, concurrent claims and restarts must never change a job's version. */
export async function claimMailJob(client:PoolClient){
 // Resend forgets idempotency keys after 24 hours. Creation is a conservative
 // lower bound on the first attempt, including legacy jobs without attempt time.
 // An interrupted worker must not replay an ambiguous delivery after that window.
 // Keep the original identity, payload and attempt count for reconciliation.
 await client.query(`UPDATE jobs SET status='failed',locked_at=NULL,
 last_error='Email retry window expired; reconcile provider acceptance before retry'
 WHERE id IN (SELECT id FROM jobs WHERE kind='email' AND status='pending' AND attempts>0
 AND (created_at<=now()-interval '23 hours' OR created_at>now())
 FOR UPDATE SKIP LOCKED)`);
 return (await client.query(`UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now(),
 payload=CASE WHEN attempts=0 AND NOT (payload ? 'mailPresentation')
 THEN jsonb_set(payload,'{mailPresentation}','"branded-v1"'::jsonb) ELSE payload END
 WHERE id=(SELECT id FROM jobs WHERE kind='email' AND status='pending' AND attempts<5
 AND (attempts=0 OR (created_at>now()-interval '23 hours' AND created_at<=now()))
 AND run_at<=now() AND payload->>'to' IS NOT NULL ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
 RETURNING *`)).rows[0];
}
