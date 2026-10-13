// Synthetic staging only. Never send mail, inspect documents, or change existing rows.
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
process.env.MAIL_PROVIDER='smtp';
for(const name of ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','RESEND_API_KEY','NOTIFY_EMAIL']) delete process.env[name];
const {env}=await import('./dist/src/config/env.js');
const {db}=await import('./dist/src/services/db.js');
const {store,remove,scan}=await import('./dist/src/services/storage.js');
const {tick}=await import('./dist/src/jobs/worker.js');
const {passwordHash}=await import('./dist/src/auth/crypto.js');
const duration=Number(process.env.ONESA_CAPACITY_SECONDS||900);
if(new URL(env.DATABASE_URL).hostname!=='ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech'||!Number.isInteger(duration)||duration<60||duration>3600) throw Error('Approved synthetic staging target and bounded duration required');
const actor=randomUUID(),owned=new Set(),samples=[],started=performance.now();
const benign=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(256*1024,32),Buffer.from('\n%%EOF')]);
let actorCreated=false,batches=0,phase='isolation';
try{
 const rows=(await db.query('SELECT (SELECT count(*)::int FROM applications) AS applications,(SELECT count(*)::int FROM enquiries) AS enquiries')).rows[0];
 if(rows.applications||rows.enquiries) throw Error('Synthetic staging isolation guard rejected');
 phase='actor';await db.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'administrator')",[actor,'capacity-'+actor+'@example.invalid',passwordHash(randomBytes(32).toString('hex'))]);actorCreated=true;
 while(performance.now()-started<duration*1000){
  phase='upload-and-record';const ids=Array.from({length:5},()=>randomUUID()),begin=performance.now();
  for(const id of ids){await store(id,benign);owned.add(id);await db.query("INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,title,owner_id) VALUES($1,'capacity-synthetic.pdf','application/pdf',$2,$5,$3,'internal','Disposable synthetic capacity qualification',$4)",[id,benign.length,createHash('sha256').update(benign).digest('hex'),actor,id]);}
  phase='queue';const ready=performance.now();await tick();
  const deadline=performance.now()+30000;
  while((await db.query("SELECT count(*)::int AS n FROM files WHERE id=ANY($1::uuid[]) AND scan_status<>'clean'",[ids])).rows[0].n){if(performance.now()>deadline)throw Error('Queue latency bound exceeded');await new Promise(r=>setTimeout(r,1000));await tick();}
  samples.push({objects:ids.length,upload_ms:Math.round(ready-begin),queue_ms:Math.round(performance.now()-ready),bytes:ids.length*benign.length});batches++;
  await db.query('DELETE FROM files WHERE id=ANY($1::uuid[]) AND owner_id=$2',[ids,actor]);await db.query('DELETE FROM audit WHERE record_id=ANY($1::text[])',[ids]);
  for(const id of ids){await remove(id);owned.delete(id);}
  await new Promise(r=>setTimeout(r,Math.max(0,30000-(performance.now()-begin))));
 }
 const scannerStart=performance.now();if(await scan(benign)!=='clean')throw Error('Final scanner check');
 const ordered=samples.map(x=>x.queue_ms).sort((a,b)=>a-b);
 console.log(JSON.stringify({passed:true,scope:'synthetic staging only',duration_seconds:Math.round((performance.now()-started)/1000),batches,objects_processed:batches*5,synthetic_object_bytes:samples.reduce((s,x)=>s+x.bytes,0),queue_latency_p50_ms:ordered[Math.floor(ordered.length/2)],queue_latency_p95_ms:ordered[Math.min(ordered.length-1,Math.floor(ordered.length*.95))],queue_latency_max_ms:Math.max(...ordered),final_scan_ms:Math.round(performance.now()-scannerStart),batch_limit:5,sequential_scans:true,production_release_qualified:false}));
}catch(error){console.log(JSON.stringify({passed:false,phase,error_type:error.name,database_code:/^[0-9A-Z]{5}$/.test(error.code||'')?error.code:undefined}));process.exitCode=1;}finally{
 const ids=[...owned];if(ids.length){await db.query('DELETE FROM files WHERE id=ANY($1::uuid[]) AND owner_id=$2',[ids,actor]);await db.query('DELETE FROM audit WHERE record_id=ANY($1::text[])',[ids]);for(const id of ids)await remove(id);}
 if(actorCreated)await db.query('DELETE FROM users WHERE id=$1 AND email=$2',[actor,'capacity-'+actor+'@example.invalid']);await db.end();
}
