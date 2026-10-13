// Runs on the exact qualified ARM64 image through private SSH stdin.
// Own UUIDs only; existing business records prevent this bounded qualification.
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// This transport test must never deliver email to customers.
process.env.MAIL_PROVIDER='smtp';
for(const name of ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','RESEND_API_KEY','NOTIFY_EMAIL'])delete process.env[name];
const {env}=await import('./dist/src/config/env.js');
const {db,transaction}=await import('./dist/src/services/db.js');
const {databaseReady}=await import('./dist/src/services/database-readiness.js');
const {store,retrieve,remove,scan}=await import('./dist/src/services/storage.js');
const {enqueueStorageDeletion}=await import('./dist/src/services/workflows.js');
const {tick}=await import('./dist/src/jobs/worker.js');
const {buildApp}=await import('./dist/src/app.js');
const {hash,passwordHash}=await import('./dist/src/auth/crypto.js');
const ids=[randomUUID(),randomUUID()],actor=randomUUID(),queueKey=randomUUID();
const session=randomBytes(32).toString('hex'),ownedObjects=new Set();
const benign=Buffer.from('%PDF-1.7\nOnesa synthetic production qualification\n%%EOF');
// Standard harmless EICAR signature; no malware is downloaded.
const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
// EICAR must retain its standard byte signature; wrapping it in a PDF is not EICAR.
const infected=eicar;
let app,created=false,queueCreated=false;
const report={scope:'bounded synthetic production qualification',mail_delivery_verified:false,
              real_documents_accessed:false,existing_data_overwritten:false,
              unrestricted_worker_enabled:false,production_release_qualified:false};
const require=(value)=>{if(!value)throw Error('Synthetic qualification assertion');};
try{
 report.phase='production-dependency-and-empty-data-check';
 require(new URL(env.DATABASE_URL).hostname==='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech');
 require(new URL(env.S3_ENDPOINT).hostname==='br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech');
 await databaseReady(db,true);
 const counts=(await db.query("SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM files) AS files,(SELECT count(*)::int FROM applications) AS applications,(SELECT count(*)::int FROM enquiries) AS enquiries,(SELECT count(*)::int FROM jobs) AS jobs,(SELECT count(*)::int FROM storage_deletions) AS deletions")).rows[0];
 require(Object.values(counts).every(n=>n===0));
 report.preexisting_business_rows=counts;
 report.phase='actual-scanner-benign-and-eicar';
 report.scanner_benign=(await scan(benign))==='clean';
 report.scanner_eicar=(await scan(eicar))==='rejected';
 require(report.scanner_benign&&report.scanner_eicar);
 report.phase='private-synthetic-object-roundtrip';
 for(const [i,bytes] of [benign,infected].entries()){
  await store(ids[i],bytes);ownedObjects.add(ids[i]);
  require((await retrieve(ids[i])).equals(bytes));
 }
 report.phase='synthetic-record-creation';await transaction(async c=>{
  await c.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'administrator')",[actor,'oracle-qualification-'+actor+'@example.invalid',passwordHash(randomBytes(48).toString('hex'))]);
  await c.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",[hash(session),actor,randomBytes(32).toString('hex')]);
  for(const [i,bytes] of [benign,infected].entries())await c.query("INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,title,owner_id) VALUES($1,$6,$7,$2,$5,$3,'internal','Disposable synthetic Oracle qualification',$4)",[ids[i],bytes.length,createHash('sha256').update(bytes).digest('hex'),actor,ids[i],i===0?'synthetic-qualification.pdf':'eicar.com',i===0?'application/pdf':'application/octet-stream']);
 });created=true;
 report.phase='private-download-quarantine-denial';
 app=await buildApp({logging:false});
 const get=(id,cookie=true)=>app.inject({method:'GET',url:'/api/v1/admin/files/'+id+'/chunks/0',headers:cookie?{cookie:'onesa_session='+session}:{}});
 report.initial_quarantine_denied=(await get(ids[0])).statusCode===409;
 report.anonymous_denied=(await get(ids[0],false)).statusCode===401;
 require(report.initial_quarantine_denied&&report.anonymous_denied);
 report.phase='scanner-unavailability-containment';
 const socket=env.CLAMAV_SOCKET;env.CLAMAV_SOCKET='/run/onesa-scanner/absent-qualification.sock';
 await tick();
 report.scanner_failure_keeps_quarantine=(await db.query('SELECT bool_and(scan_status=\'quarantine\') AS safe FROM files WHERE id=ANY($1::uuid[])',[ids])).rows[0].safe===true;
 require(report.scanner_failure_keeps_quarantine);
 report.phase='actual-worker-scan-and-download';
 env.CLAMAV_SOCKET=socket;await tick();
 const statuses=(await db.query('SELECT id,scan_status FROM files WHERE id=ANY($1::uuid[])',[ids])).rows;
 report.worker_clean_scan=statuses.some(x=>x.id===ids[0]&&x.scan_status==='clean');
 report.worker_infected_rejected=statuses.some(x=>x.id===ids[1]&&x.scan_status==='rejected');
 require(report.worker_clean_scan&&report.worker_infected_rejected);
 const clean=await get(ids[0]);report.clean_download_integrity=clean.statusCode===200&&clean.rawPayload.equals(benign);
 report.infected_download_denied=(await get(ids[1])).statusCode===409;
 require(report.clean_download_integrity&&report.infected_download_denied);
 report.phase='queue-deduplication-and-execution';
 await transaction(async c=>{await enqueueStorageDeletion(c,queueKey);await enqueueStorageDeletion(c,queueKey);});
 queueCreated=true;
 report.queue_deduplication=(await db.query('SELECT count(*)::int AS n FROM storage_deletions WHERE storage_key=$1',[queueKey])).rows[0].n===1;
 await tick();
 const first=(await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[queueKey])).rows[0];
 require(first.status==='accepted'&&first.attempts===1);report.queue_processed_once=true;
 await transaction(c=>enqueueStorageDeletion(c,queueKey));await tick();
 report.accepted_job_not_repeated=(await db.query('SELECT attempts FROM storage_deletions WHERE storage_key=$1',[queueKey])).rows[0].attempts===1;
 report.phase='stale-lock-and-bounded-retries';
 // A missing row owner key is verified above; only this run-owned key is retried.
 await db.query("UPDATE storage_deletions SET status='running',attempts=4,locked_at=now()-interval '6 minutes',run_at=now()-interval '1 minute' WHERE storage_key=$1",[queueKey]);
 const {S3Client}=await import('@aws-sdk/client-s3');
 const original=S3Client.prototype.send;S3Client.prototype.send=async function(){throw Error('Synthetic unavailable storage transport');};
 try{await tick();await tick();}finally{S3Client.prototype.send=original;}
 const last=(await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[queueKey])).rows[0];
 report.stale_lock_recovered_and_retry_limit_enforced=last.status==='failed'&&last.attempts===5;
 // Storage failure injection above is a runtime fault test, not a real provider outage.
 report.retry_fault_injection='runtime S3 transport rejection; actual queue/executor';
 require(report.queue_deduplication&&report.accepted_job_not_repeated&&report.stale_lock_recovered_and_retry_limit_enforced);
 const success=Number(await readFile('/tmp/onesa-worker-success','utf8'));
 report.own_worker_success_tick_recent=Number.isFinite(success)&&Date.now()-success<60000;
 require(report.own_worker_success_tick_recent);
 report.passed=true;
}catch(error){report.passed=false;report.reason='synthetic_production_runtime_check_failed';
 report.failure_category=typeof error.name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)?error.name:'runtime_error';
 if(Number.isInteger(error.$metadata?.httpStatusCode))report.provider_http=error.$metadata.httpStatusCode;
 if(typeof error.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code))report.database_error_code=error.code;
 process.exitCode=1;}
finally{
 if(app)await app.close();
 if(created){
  await db.query('DELETE FROM files WHERE id=ANY($1::uuid[]) AND owner_id=$2',[ids,actor]);
  await db.query('DELETE FROM users WHERE id=$1 AND email=$2',[actor,'oracle-qualification-'+actor+'@example.invalid']);
 }
 if(queueCreated)await db.query('DELETE FROM storage_deletions WHERE storage_key=$1',[queueKey]);
 if(created)await db.query('DELETE FROM audit WHERE record_id=ANY($1::text[])',[ids]);
 for(const key of ownedObjects)await remove(key);
 report.run_owned_records_and_objects_removed=true;
 await db.end();
 console.log(JSON.stringify(report));
}
