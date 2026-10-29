// Runs only inside worker_fixture_smoke.py's freshly labelled internal network.
// The production-looking hostname is a private alias of its disposable DB.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,unlink} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {stagingHost} from './oracle_portal_worker_fixture.mjs';
import {runStageConditional} from './oracle_portal_worker_production.mjs';

const productionAlias='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';
const hash=value=>createHash('sha256').update(value).digest('hex');

export async function runLocal({owner_uri,values,objects,counts,stageRequest,stageRaw}){
 const url=new URL(owner_uri);
 assert.equal(url.hostname,stagingHost);assert.equal(url.username,'neondb_owner');
 assert.match(url.password,/^onesa_local_test_[a-f0-9]{48}$/);
 assert.equal(process.getuid(),1000);
 const stageConditional=await runStageConditional(stageRequest,stageRaw,values);
 assert.deepEqual(stageConditional,{conditional_object_ownership:true,synthetic_object_cleanup:true});
 assert.equal(objects.size,0);
 const {default:pg}=await import('pg');
 const clean=new URL(url);clean.search='';
 const admin=new pg.Client({connectionString:clean.href,ssl:{rejectUnauthorized:true,servername:stagingHost},enableChannelBinding:true,connectionTimeoutMillis:10000,statement_timeout:15000});
 await admin.connect();
 let worker,exited,state=null;
 try{
  assert.equal(admin.connection.stream.authorized,true);
  // neondb is the fresh fixture's empty management DB, never an application DB.
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const {applyMigrationPlan}=await import('/app/dist/src/services/migration-plan.js');
  const {provisionApplicationRole}=await import('/app/dist/src/services/database-role.js');
  const password=randomBytes(48).toString('hex');
  await admin.query('BEGIN');
  try{await applyMigrationPlan(admin);await provisionApplicationRole(admin,password);await admin.query('COMMIT');}
  catch(error){await admin.query('ROLLBACK');throw error;}
  const database=new URL(url);database.hostname=productionAlias;database.username='onesa_portal_app';database.password=password;
  const runtime={...values,PUBLIC_ORIGIN:'https://engineering.onesa.eu',DATABASE_URL:database.href,WORKER_PROFILE:'production',WORKER_IDLE_MAX_MS:'5000'};
  const raw=Object.entries(runtime).map(([key,value])=>key+'='+value+'\n').join('');
  const fixture=randomUUID(),operation=randomUUID();
  const request={binding:{repository:'DruHustle/onesa-company-portal',component:'worker',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:'1'.repeat(64),production:'2'.repeat(64)},target_environment:'production'},operation_id:operation,fixture_id:fixture,environment:'production',ci_run_id:1,runtime_sha256:hash(raw),mode:'prepare'};
  // The binding and CI number are synthetic parser inputs, not issued evidence.
  try{await unlink('/tmp/onesa-worker-success');}catch(error){if(error.code!=='ENOENT')throw error;}
  const began=Date.now();
  worker=spawn(process.execPath,['/app/dist/src/jobs/worker.js'],{cwd:'/app',env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,...runtime},stdio:'ignore'});
  exited=new Promise(resolve=>{worker.once('error',()=>{state={error:true};resolve(state);});worker.once('exit',(code,signal)=>{state={code,signal};resolve(state);});});
  const deadline=Date.now()+30000;
  while(true){
   assert.equal(state,null);
   try{const beat=JSON.parse(await readFile('/tmp/onesa-worker-success'));if(beat.successAt>=began&&beat.nextPollAt-beat.successAt===5000)break;}catch{/* first actual tick pending */}
   assert.ok(Date.now()<deadline);await sleep(250);
  }
  async function invoke(input,expectedSuccess){
   const program="import fs from 'node:fs';import {live} from '/app/release/oracle_portal_worker_production.mjs';const v=JSON.parse(fs.readFileSync(0,'utf8'));try{console.log(JSON.stringify(await live(v.request,v.raw)));}catch{console.log(JSON.stringify({state:'SYNTHETIC_PRODUCTION_ADAPTER_REFUSED'}));process.exitCode=1;}";
   const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:'/app',env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,...runtime},stdio:['pipe','pipe','pipe']});
   let out='',err='';child.stdout.on('data',bytes=>{out+=bytes;assert.ok(out.length<32768);});child.stderr.on('data',bytes=>{err+=bytes;assert.ok(err.length<32768);});
   const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
   const timer=setTimeout(()=>child.kill('SIGTERM'),60000);child.stdin.end(JSON.stringify({request:input,raw}));
   const ended=await finished;clearTimeout(timer);assert.equal(err,'');assert.equal(ended.signal,null);
   assert.equal(ended.code,expectedSuccess?0:1);
   return JSON.parse(out);
  }
  const prepared=await invoke(request,true);
  assert.equal(prepared.canary_deleted,true);assert.equal(prepared.mail_sent,false);assert.equal(prepared.global_tick_imported,false);
  assert.equal((await admin.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[fixture])).rows[0].status,'accepted');
  assert.equal(objects.has(fixture),false);
  const before={put:counts.put,delete:counts.delete};
  const inspected=await invoke({...request,mode:'inspect'},true);
  assert.equal(inspected.fixture_id,fixture);assert.deepEqual({put:counts.put,delete:counts.delete},before);
  assert.equal((await invoke(request,false)).state,'SYNTHETIC_PRODUCTION_ADAPTER_REFUSED');
  assert.deepEqual({put:counts.put,delete:counts.delete},before);
  const collision=randomUUID(),sentinel=Buffer.from('Existing synthetic object must be preserved');objects.set(collision,sentinel);
  assert.equal((await invoke({...request,fixture_id:collision},false)).state,'SYNTHETIC_PRODUCTION_ADAPTER_REFUSED');
  assert.deepEqual(objects.get(collision),sentinel);
  const held=(await admin.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[collision])).rows[0];
  assert.deepEqual(held,{status:'failed',attempts:0});
  objects.delete(collision); // This map belongs only to this disposable TLS server.
  assert.equal(state,null);
  return {staging_provider_conditional_write_contract:true,real_runtime_role_and_tls:true,current_schema:true,actual_worker_process_and_five_second_poll:true,conditional_object_ownership:true,real_outbox_completion_and_object_absence:true,inspection_does_not_write_or_enqueue:true,duplicate_preparation_refused:true,collision_preserves_existing_object:true,interrupted_reservation_not_processable:true,no_real_database_or_storage_access:true};
 }finally{
  if(worker&&state===null){worker.kill('SIGTERM');const ended=await Promise.race([exited,sleep(5000).then(()=>null)]);if(!ended){worker.kill('SIGKILL');await exited;}assert.ok(ended&&ended.code===0&&!ended.signal);}
  await admin.end();
 }
}
