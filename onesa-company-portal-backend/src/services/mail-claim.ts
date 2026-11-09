import type {PoolClient} from 'pg';
import {z} from 'zod';
import {encrypt,decrypt} from '../auth/crypto.js';
import {MailReconciliationRequired,type Mailer} from './mail.js';
const custody=z.object({firstAttemptAt:z.iso.datetime(),attempt:z.unknown()}).strict();

/** Call within a transaction. Commit the encrypted exact request and its
 * credential/recipient binding before any external attempt, including retries. */
export async function claimMailJob(client:PoolClient,mailer:Mailer){
 await client.query(`UPDATE jobs SET status='failed',locked_at=NULL,
 last_error='Email retry window expired; reconcile provider acceptance before retry'
 WHERE id IN (SELECT id FROM jobs WHERE kind='email' AND status='pending' AND attempts>0
 AND (created_at<=now()-interval '23 hours' OR created_at>now())
 FOR UPDATE SKIP LOCKED)`);
 const job=(await client.query(`SELECT *,now() AS claim_now FROM jobs
 WHERE kind='email' AND status='pending' AND attempts<5
 AND (attempts=0 OR (created_at>now()-interval '23 hours' AND created_at<=now()))
 AND run_at<=now() AND payload->>'to' IS NOT NULL
 ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
 if(!job)return undefined;
 try{
  const payload={...job.payload};
  if(job.attempts===0&&!('mailPresentation' in payload))payload.mailPresentation='branded-v2';
  const input={id:job.id,to:payload.to,subject:payload.subject,text:payload.encryptedText?decrypt(payload.encryptedText):payload.text,presentation:payload.mailPresentation??'plain-v0'};
  let attempt;
  if(job.attempts===0){
   if(payload.mailAttempt)throw new MailReconciliationRequired();
   attempt=await mailer.prepare(input);
   payload.mailAttempt=encrypt(JSON.stringify({firstAttemptAt:job.claim_now.toISOString(),attempt}));
  }else{
   // A legacy attempted job cannot prove the original sender, bytes or key.
   // Never reconstruct that evidence, reset attempts or manufacture a fresh key.
   if(typeof payload.mailAttempt!=='string')throw new MailReconciliationRequired();
   const frozen=custody.parse(JSON.parse(decrypt(payload.mailAttempt)));
   const age=job.claim_now.getTime()-Date.parse(frozen.firstAttemptAt);
   if(age<0||age>=23*60*60*1000)throw new MailReconciliationRequired();
   attempt=mailer.validate(frozen.attempt,input);
   // SMTP Message-ID is not a provider deduplication guarantee. A committed
   // attempt may have reached DATA acceptance before interruption; hold it.
   if(attempt.provider==='smtp')throw new MailReconciliationRequired();
  }
  const claimed=(await client.query(`UPDATE jobs SET status='running',attempts=attempts+1,
   locked_at=now(),payload=$2 WHERE id=$1 RETURNING *`,[job.id,payload])).rows[0];
  return {...claimed,mailAttempt:attempt};
 }catch{
  await client.query(`UPDATE jobs SET status='failed',locked_at=NULL,
   last_error='Email attempt requires reconciliation of provider acceptance and request custody before retry'
   WHERE id=$1`,[job.id]);
  return undefined;
 }
}
