// Read-only runtime observations. Only the separately commissioned verifier can
// authorize the pinned host adapter. This module issues no release authority.
import {createHash} from 'node:crypto';
const need=value=>{if(!value)throw Error('API_PRODUCTION_OBSERVATION_REFUSED');};
const keys=(value,names)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const hex40=/^[a-f0-9]{40}$/,hex64=/^[a-f0-9]{64}$/;
const hash=raw=>createHash('sha256').update(raw).digest('hex');
export function validate(request,raw,actual){
 need(keys(request,['binding','operation_id','environment','ci_run_id','runtime_sha256','mode']));
 const b=request.binding;
 need(keys(b,['repository','component','candidate_commit','source_tree','source_sha256','build_sha256','artifact_digest','configuration_sha256','target_environment']));
 need(b.repository==='DruHustle/onesa-company-portal'&&b.component==='api'&&b.target_environment==='production');
 need(matches(hex40,b.candidate_commit)&&matches(hex40,b.source_tree)&&matches(hex64,b.source_sha256)&&matches(hex64,b.build_sha256)&&matches(/^sha256:[a-f0-9]{64}$/,b.artifact_digest));
 need(keys(b.configuration_sha256,['staging','production'])&&Object.values(b.configuration_sha256).every(value=>matches(hex64,value)));
 need(matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,request.operation_id));
 need(request.environment==='production'&&request.mode==='read-only'&&Number.isSafeInteger(request.ci_run_id)&&request.ci_run_id>0);
 need(typeof raw==='string'&&Buffer.byteLength(raw)<=131072&&matches(hex64,request.runtime_sha256)&&hash(raw)===request.runtime_sha256);
 const values={};
 for(const line of raw.split('\n').filter(Boolean)){
  const i=line.indexOf('=');need(i>0&&!line.includes('\r')&&/^[A-Z][A-Z0-9_]*$/.test(line.slice(0,i)));const key=line.slice(0,i);need(!Object.hasOwn(values,key));values[key]=line.slice(i+1);
 }
 need(actual&&Object.entries(values).every(([key,value])=>actual[key]===value));
 // Preserve the existing API publication setting through its exact effective
 // configuration hash. This read-only observer never publishes or starts a
 // worker; the retained Company's prelaunch decision is observed over HTTPS.
 need(values.NODE_ENV==='production'&&values.PORT==='8300'&&['true','false'].includes(values.PUBLISH_ENABLED)&&values.WORKER_PROFILE!=='staging'&&(!values.WORKER_IDLE_MAX_MS||values.WORKER_IDLE_MAX_MS==='5000'));
 need(values.SESSION_KEY?.length>=48&&values.PROXY_SHARED_KEY?.length>=32&&values.PUBLIC_ORIGIN==='https://portal.onesa.eu');
 need(!values.NODE_TLS_REJECT_UNAUTHORIZED||values.NODE_TLS_REJECT_UNAUTHORIZED==='1');
 let database;try{database=new URL(values.DATABASE_URL);}catch{need(false);}
 need(['postgres:','postgresql:'].includes(database.protocol)&&database.hostname==='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech'&&database.pathname==='/neondb'&&database.username==='onesa_portal_app'&&database.password&&!database.hash&&(!database.port||database.port==='5432'));
 need(database.searchParams.getAll('sslmode').length===1&&database.searchParams.get('sslmode')==='verify-full'&&![...database.searchParams.keys()].some(key=>!['sslmode','channel_binding','connect_timeout','sslrootcert'].includes(key)));
 return {values};
}
export async function observe(request,raw,actual,io){
 validate(request,raw,actual);
 try{
  const identity=await io.identity();
  need(identity.database==='neondb'&&identity.role==='onesa_portal_app'&&identity.tls_verified===true&&identity.application_role_safe===true&&identity.schema_current===true&&identity.transaction_read_only===true);
  return {state:'API_READ_ONLY_RUNTIME_OBSERVED_NOT_AUTHORIZATION',binding:request.binding,operation_id:request.operation_id,ci_run_id:request.ci_run_id,database_tls_and_role:true,schema_current:true,production_writes:0,release_records_issued:0,mode:'read-only'};
 }finally{await io.close();}
}
export async function live(request,raw){
 const {values}=validate(request,raw,process.env);
 const {default:pg}=await import('/app/node_modules/pg/lib/index.js');
 const {applicationRoleSafe}=await import('/app/dist/src/services/database-role.js');
 const {databaseReady}=await import('/app/dist/src/services/database-readiness.js');
 const client=new pg.Client({connectionString:values.DATABASE_URL,connectionTimeoutMillis:10000,statement_timeout:5000});
 let connected=false;
 return observe(request,raw,process.env,{
  async identity(){
   await client.connect();connected=true;await client.query('BEGIN READ ONLY');
   const identity=(await client.query("SELECT current_database() AS database,current_user AS role,current_setting('transaction_read_only') AS read_only")).rows[0];
   await databaseReady(client,true);
   return {database:identity.database,role:identity.role,transaction_read_only:identity.read_only==='on',tls_verified:client.connection.stream.encrypted===true&&client.connection.stream.authorized===true,application_role_safe:await applicationRoleSafe(client),schema_current:true};
  },
  async close(){try{if(connected)await client.query('ROLLBACK');}finally{await client.end();}},
 });
}
