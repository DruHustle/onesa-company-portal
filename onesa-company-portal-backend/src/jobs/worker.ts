import {db,transaction,audit} from '../services/db.js';
import {env,emailConfig} from '../config/env.js';
import {createMailer} from '../services/mail.js';
import {decrypt} from '../auth/crypto.js';
import {enqueue,notify,publicationEnabled} from '../services/workflows.js';
import {retrieve,scan,remove} from '../services/storage.js';
import {applicationRoleSafe} from '../services/database-role.js';
import {writeFile} from 'node:fs/promises';
import {publishScheduledContent} from '../services/editorial.js';
let stopping=false;
process.on('SIGTERM',()=>stopping=true);process.on('SIGINT',()=>stopping=true);
const sendMail=createMailer({...env,...emailConfig});
export async function tick(){
 await db.query('DELETE FROM bounded_transfers WHERE expires_at<now()');
 await db.query("UPDATE storage_deletions SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,locked_at=NULL,last_error=CASE WHEN attempts>=5 THEN 'Storage deletion retry limit exhausted' ELSE last_error END WHERE (status='running' AND locked_at<now()-interval '5 minutes') OR (status='pending' AND attempts>=5)");
 for(let i=0;i<5;i++){
  const deletion=await transaction(async c=>(await c.query("UPDATE storage_deletions SET status='running',attempts=attempts+1,locked_at=now() WHERE storage_key=(SELECT storage_key FROM storage_deletions WHERE status='pending' AND attempts<5 AND run_at<=now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0]);
  if(!deletion)break;
  try{await remove(deletion.storage_key);await db.query("UPDATE storage_deletions SET status='accepted',last_error=NULL WHERE storage_key=$1 AND status='running' AND attempts=$2",[deletion.storage_key,deletion.attempts]);}
  catch{await db.query("UPDATE storage_deletions SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,run_at=now()+power(2,attempts)*interval '1 minute',last_error='Storage deletion failed' WHERE storage_key=$1 AND status='running' AND attempts=$2",[deletion.storage_key,deletion.attempts]);}
 }

 await db.query("UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,locked_at=NULL,last_error=CASE WHEN attempts>=5 THEN 'Email retry limit exhausted; reconcile provider acceptance before retry' ELSE last_error END WHERE kind='email' AND ((status='running' AND locked_at<now()-interval '5 minutes') OR (status='pending' AND attempts>=5))");
 if(sendMail){const job=await transaction(async c=>(await c.query("UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now() WHERE id=(SELECT id FROM jobs WHERE kind='email' AND status='pending' AND attempts<5 AND run_at<=now() AND payload->>'to' IS NOT NULL ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0]);if(job){try{await sendMail({id:job.id,to:job.payload.to,subject:job.payload.subject,text:job.payload.encryptedText?decrypt(job.payload.encryptedText):job.payload.text});await db.query("UPDATE jobs SET status='accepted',last_error=NULL WHERE id=$1 AND status='running' AND attempts=$2",[job.id,job.attempts]);}catch{await db.query("UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,run_at=now()+power(2,attempts)*interval '1 minute',last_error='Email provider delivery not accepted' WHERE id=$1 AND status='running' AND attempts=$2",[job.id,job.attempts]);}}}
 const reminders=await db.query("SELECT id,follow_up_at FROM enquiries WHERE status<>'closed' AND follow_up_at<=now() AND follow_up_at>now()-interval '1 day'");for(const r of reminders.rows)await transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended('privacy:enquiry:'||$1::uuid::text,0))",[r.id]);const current=(await c.query("SELECT follow_up_at FROM enquiries WHERE id=$1 AND status<>'closed' AND follow_up_at<=now() AND follow_up_at>now()-interval '1 day' FOR KEY SHARE",[r.id])).rows[0];if(current)await enqueue(c,'reminder-due:'+r.id+':'+current.follow_up_at.toISOString(),notify('Enquiry follow-up due',`Review record ${r.id}`));});
 await db.query("UPDATE jobs SET status='accepted' WHERE kind='reminder' AND status='pending' AND NOT EXISTS(SELECT 1 FROM enquiries e WHERE e.id::text=jobs.payload->>'recordId' AND e.follow_up_at>now())");
 if(env.CLAMAV_HOST||env.CLAMAV_SOCKET){const files=await db.query("SELECT id,storage_key FROM files WHERE scan_status='quarantine' ORDER BY created_at LIMIT 5");for(const f of files.rows){try{const status=await scan(await retrieve(f.storage_key));const result=await db.query("UPDATE files SET scan_status=$1 WHERE id=$2 AND scan_status='quarantine'",[status,f.id]);if(result.rowCount)await audit(null,'document.scan_completed',f.id);}catch{console.error(JSON.stringify({event:'scan_failed',recordId:f.id}));}}}
 if(await publicationEnabled()){const scheduled=await db.query("SELECT id FROM content WHERE state='draft' AND publish_at<=now() AND metadata->'editorialReview'->>'status'='approved' ORDER BY publish_at LIMIT 10");for(const r of scheduled.rows)await transaction(c=>publishScheduledContent(c,r.id));}
 // Provisional application/enquiry TTLs are not effective privacy policies.
 // Business-data expiry stays disabled until approved rules, impact previews,
 // legal holds, deletion cascades and recovery/deletion replay are qualified.
 // Explicitly authorized storage-deletion outbox work above remains independent.
 await db.query('DELETE FROM sessions WHERE expires_at<now()');await db.query('DELETE FROM recovery_tokens WHERE expires_at<now()');await db.query('DELETE FROM rate_limits WHERE expires_at<now()');
 await db.query("INSERT INTO operational_state(key) VALUES('worker_success') ON CONFLICT(key) DO UPDATE SET updated_at=now()");
 if(env.NODE_ENV==='production')await writeFile('/tmp/onesa-worker-success',String(Date.now()),{mode:0o600});
}
if(process.argv[1]?.endsWith('worker.ts')||process.argv[1]?.endsWith('worker.js')){if(env.NODE_ENV==='production'){let safe=!!env.S3_BUCKET;try{safe=safe&&await applicationRoleSafe(db);}catch{}if(!safe){console.error(JSON.stringify({event:'worker_configuration_rejected'}));await db.end();process.exit(1);}}while(!stopping){try{await tick();}catch{console.error(JSON.stringify({event:'worker_failed'}));}await new Promise(r=>setTimeout(r,5000));}await db.end();}
