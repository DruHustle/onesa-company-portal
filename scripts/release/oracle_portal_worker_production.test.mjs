// Synthetic I/O only. These observations grant no release authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observe,validate} from './oracle_portal_worker_production.mjs';

function input(mode='prepare'){
 const values={NODE_ENV:'production',PUBLISH_ENABLED:'false',SESSION_KEY:'synthetic-session-material-for-disposable-tests-only-000',PROXY_SHARED_KEY:'synthetic-proxy-material-for-disposable-tests-only',DATABASE_URL:'postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',S3_ENDPOINT:'https://synthetic.storage.invalid/',S3_BUCKET:'synthetic-test',CLAMAV_SOCKET:'/run/onesa-scanner/clamd.sock'};
 const raw=Object.entries(values).map(([key,value])=>key+'='+value+'\n').join('');
 const request={binding:{repository:'DruHustle/onesa-company-portal',component:'worker',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:'1'.repeat(64),production:'2'.repeat(64)},target_environment:'production'},operation_id:'01234567-89ab-4cde-8123-456789abcdef',fixture_id:'11234567-89ab-4cde-8123-456789abcdef',environment:'production',ci_run_id:123,runtime_sha256:createHash('sha256').update(raw).digest('hex'),mode};
 return {request,raw,values};
}
function fixture(value){
 const checked=validate(value.request,value.raw,value.values),calls=[];
 return {calls,
  async identity(){calls.push('identity');return {database:'neondb',role:'onesa_portal_app',tls_verified:true,application_role_safe:true,schema_current:true};},
  async reserveFresh(){calls.push('reserve');},
  async putFresh(key,bytes){calls.push('put');assert.equal(key,checked.key);assert.deepEqual(bytes,checked.bytes);},
  async get(key){calls.push('get');assert.equal(key,checked.key);return checked.bytes;},
  async activateReserved(key){calls.push('enqueue');assert.equal(key,checked.key);},
  async completed(key,wait){calls.push(wait?'wait':'read');return {storage_key:key,status:'accepted',attempts:1};},
  async absent(key){calls.push('absent');assert.equal(key,checked.key);return true;},
  async close(){calls.push('close');},
 };
}

test('One disposable object and outbox entry require real completion and absence',async()=>{
 const value=input(),io=fixture(value),result=await observe(value.request,value.raw,value.values,io);
 assert.deepEqual(io.calls,['identity','reserve','put','get','enqueue','wait','absent','close']);
 assert.equal(result.state,'WORKER_PRODUCTION_CANARY_OBSERVED_NOT_AUTHORIZATION');
 assert.equal(result.operation_id,value.request.operation_id);
 assert.deepEqual(result.binding,value.request.binding);
 assert.equal(result.canary_deleted,true);
 assert.equal(result.mail_sent,false);
 assert.equal(result.global_tick_imported,false);
 assert.equal(result.release_records_issued,0);
});

test('Inspection never creates an object, enqueues work or repeats a deployment',async()=>{
 const value=input('inspect'),io=fixture(value);
 const result=await observe(value.request,value.raw,value.values,io);
 assert.deepEqual(io.calls,['identity','read','absent','close']);
 assert.equal(result.mode,'inspect');
});

test('Wrong source types, component, target, runtime and fabricated CI refuse before I/O',async()=>{
 for(const change of [
  v=>{v.request.binding.repository='foreign/repository';},v=>{v.request.binding.component='scanner';},
  v=>{v.request.binding.candidate_commit=['a'.repeat(40)];},v=>{v.request.binding.source_tree='main';},
  v=>{v.request.binding.artifact_digest=['sha256:'+'e'.repeat(64)];},v=>{v.request.binding.target_environment='staging';},
  v=>{v.request.environment='staging';},v=>{v.request.operation_id=['01234567-89ab-4cde-8123-456789abcdef'];},
  v=>{v.request.ci_run_id=0;},v=>{v.request.ci_run_id=true;},v=>{v.request.mode='deploy';},
  v=>{v.request.owner_approved=true;},v=>{v.raw+='PUBLISH_ENABLED=true\n';},
  v=>{v.values.PUBLISH_ENABLED='true';},v=>{v.request.runtime_sha256='f'.repeat(64);},
 ]){
  const value=input(),io=fixture(value);change(value);
  await assert.rejects(observe(value.request,value.raw,value.values,io));
  assert.deepEqual(io.calls,[]);
 }
});

test('A bound but unsafe production configuration remains refused',()=>{
 for(const [key,item]of [
  ['DATABASE_URL','postgresql://neondb_owner:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'],
  ['DATABASE_URL','postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=disable'],
  ['WORKER_PROFILE','staging'],['WORKER_IDLE_MAX_MS','600000'],['NODE_TLS_REJECT_UNAUTHORIZED','0'],
  ['PUBLISH_ENABLED','true'],['S3_ENDPOINT','http://synthetic.storage.invalid'],['CLAMAV_SOCKET','/run/other/clamd.sock'],
 ]){
  const value=input();value.values[key]=item;
  value.raw=Object.entries(value.values).map(([key,value])=>key+'='+value+'\n').join('');
  value.request.runtime_sha256=createHash('sha256').update(value.raw).digest('hex');
  assert.throws(()=>validate(value.request,value.raw,value.values));
 }
});

test('Existing rows, object collisions and failed integrity never enqueue deletion',async()=>{
 for(const change of [
  io=>{io.reserveFresh=async()=>{throw Error('SYNTHETIC_EXISTING_FILE_OR_ROW');};},
  io=>{io.putFresh=async()=>{throw Error('SYNTHETIC_CONDITIONAL_PUT_COLLISION');};},
  io=>{io.get=async()=>Buffer.from('wrong disposable content');},
 ]){
  const value=input(),io=fixture(value);change(io);
  await assert.rejects(observe(value.request,value.raw,value.values,io));
  assert.equal(io.calls.includes('enqueue'),false);assert.equal(io.calls.at(-1),'close');
 }
});

test('Failed, skipped, foreign or incomplete observations never become successful',async()=>{
 for(const change of [
  io=>{io.identity=async()=>({database:'neondb',role:'neondb_owner',tls_verified:true,application_role_safe:false,schema_current:true});},
  io=>{io.completed=async()=>null;},
  io=>{io.completed=async key=>({storage_key:key,status:'failed',attempts:5});},
  io=>{io.completed=async key=>({storage_key:key,status:'SKIP',attempts:1});},
  io=>{io.completed=async key=>({storage_key:'2'+key.slice(1),status:'accepted',attempts:1});},
  io=>{io.completed=async key=>({storage_key:key,status:'accepted',attempts:0});},
  io=>{io.absent=async()=>false;},
 ]){
  const value=input(),io=fixture(value);change(io);
  await assert.rejects(observe(value.request,value.raw,value.values,io));
  assert.equal(io.calls.at(-1),'close');
 }
});

test('Interruption preserves inspect-only recovery and never retries preparation',async()=>{
 const value=input(),io=fixture(value);
 io.activateReserved=async()=>{io.calls.push('enqueue');throw Error('SYNTHETIC_INTERRUPTION');};
 await assert.rejects(observe(value.request,value.raw,value.values,io),/SYNTHETIC_INTERRUPTION/);
 assert.equal(io.calls.filter(v=>v==='put').length,1);
 assert.equal(io.calls.filter(v=>v==='enqueue').length,1);
 assert.equal(io.calls.at(-1),'close');
 const inspection=input('inspect'),reader=fixture(inspection);reader.completed=async()=>null;
 await assert.rejects(observe(inspection.request,inspection.raw,inspection.values,reader));
 assert.deepEqual(reader.calls,['identity','close']);
});
