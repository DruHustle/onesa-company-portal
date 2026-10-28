// Owner-run observations only. The separately commissioned runner must verify
// its signed, atomically reserved context before launching this bounded probe.
// A caller-supplied request, including run ID 0, is never authorization.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,lstat,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {startSink} from './oracle_portal_worker_smtp.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex40=/^[a-f0-9]{40}$/,hex64=/^[a-f0-9]{64}$/;
const fail=code=>{throw Error(code);};
const need=(value,code)=>{if(!value)fail(code);};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
let observedPhase='private_input';
function privateURL(value,code){
 try{need(typeof value==='string',code);return new URL(value);}catch{fail(code);}
}
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function configuration(raw){
 need(typeof raw==='string'&&Buffer.byteLength(raw)<=131072,'WORKER_CONFIGURATION_BOUND');
 const rows=raw.split('\n').filter(Boolean),values={};
 for(const row of rows){
  const n=row.indexOf('=');need(n>0&&!row.includes('\r')&&/^[A-Z][A-Z0-9_]*$/.test(row.slice(0,n)),'WORKER_CONFIGURATION_SHAPE');
  const key=row.slice(0,n);need(!Object.hasOwn(values,key),'WORKER_CONFIGURATION_DUPLICATE');values[key]=row.slice(n+1);
 }
 return values;
}

export function validate(request,raw,actual,now=Date.now()){
 need(exact(request,['binding','operation_id','environment','ci_run_id','fixture_id','expires_at','runtime_sha256','certificate_sha256','rollback']),'WORKER_PROBE_SCHEMA');
 const b=request.binding;
 need(exact(b,['repository','component','candidate_commit','source_tree','source_sha256','build_sha256','artifact_digest','configuration_sha256','target_environment']),'WORKER_PROBE_BINDING_SCHEMA');
 need(b.repository==='DruHustle/onesa-company-portal'&&b.component==='worker'&&b.target_environment==='production','WORKER_PROBE_COMPONENT_SCOPE');
 need(matches(hex40,b.candidate_commit)&&matches(hex40,b.source_tree)&&matches(hex64,b.source_sha256)&&matches(hex64,b.build_sha256)&&matches(/^sha256:[a-f0-9]{64}$/,b.artifact_digest),'WORKER_PROBE_ARTIFACT_SCOPE');
 need(exact(b.configuration_sha256,['staging','production'])&&Object.values(b.configuration_sha256).every(value=>typeof value==='string'&&hex64.test(value)),'WORKER_PROBE_CONFIGURATION_BINDING');
 need(['staging','production'].includes(request.environment)&&matches(uuid,request.operation_id)&&matches(uuid,request.fixture_id),'WORKER_PROBE_OPERATION_SCOPE');
 need(Number.isSafeInteger(request.ci_run_id)&&request.ci_run_id>0,'GENUINE_CI_REFERENCE_REQUIRED');
 const expires=Date.parse(request.expires_at);
 need(Number.isFinite(expires)&&new Date(expires).toISOString()===request.expires_at&&expires>now+60000&&expires<=now+3600000,'WORKER_PROBE_EXPIRY');
 need(exact(request.rollback,['source','artifact_digest'])&&matches(hex40,request.rollback.source)&&request.rollback.source!==b.candidate_commit&&matches(/^sha256:[a-f0-9]{64}$/,request.rollback.artifact_digest)&&request.rollback.artifact_digest!==b.artifact_digest,'WORKER_ROLLBACK_IDENTITY');
 need(typeof request.runtime_sha256==='string'&&digest(Buffer.from(raw))===request.runtime_sha256&&request.runtime_sha256===b.configuration_sha256[request.environment],'WORKER_RUNTIME_BYTES_CHANGED');
 const values=configuration(raw);
 need(actual&&Object.entries(values).every(([key,value])=>actual[key]===value),'WORKER_RUNNING_CONFIGURATION_CHANGED');
 need(values.NODE_ENV==='production'&&values.PUBLISH_ENABLED==='false'&&values.SESSION_KEY?.length>=48&&values.PROXY_SHARED_KEY?.length>=32,'WORKER_HOSTED_CONFIGURATION');
 const origin=privateURL(values.PUBLIC_ORIGIN,'WORKER_ORIGIN_SCOPE'),storage=privateURL(values.S3_ENDPOINT,'WORKER_PRIVATE_STORAGE_SCOPE'),database=privateURL(values.DATABASE_URL,'WORKER_DATABASE_TLS_SCOPE');
 need(origin.origin===values.PUBLIC_ORIGIN&&origin.protocol==='https:'&&!origin.username&&!origin.password,'WORKER_ORIGIN_SCOPE');
 need(storage.protocol==='https:'&&!storage.username&&!storage.password&&!storage.search&&!storage.hash&&storage.pathname==='/'&&typeof values.S3_BUCKET==='string'&&/^[a-z0-9][a-z0-9.-]{0,62}$/.test(values.S3_BUCKET),'WORKER_PRIVATE_STORAGE_SCOPE');
 need(['postgres:','postgresql:'].includes(database.protocol)&&database.password&&!database.hash&&(!database.port||database.port==='5432')&&database.searchParams.getAll('sslmode').length===1&&database.searchParams.get('sslmode')==='verify-full'&&![...database.searchParams.keys()].some(key=>!['sslmode','channel_binding','connect_timeout','sslrootcert'].includes(key)),'WORKER_DATABASE_TLS_SCOPE');
 need(!values.NODE_TLS_REJECT_UNAUTHORIZED||values.NODE_TLS_REJECT_UNAUTHORIZED==='1','WORKER_TLS_MUST_VERIFY');
 need(typeof values.CLAMAV_SOCKET==='string'&&/^\/run\/onesa-scanner\/[A-Za-z0-9_-]+\.sock$/.test(values.CLAMAV_SOCKET),'WORKER_SCANNER_SOCKET_SCOPE');
 if(request.environment==='staging'){
  const suffix=request.fixture_id.replaceAll('-','');
  need(database.hostname==='ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech'&&database.pathname==='/onesa_wq_'+suffix+'_test'&&database.username==='onesa_wq_'+suffix+'_app','EMPTY_OWNED_WORKER_DATABASE_REQUIRED');
  need(values.PUBLIC_ORIGIN==='https://portal-worker-fixture.invalid'&&values.WORKER_PROFILE==='staging'&&values.WORKER_IDLE_MAX_MS==='600000','WORKER_STAGING_CONFIGURATION');
  need(values.MAIL_PROVIDER==='smtp'&&values.SMTP_HOST==='127.0.0.1'&&values.SMTP_PORT==='2525'&&values.MAIL_FROM==='qualification@example.invalid'&&!values.SMTP_USER&&!values.SMTP_PASSWORD&&!values.RESEND_API_KEY&&!values.NOTIFY_EMAIL,'WORKER_SYNTHETIC_MAIL_ONLY');
  need(matches(hex64,request.certificate_sha256)&&values.NODE_EXTRA_CA_CERTS==='/private/tls/cert.pem','WORKER_PRIVATE_FIXTURE_TLS');
 }else{
  need(database.hostname==='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech'&&database.pathname==='/neondb'&&database.username==='onesa_portal_app','WORKER_PRODUCTION_DATABASE_SCOPE');
  need((!values.WORKER_IDLE_MAX_MS||values.WORKER_IDLE_MAX_MS==='5000')&&values.WORKER_PROFILE!=='staging'&&values.NODE_EXTRA_CA_CERTS!=='/private/tls/cert.pem'&&request.certificate_sha256===null,'WORKER_PRODUCTION_CONFIGURATION');
 }
 return {values,database,marker:'onesa-worker-fixture-v1:'+request.operation_id+':'+b.candidate_commit};
}

export async function heartbeat(path,maximum,now=Date.now()){
 need(Number.isSafeInteger(maximum)&&maximum>=5000&&maximum<=600000,'WORKER_HEARTBEAT_BOUND');
 const s=await lstat(path);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&s.nlink===1&&!(s.mode&0o077)&&s.size>0&&s.size<256,'WORKER_HEARTBEAT_FILE');
 const value=JSON.parse(await readFile(path,'utf8'));
 need(exact(value,['successAt','nextPollAt'])&&Number.isSafeInteger(value.successAt)&&Number.isSafeInteger(value.nextPollAt)&&value.successAt<=now&&now-value.successAt<maximum+30000&&now<=value.nextPollAt+30000&&value.nextPollAt-value.successAt>=5000&&value.nextPollAt-value.successAt<=maximum,'WORKER_HEARTBEAT_CONTRACT');
 return value;
}

// The worker is a real, separately cancellable process. Importing tick() here
// would let the observation process bypass the running worker and its schedule.
const successFile='/tmp/onesa-worker-success';
export async function waitFor(observe,code,timeout=45000){
 need(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=90000,'WORKER_WAIT_BOUND');
 const deadline=Date.now()+timeout;
 do{const value=await observe();if(value)return value;await sleep(250);}while(Date.now()<deadline);
 fail(code);
}

async function startWorker(overrides={}){
 // This path belongs to this disposable probe container, never a host mount.
 try{await unlink(successFile);}catch(error){if(error.code!=='ENOENT')throw error;}
 const child=spawn(process.execPath,['/app/dist/src/jobs/worker.js'],{
  cwd:'/app',env:{...process.env,...overrides},stdio:'ignore',
 });
 let state=null;
 const exited=new Promise(resolve=>{
  child.once('error',()=>{state={spawn_error:true};resolve(state);});
  child.once('exit',(code,signal)=>{state={code,signal};resolve(state);});
 });
 return {child,exited,get state(){return state;},async stop(){
  need(state===null,'WORKER_EXITED_BEFORE_STOP');
  const began=Date.now();child.kill('SIGTERM');
  const result=await Promise.race([exited,sleep(3000).then(()=>null)]);
  if(!result){child.kill('SIGKILL');await exited;fail('WORKER_GRACEFUL_STOP_FAILED');}
  need(result.code===0&&!result.signal&&!result.spawn_error,'WORKER_GRACEFUL_STOP_FAILED');
  return Date.now()-began;
 }};
}

async function workerSuccess(worker,maximum=600000){
 return waitFor(async()=>{
  need(worker.state===null,'WORKER_EXITED_DURING_OBSERVATION');
  try{return await heartbeat(successFile,maximum);}catch(error){
   if(error.code==='ENOENT')return false;throw error;
  }
 },'WORKER_NO_SUCCESS_HEARTBEAT');
}

async function privateFixtureFile(path,expected){
 const stat=await lstat(path);
 need(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&stat.nlink===1&&!(stat.mode&0o077)&&stat.size>0&&stat.size<=16384,'WORKER_FIXTURE_TLS_FILE');
 const raw=await readFile(path);if(expected)need(digest(raw)===expected,'WORKER_FIXTURE_TLS_CHANGED');return raw;
}

function cookieOf(response){
 const values=response.cookies.filter(value=>value.name==='onesa_session');
 need(values.length===1&&/^[a-f0-9]{64}$/.test(values[0].value)&&values[0].secure&&values[0].httpOnly&&values[0].sameSite==='Strict','WORKER_AUTHENTICATED_COOKIE_REQUIRED');
 return 'onesa_session='+values[0].value;
}

export async function runStaging(request,raw){
 observedPhase='validate_scope';
 const checked=validate(request,raw,process.env);
 need(request.environment==='staging','EMPTY_STAGING_PROBE_ONLY');
 const cert=await privateFixtureFile('/private/tls/cert.pem',request.certificate_sha256);
 const key=await privateFixtureFile('/private/tls/key.pem');
 observedPhase='import_application';
 // Only after validation: importing application modules constructs DB/S3 clients.
 const {db,transaction}=await import('/app/dist/src/services/db.js');
 const {databaseReady}=await import('/app/dist/src/services/database-readiness.js');
 const storage=await import('/app/dist/src/services/storage.js');
 const {enqueueStorageDeletion,enqueue}=await import('/app/dist/src/services/workflows.js');
 const {passwordHash,encrypt,totp,base32}=await import('/app/dist/src/auth/crypto.js');
 const {buildApp}=await import('/app/dist/src/app.js');
 observedPhase='prepare_synthetic_identifiers';
 let app,sink,worker;const objects=new Set();
 const checks={},record=(name,value)=>{need(value,'WORKER_OBSERVATION_'+name.toUpperCase());checks[name]=true;};
 const users=[randomUUID(),randomUUID()],files=[randomUUID(),randomUUID()],deletion=randomUUID();
 const emailJob=randomUUID(),recipient=emailJob+'@example.invalid';
 const credentials=users.map(id=>({id,email:id+'@example.invalid',password:randomBytes(32).toString('hex'),secret:base32(randomBytes(20))}));
 const benign=Buffer.from('%PDF-1.7\nOnesa isolated worker qualification\n%%EOF');
 const infected=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
 try{
  observedPhase='verify_owned_database';
  const marker=(await db.query('SELECT marker FROM onesa_worker_fixture.metadata')).rows;
  need(marker.length===1&&marker[0].marker===checked.marker,'OWNED_DATABASE_MARKER_REQUIRED');
  const target=(await db.query('SELECT current_database() AS database,current_user AS role')).rows[0];
  need(target.database===checked.database.pathname.slice(1)&&target.role===checked.database.username,'OWNED_DATABASE_CONNECTION_REQUIRED');
  await databaseReady(db,true);
  const counts=(await db.query('SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM files) AS files,(SELECT count(*)::int FROM applications) AS applications,(SELECT count(*)::int FROM enquiries) AS enquiries,(SELECT count(*)::int FROM jobs) AS jobs,(SELECT count(*)::int FROM storage_deletions) AS deletions')).rows[0];
  record('empty_owned_database_and_least_privilege',Object.values(counts).every(value=>value===0));
  app=await buildApp({logging:false});
  observedPhase='password_and_mfa';
  for(const [index,person]of credentials.entries())await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[person.id,person.email,passwordHash(person.password),index===0?'administrator':'viewer',encrypt(person.secret)]);
  const login=(person,code)=>app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:checked.values.PUBLIC_ORIGIN},payload:{email:person.email,password:person.password,code}});
  record('password_without_mfa_denied',(await login(credentials[0],'')).statusCode===401);
  const sessions=[];
  for(const person of credentials){
   const code=totp(person.secret),response=await login(person,code);
   need(response.statusCode===200,'WORKER_REAL_LOGIN_FAILED');sessions.push(cookieOf(response));
   record('mfa_replay_denied_'+sessions.length,(await login(person,code)).statusCode===401);
  }
  const get=(id,cookie)=>app.inject({method:'GET',url:'/api/v1/admin/files/'+id+'/chunks/0',headers:cookie?{cookie}:{}});
  observedPhase='private_objects_and_denials';
  for(const [index,bytes]of [benign,infected].entries()){
   objects.add(files[index]);await storage.store(files[index],bytes);
   need((await storage.retrieve(files[index])).equals(bytes),'WORKER_PRIVATE_OBJECT_ROUNDTRIP');
   await db.query("INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,title,owner_id) VALUES($1,$2,$3,$4,$5,$6,'confidential','Disposable worker qualification',$7)",[files[index],index?'eicar.com':'synthetic.pdf',index?'application/octet-stream':'application/pdf',bytes.length,files[index],digest(bytes),users[0]]);
  }
  record('quarantine_download_denied',(await get(files[0],sessions[0])).statusCode===409);
  record('anonymous_download_denied',(await get(files[0])).statusCode===401);
  record('restricted_role_download_denied',(await get(files[0],sessions[1])).statusCode===403);
  record('private_public_route_denied',(await app.inject({method:'GET',url:'/api/v1/public/files/'+files[0]+'/chunks/0'})).statusCode===404);
  // Unavailability is limited to an absent UDS in this owned child process.
  worker=await startWorker({CLAMAV_SOCKET:'/run/onesa-scanner/absent-qualification.sock'});
  observedPhase='scanner_failure_containment';
  await workerSuccess(worker);await worker.stop();worker=null;
  record('scanner_failure_retains_quarantine',(await db.query("SELECT bool_and(scan_status='quarantine') AS safe FROM files WHERE id=ANY($1::uuid[])",[files])).rows[0].safe===true);
  sink=await startSink({cert,key,recipient,jobId:emailJob,port:2525});
  observedPhase='real_worker_scanner_mail_and_queues';
  const dedupe='worker-qualification:'+emailJob;
  objects.add(deletion);await storage.store(deletion,benign);
  need((await storage.retrieve(deletion)).equals(benign),'WORKER_QUEUED_OBJECT_NOT_PRESENT');
  await transaction(async c=>{
   await enqueueStorageDeletion(c,deletion);await enqueueStorageDeletion(c,deletion);
   await enqueue(c,dedupe,{to:recipient,subject:'Disposable worker qualification',text:'Synthetic transport acceptance only.'});
   await enqueue(c,dedupe,{to:recipient,subject:'Disposable worker qualification',text:'Synthetic transport acceptance only.'});
   const row=(await c.query('SELECT id FROM jobs WHERE dedupe_key=$1',[dedupe])).rows[0];
   // enqueue() owns UUID generation. Pin the fixture sink to that actual UUID.
   await c.query('UPDATE jobs SET id=$1 WHERE id=$2',[emailJob,row.id]);
  });
  worker=await startWorker();await workerSuccess(worker);
  await waitFor(async()=>{
   const rows=(await db.query('SELECT id,scan_status FROM files WHERE id=ANY($1::uuid[])',[files])).rows;
   const mail=(await db.query('SELECT status,attempts FROM jobs WHERE id=$1',[emailJob])).rows[0];
   const removed=(await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[deletion])).rows[0];
   return rows.some(row=>row.id===files[0]&&row.scan_status==='clean')&&rows.some(row=>row.id===files[1]&&row.scan_status==='rejected')&&mail?.status==='accepted'&&mail.attempts===1&&removed?.status==='accepted'&&removed.attempts===1;
  },'WORKER_REAL_WORKFLOWS_NOT_COMPLETE',90000);
  record('real_worker_clean_and_infected_scan',true);
  record('smtp_tls_acceptance_once',sink.accepted.length===1&&sink.accepted[0].job_id===emailJob&&sink.accepted[0].tls===true);
  const clean=await get(files[0],sessions[0]);
  record('clean_download_integrity',clean.statusCode===200&&clean.rawPayload.equals(benign));
  record('infected_download_denied',(await get(files[1],sessions[0])).statusCode===409);
  let deleted=false;
  try{await storage.retrieve(deletion);}catch(error){deleted=error?.name==='NoSuchKey'&&error?.$metadata?.httpStatusCode===404;}
  record('queued_private_object_actually_removed',deleted);
  await transaction(async c=>{await enqueueStorageDeletion(c,deletion);await enqueue(c,dedupe,{to:recipient,subject:'Duplicate must not deliver',text:'Synthetic.'});});
  const first=await heartbeat(successFile,600000);
  await waitFor(async()=>{const next=await heartbeat(successFile,600000);return next.successAt>first.successAt;},'WORKER_NEXT_REAL_POLL_MISSING');
  record('deduplicated_work_not_repeated',(await db.query('SELECT attempts FROM jobs WHERE id=$1',[emailJob])).rows[0].attempts===1&&(await db.query('SELECT attempts FROM storage_deletions WHERE storage_key=$1',[deletion])).rows[0].attempts===1&&sink.accepted.length===1);
  await worker.stop();worker=null;
  // A controlled child endpoint failure exercises the real bounded retry path.
  await db.query("UPDATE storage_deletions SET status='running',attempts=4,locked_at=now()-interval '6 minutes',run_at=now()-interval '1 minute' WHERE storage_key=$1",[deletion]);
  observedPhase='bounded_retry';
  worker=await startWorker({S3_ENDPOINT:'https://127.0.0.1:9',AWS_MAX_ATTEMPTS:'1'});
  await workerSuccess(worker);
  record('stale_lock_and_retry_exhaustion',(await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[deletion])).rows[0].status==='failed'&&(await db.query('SELECT attempts FROM storage_deletions WHERE storage_key=$1',[deletion])).rows[0].attempts===5);
  await worker.stop();worker=null;
  worker=await startWorker();await workerSuccess(worker);
  observedPhase='idle_shutdown_and_persistence';
  const idle=await waitFor(async()=>{const h=await heartbeat(successFile,600000);return h.nextPollAt-h.successAt>=10000&&h;},'WORKER_STAGING_IDLE_BACKOFF_MISSING');
  record('staging_idle_backoff_observed',idle.nextPollAt-idle.successAt>=10000);
  const stoppedMs=await worker.stop();worker=null;
  record('sigterm_interrupts_idle_wait',stoppedMs<3000);
  for(const cookie of sessions)need((await app.inject({method:'GET',url:'/api/v1/auth/me',headers:{cookie}})).statusCode===200,'WORKER_RESTART_LOST_AUTHENTICATED_SESSION');
  record('real_login_sessions_survive_worker_restarts',true);
  return {state:'OWNED_STAGING_WORKER_OBSERVATIONS_NOT_AUTHORIZATION',checks,fixture_id:request.fixture_id,operation_id:request.operation_id,binding:request.binding,ci_run_id:request.ci_run_id,mail_provider_acceptance_verified:true,inbox_delivery_verified:false,existing_application_databases_changed:false,global_tick_imported:false,retry_fault:'owned-child-loopback-endpoint-refusal',observed_idle_interval_ms:idle.nextPollAt-idle.successAt,graceful_stop_ms:stoppedMs};
 }finally{
  // Close only this probe's child and own UUID objects. The pinned outer runner
  // removes the entire marked disposable DB after all clients are closed.
  const cleanup=[];
  if(worker)cleanup.push(worker.stop());
  if(sink)cleanup.push(sink.close());
  if(app)cleanup.push(app.close());
  const outcomes=await Promise.allSettled(cleanup);
  let failed=outcomes.some(value=>value.status==='rejected');
  for(const id of objects)try{await storage.remove(id);}catch{failed=true;}
  try{await db.end();}catch{failed=true;}
  need(!failed,'WORKER_PROBE_CLEANUP_INCOMPLETE');
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;need(size<=65536,'WORKER_REQUEST_BOUND');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const raw=await readFile('/private/runtime.env','utf8');
  console.log(JSON.stringify(await runStaging(request,raw)));
 }catch(error){
  // Arbitrary URLs, SQL, provider errors and process environments stay private.
  const code=/^(?:WORKER_|OWNED_DATABASE_|EMPTY_STAGING_)[A-Z_]{1,100}$/.test(error?.message||'')?error.message:undefined;
  const category=['Error','TypeError','RangeError','ReferenceError','SyntaxError','HttpError','ZodError','error'].includes(error?.name)?error.name:'Error';
  const databaseCode=/^[0-9]{2}[0-9A-Z]{3}$/.test(error?.code||'')?error.code:undefined;
  console.log(JSON.stringify({state:'WORKER_PROBE_FAILED_INSPECT_WITHOUT_RETRY',error_code:code,error_category:category,database_code:databaseCode,phase:observedPhase}));process.exitCode=1;
 }
}
