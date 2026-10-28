// Pinned observations, not an issuer. The host adapter must verify the signed
// invocation and durable one-use request before permitting prepare mode.
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const need=value=>{if(!value)throw Error('WORKER_PRODUCTION_OBSERVATION_REFUSED');};
const keys=(value,names)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex40=/^[a-f0-9]{40}$/,hex64=/^[a-f0-9]{64}$/;
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);

export function validate(request,raw,actual){
 need(keys(request,['binding','operation_id','fixture_id','environment','ci_run_id','runtime_sha256','mode']));
 const b=request.binding;
 need(keys(b,['repository','component','candidate_commit','source_tree','source_sha256','build_sha256','artifact_digest','configuration_sha256','target_environment']));
 need(b.repository==='DruHustle/onesa-company-portal'&&b.component==='worker'&&b.target_environment==='production');
 need(matches(hex40,b.candidate_commit)&&matches(hex40,b.source_tree)&&matches(hex64,b.source_sha256)&&matches(hex64,b.build_sha256)&&matches(/^sha256:[a-f0-9]{64}$/,b.artifact_digest));
 need(keys(b.configuration_sha256,['staging','production'])&&Object.values(b.configuration_sha256).every(v=>typeof v==='string'&&hex64.test(v)));
 need(request.environment==='production'&&['prepare','inspect'].includes(request.mode)&&matches(uuid,request.operation_id)&&matches(uuid,request.fixture_id));
 need(Number.isSafeInteger(request.ci_run_id)&&request.ci_run_id>0);
 need(typeof raw==='string'&&Buffer.byteLength(raw)<=131072&&matches(hex64,request.runtime_sha256)&&hash(raw)===request.runtime_sha256);
 const values={};
 for(const line of raw.split('\n').filter(Boolean)){
  const i=line.indexOf('=');need(i>0&&!line.includes('\r')&&/^[A-Z][A-Z0-9_]*$/.test(line.slice(0,i)));
  const key=line.slice(0,i);need(!Object.hasOwn(values,key));values[key]=line.slice(i+1);
 }
 need(actual&&Object.entries(values).every(([key,value])=>actual[key]===value));
 need(values.NODE_ENV==='production'&&values.PUBLISH_ENABLED==='false'&&values.WORKER_PROFILE!=='staging'&&(!values.WORKER_IDLE_MAX_MS||values.WORKER_IDLE_MAX_MS==='5000'));
 need(values.SESSION_KEY?.length>=48&&values.PROXY_SHARED_KEY?.length>=32);
 need(!values.NODE_TLS_REJECT_UNAUTHORIZED||values.NODE_TLS_REJECT_UNAUTHORIZED==='1');
 let database,storage;
 try{database=new URL(values.DATABASE_URL);storage=new URL(values.S3_ENDPOINT);}catch{need(false);}
 need(['postgres:','postgresql:'].includes(database.protocol)&&database.hostname==='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech'&&database.pathname==='/neondb'&&database.username==='onesa_portal_app'&&database.password&&!database.hash&&(!database.port||database.port==='5432'));
 need(database.searchParams.getAll('sslmode').length===1&&database.searchParams.get('sslmode')==='verify-full'&&![...database.searchParams.keys()].some(key=>!['sslmode','channel_binding','connect_timeout','sslrootcert'].includes(key)));
 need(storage.protocol==='https:'&&!storage.username&&!storage.password&&!storage.search&&!storage.hash&&storage.pathname==='/'&&/^[a-z0-9][a-z0-9.-]{0,62}$/.test(values.S3_BUCKET));
 need(/^\/run\/onesa-scanner\/[A-Za-z0-9_-]+\.sock$/.test(values.CLAMAV_SOCKET));
 const bytes=Buffer.from('Onesa disposable worker canary v1\n'+request.operation_id+'\n'+b.candidate_commit+'\n');
 return {values,bytes,sha256:hash(bytes),key:request.fixture_id};
}

export async function observe(request,raw,actual,io){
 const checked=validate(request,raw,actual);
 try{
  const target=await io.identity();
  need(target.database==='neondb'&&target.role==='onesa_portal_app'&&target.tls_verified===true&&target.application_role_safe===true&&target.schema_current===true);
  if(request.mode==='prepare'){
   // Both the row and object must be fresh. Conditional PUT refuses collisions;
   // neither an existing object nor an existing outbox entry is overwritten.
   await io.reserveFresh(checked.key);
   await io.putFresh(checked.key,checked.bytes);
   need(hash(await io.get(checked.key))===checked.sha256);
   await io.activateReserved(checked.key);
  }
  const row=await io.completed(checked.key,request.mode==='prepare');
  need(row&&row.storage_key===checked.key&&row.status==='accepted'&&Number.isSafeInteger(row.attempts)&&row.attempts>=1&&row.attempts<=5);
  need(await io.absent(checked.key)===true);
  return {state:'WORKER_PRODUCTION_CANARY_OBSERVED_NOT_AUTHORIZATION',binding:request.binding,operation_id:request.operation_id,fixture_id:checked.key,ci_run_id:request.ci_run_id,canary_sha256:checked.sha256,canary_deleted:true,canary_outbox_status:'accepted',database_tls_and_role:true,schema_current:true,global_tick_imported:false,existing_business_rows_modified:false,mail_sent:false,release_records_issued:0,mode:request.mode};
 }finally{await io.close();}
}

export async function live(request,raw){
 validate(request,raw,process.env); // No application import before strict scope.
 const {db,transaction}=await import('/app/dist/src/services/db.js');
 const {applicationRoleSafe}=await import('/app/dist/src/services/database-role.js');
 const {databaseReady}=await import('/app/dist/src/services/database-readiness.js');
 const {default:sdk}=await import('/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
 const {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand}=sdk;
 const values=validate(request,raw,process.env).values;
 const s3=new S3Client({region:values.S3_REGION||'auto',endpoint:values.S3_ENDPOINT,forcePathStyle:true});
 const row=async key=>(await db.query('SELECT storage_key,status,attempts FROM storage_deletions WHERE storage_key=$1',[key])).rows[0]||null;
 let reservation=null;
 const io={
  async identity(){
   await databaseReady(db,true);
   const result=(await db.query('SELECT current_database() AS database,current_user AS role')).rows[0];
   const connection=await db.connect();
   try{return {...result,tls_verified:connection.connection.stream.encrypted===true&&connection.connection.stream.authorized===true,application_role_safe:await applicationRoleSafe(db),schema_current:true};}finally{connection.release();}
  },
  async reserveFresh(key){
   reservation=await transaction(async c=>{
    need((await c.query('SELECT 1 FROM files WHERE storage_key=$1 LIMIT 1',[key])).rowCount===0);
    // Failed entries are never processed by the worker. An interruption before
    // conditional object ownership therefore cannot queue somebody else's key.
    const result=await c.query("INSERT INTO storage_deletions(storage_key,status) VALUES($1,'failed') RETURNING storage_key,created_at::text AS created_at",[key]);
    need(result.rowCount===1);return result.rows[0];
   });
  },
  async putFresh(key,bytes){await s3.send(new PutObjectCommand({Bucket:values.S3_BUCKET,Key:key,Body:bytes,ServerSideEncryption:'AES256',IfNoneMatch:'*'}));},
  async get(key){const result=await s3.send(new GetObjectCommand({Bucket:values.S3_BUCKET,Key:key}));return Buffer.from(await result.Body.transformToByteArray());},
  async activateReserved(key){
   need(reservation?.storage_key===key);
   await transaction(async c=>{
    need((await c.query('SELECT 1 FROM files WHERE storage_key=$1 LIMIT 1',[key])).rowCount===0);
    const result=await c.query("UPDATE storage_deletions SET status='pending',run_at=now() WHERE storage_key=$1 AND status='failed' AND attempts=0 AND created_at=$2 RETURNING storage_key",[key,reservation.created_at]);
    need(result.rowCount===1);
   });
  },
  async completed(key,wait){
   const deadline=Date.now()+(wait?45000:0);
   do{const value=await row(key);if(!wait||value?.status==='accepted'||value?.status==='failed')return value;await sleep(250);}while(Date.now()<deadline);
   return row(key);
  },
  async absent(key){
   try{await s3.send(new HeadObjectCommand({Bucket:values.S3_BUCKET,Key:key}));return false;}
   catch(error){if(error?.$metadata?.httpStatusCode===404)return true;throw error;}
  },
  async close(){s3.destroy();await db.end();},
 };
 return observe(request,raw,process.env,io);
}

export async function runStageConditional(request,raw,actual=process.env){
 const {validate:workerPlan}=await import('./oracle_portal_worker_probe.mjs');
 const {values}=workerPlan(request,raw,actual);
 need(request.environment==='staging'&&values.AWS_ACCESS_KEY_ID&&values.AWS_SECRET_ACCESS_KEY);
 const {default:sdk}=await import('/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
 const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,HeadObjectCommand}=sdk;
 const options={region:values.S3_REGION||'auto',endpoint:values.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:values.AWS_ACCESS_KEY_ID,secretAccessKey:values.AWS_SECRET_ACCESS_KEY,sessionToken:values.AWS_SESSION_TOKEN}};
 const s3=new S3Client(options),key=randomUUID(),bytes=Buffer.from('Onesa owned staging conditional-write proof\n'+request.operation_id+'\n');
 let owned=false;
 try{
  await s3.send(new PutObjectCommand({Bucket:values.S3_BUCKET,Key:key,Body:bytes,ServerSideEncryption:'AES256',IfNoneMatch:'*'}));owned=true;
  let refused=false;
  try{await s3.send(new PutObjectCommand({Bucket:values.S3_BUCKET,Key:key,Body:Buffer.from('Must not replace the owned canary'),ServerSideEncryption:'AES256',IfNoneMatch:'*'}));}
  catch(error){if(error?.$metadata?.httpStatusCode===412)refused=true;else throw error;}
  need(refused);
  const observed=await s3.send(new GetObjectCommand({Bucket:values.S3_BUCKET,Key:key}));
  need(Buffer.from(await observed.Body.transformToByteArray()).equals(bytes));
 }finally{
  try{if(owned)await s3.send(new DeleteObjectCommand({Bucket:values.S3_BUCKET,Key:key}));}
  finally{s3.destroy();}
 }
 const verify=new S3Client(options);
 try{
  let absent=false;
  try{await verify.send(new HeadObjectCommand({Bucket:values.S3_BUCKET,Key:key}));}
  catch(error){if(error?.$metadata?.httpStatusCode===404)absent=true;else throw error;}
  need(absent);return {conditional_object_ownership:true,synthetic_object_cleanup:true};
 }finally{verify.destroy();}
}
