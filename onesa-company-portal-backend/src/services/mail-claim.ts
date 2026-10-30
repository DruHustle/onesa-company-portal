import type {PoolClient} from 'pg';

/** Lock the job and persist its presentation before the first external request.
 * Previously attempted jobs without a version retain their original plain body.
 * Retries, concurrent claims and restarts must never change a job's version. */
export async function claimMailJob(client:PoolClient){
 return (await client.query(`UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now(),
 payload=CASE WHEN attempts=0 AND NOT (payload ? 'mailPresentation')
 THEN jsonb_set(payload,'{mailPresentation}','"branded-v1"'::jsonb) ELSE payload END
 WHERE id=(SELECT id FROM jobs WHERE kind='email' AND status='pending' AND attempts<5
 AND run_at<=now() AND payload->>'to' IS NOT NULL ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
 RETURNING *`)).rows[0];
}
