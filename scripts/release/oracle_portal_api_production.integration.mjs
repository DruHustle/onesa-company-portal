// Credential-free process proof in worker_fixture_smoke.py's internal network.
// The production-looking hostname resolves only to its disposable PostgreSQL.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {stagingHost} from './oracle_portal_worker_fixture.mjs';
export async function runLocal({owner_uri,values}){
 const url=new URL(owner_uri);assert.equal(url.hostname,stagingHost);assert.equal(url.username,'neondb_owner');assert.match(url.password,/^onesa_local_test_[a-f0-9]{48}$/);assert.equal(process.getuid(),1000);
 const {default:pg}=await import('pg');const clean=new URL(url);clean.search='';
 const admin=new pg.Client({connectionString:clean.href,ssl:{rejectUnauthorized:true,servername:stagingHost},connectionTimeoutMillis:10000,statement_timeout:15000});
 await admin.connect();
 try{
  assert.equal(admin.connection.stream.authorized,true);assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const {applyMigrationPlan}=await import('/app/dist/src/services/migration-plan.js');const {provisionApplicationRole}=await import('/app/dist/src/services/database-role.js');const password=randomBytes(48).toString('hex');
  await admin.query('BEGIN');try{await applyMigrationPlan(admin);await provisionApplicationRole(admin,password);await admin.query('COMMIT');}catch(error){await admin.query('ROLLBACK');throw error;}
  const database=new URL(url);database.hostname='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';database.username='onesa_portal_app';database.password=password;
  const runtime={...values,PORT:'8300',PUBLIC_ORIGIN:'https://portal.onesa.eu',DATABASE_URL:database.href,WORKER_PROFILE:'production',WORKER_IDLE_MAX_MS:'5000',PUBLISH_ENABLED:'true'};
  const raw=Object.entries(runtime).map(([key,value])=>key+'='+value+'\n').join('');const request={binding:{repository:'DruHustle/onesa-company-portal',component:'api',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:'1'.repeat(64),production:'2'.repeat(64)},target_environment:'production'},operation_id:randomUUID(),environment:'production',ci_run_id:1,runtime_sha256:createHash('sha256').update(raw).digest('hex'),mode:'read-only'};
  // Synthetic identifiers above test the parser. No Actions run or signed owner
  // record is manufactured, and the module cannot authorize any deployment.
  async function invoke(input,success){
   const program="import fs from 'node:fs';import {live} from '/app/release/oracle_portal_api_production.mjs';const v=JSON.parse(fs.readFileSync(0,'utf8'));try{console.log(JSON.stringify(await live(v.request,v.raw)));}catch{console.log(JSON.stringify({state:'SYNTHETIC_API_OBSERVATION_REFUSED'}));process.exitCode=1;}";
   const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:'/app',env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,...runtime},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',bytes=>{out+=bytes;assert.ok(out.length<32768);});child.stderr.on('data',bytes=>{err+=bytes;assert.ok(err.length<32768);});
   const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});const timer=setTimeout(()=>child.kill('SIGTERM'),30000);child.stdin.end(JSON.stringify({request:input,raw}));const ended=await finished;clearTimeout(timer);assert.equal(ended.signal,null);assert.equal(ended.code,success?0:1);assert.equal(err,'');return JSON.parse(out);
  }
  const snapshot=async()=>(await admin.query('SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM jobs) AS jobs,(SELECT count(*)::int FROM storage_deletions) AS deletions,(SELECT count(*)::int FROM schema_migrations) AS migrations')).rows[0];const before=await snapshot();
  for(let attempt=0;attempt<2;attempt++){const observed=await invoke(request,true);assert.equal(observed.state,'API_READ_ONLY_RUNTIME_OBSERVED_NOT_AUTHORIZATION');assert.equal(observed.production_writes,0);assert.equal(observed.schema_current,true);assert.equal(observed.database_tls_and_role,true);}
  assert.equal((await invoke({...request,mode:'prepare'},false)).state,'SYNTHETIC_API_OBSERVATION_REFUSED');assert.equal((await invoke({...request,binding:{...request.binding,component:'worker'}},false)).state,'SYNTHETIC_API_OBSERVATION_REFUSED');assert.deepEqual(await snapshot(),before);
  return {actual_least_privilege_database_and_tls:true,current_real_schema:true,read_only_transaction_and_no_business_changes:true,repeated_observation_has_no_writes:true,write_mode_and_other_component_refused:true};
 }finally{await admin.end();}
}
