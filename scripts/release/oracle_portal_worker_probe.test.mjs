import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,link,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validate,digest,configuration,heartbeat,waitFor} from './oracle_portal_worker_probe.mjs';

const now=Date.parse('2026-10-28T04:00:00Z');
const fixture='01234567-89ab-4cde-8123-456789abcdef',operation='11234567-89ab-4cde-8123-456789abcdef';
const suffix=fixture.replaceAll('-','');
function input(environment='staging'){
 const values={
  NODE_ENV:'production',PUBLISH_ENABLED:'false',SESSION_KEY:'synthetic-session-material-for-disposable-tests-only-000',PROXY_SHARED_KEY:'synthetic-proxy-material-for-disposable-tests-only',
  PUBLIC_ORIGIN:environment==='staging'?'https://portal-worker-fixture.invalid':'https://engineering.onesa.eu',
  S3_ENDPOINT:'https://synthetic.storage.invalid/',S3_BUCKET:'synthetic-test',CLAMAV_SOCKET:'/run/onesa-scanner/clamd.sock',
  DATABASE_URL:environment==='staging'?`postgresql://onesa_wq_${suffix}_app:synthetic@ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech/onesa_wq_${suffix}_test?sslmode=verify-full`:'postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',
  ...(environment==='staging'?{WORKER_PROFILE:'staging',WORKER_IDLE_MAX_MS:'600000',MAIL_PROVIDER:'smtp',SMTP_HOST:'127.0.0.1',SMTP_PORT:'2525',MAIL_FROM:'qualification@example.invalid',NODE_EXTRA_CA_CERTS:'/private/tls/cert.pem'}:{}),
 };
 const request={binding:{repository:'DruHustle/onesa-company-portal',component:'worker',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:'0'.repeat(64),production:'0'.repeat(64)},target_environment:'production'},operation_id:operation,environment,ci_run_id:123,fixture_id:fixture,expires_at:new Date(now+600000).toISOString(),runtime_sha256:null,certificate_sha256:environment==='staging'?'1'.repeat(64):null,rollback:{source:'f'.repeat(40),artifact_digest:'sha256:'+'f'.repeat(64)}};
 return {values,request};
}
function prepare(value){
 const raw=Object.entries(value.values).map(([key,item])=>key+'='+item+'\n').join('');
 value.request.runtime_sha256=digest(Buffer.from(raw));value.request.binding.configuration_sha256[value.request.environment]=value.request.runtime_sha256;
 return raw;
}

test('The production and empty staging targets have separate exact scope and bound configuration',()=>{
 for(const environment of ['staging','production']){
  const value=input(environment),raw=prepare(value),result=validate(value.request,raw,value.values,now);
  assert.equal(result.values.NODE_ENV,'production');
  assert.equal(result.marker,'onesa-worker-fixture-v1:'+operation+':'+'a'.repeat(40));
 }
});

test('Foreign scope, malformed artifacts, missing CI references and expired or noncanonical operations fail before I/O',()=>{
 for(const change of [
  v=>{v.request.binding.repository='foreign/repository';},v=>{v.request.binding.component='frontend';},
  v=>{v.request.binding.candidate_commit='main';},v=>{v.request.binding.artifact_digest=['sha256:'+'e'.repeat(64)];},
  v=>{v.request.binding.source_sha256=['c'.repeat(64)];},v=>{v.request.binding.target_environment='staging';},
  v=>{v.request.environment='development';},v=>{v.request.ci_run_id=0;},v=>{v.request.ci_run_id=true;},
  v=>{v.request.operation_id='old-context';},v=>{v.request.fixture_id=operation;},
  v=>{v.request.expires_at=new Date(now-1).toISOString();},v=>{v.request.expires_at=new Date(now+3600001).toISOString();},
  v=>{v.request.rollback.source=v.request.binding.candidate_commit;},v=>{v.request.rollback.artifact_digest=v.request.binding.artifact_digest;},
  v=>{v.request.owner_authorized=true;},
 ]){
  const value=input();change(value);const raw=prepare(value);
  assert.throws(()=>validate(value.request,raw,value.values,now));
 }
});

test('No staging caller can select an existing, pooled, privileged or nonverifying database or real mail target',()=>{
 for(const [key,changed] of [
  ['DATABASE_URL','postgresql://onesa_portal_app:synthetic@ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'],
  ['DATABASE_URL',`postgresql://neondb_owner:synthetic@ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech/onesa_wq_${suffix}_test?sslmode=verify-full`],
  ['DATABASE_URL',`postgresql://onesa_wq_${suffix}_app:synthetic@ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech/onesa_wq_${suffix}_test?sslmode=verify-full&sslmode=disable`],
  ['SMTP_HOST','smtp.example.com'],['SMTP_PORT','587'],['SMTP_USER','real-smtp-account'],['SMTP_PASSWORD','synthetic'],
  ['RESEND_API_KEY','synthetic'],['MAIL_FROM','person@example.com'],['NOTIFY_EMAIL','person@example.com'],
  ['NODE_TLS_REJECT_UNAUTHORIZED','0'],['PUBLISH_ENABLED','true'],['WORKER_PROFILE','production'],
  ['WORKER_IDLE_MAX_MS','5000'],['CLAMAV_SOCKET','/run/onesa-scanner/../other.sock'],['NODE_EXTRA_CA_CERTS','/unrelated/ca.pem'],
  ['S3_ENDPOINT','http://synthetic.storage.invalid'],['S3_ENDPOINT','https://secret@synthetic.storage.invalid'],
 ]){
  const value=input();value.values[key]=changed;const raw=prepare(value);
  assert.throws(()=>validate(value.request,raw,value.values,now),key);
 }
});

test('A changed runtime file or actual process environment cannot inherit the bound configuration',()=>{
 const value=input(),raw=prepare(value);
 assert.throws(()=>validate(value.request,raw+'UNRELATED=changed\n',value.values,now));
 assert.throws(()=>validate(value.request,raw,{...value.values,PUBLISH_ENABLED:'true'},now));
 assert.throws(()=>configuration(raw+'SMTP_PORT=2525\n'));
 assert.throws(()=>configuration(raw+'# unrelated comment\n'));
 assert.throws(()=>configuration('DATABASE_URL=synthetic\r\n'));
});

test('Malformed or quoted private URIs never survive in a validation exception',()=>{
 for(const key of ['DATABASE_URL','S3_ENDPOINT','PUBLIC_ORIGIN']){
  const value=input();value.values[key]="'postgresql://synthetic-private-secret@invalid";const raw=prepare(value);
  assert.throws(()=>validate(value.request,raw,value.values,now),error=>{
   assert.equal(JSON.stringify(Object.getOwnPropertyDescriptors(error)).includes('synthetic-private-secret'),false);
   assert.equal(String(error).includes('synthetic-private-secret'),false);
   return /^WORKER_/.test(error.message);
  });
 }
});

test('Production cannot inherit staging backoff, a fixture database or its synthetic trust configuration',()=>{
 for(const [key,value]of [['WORKER_PROFILE','staging'],['WORKER_IDLE_MAX_MS','600000'],['DATABASE_URL',input().values.DATABASE_URL],['NODE_EXTRA_CA_CERTS','/private/tls/cert.pem']]){
  const production=input('production');production.values[key]=value;const raw=prepare(production);
  assert.throws(()=>validate(production.request,raw,production.values,now));
 }
 const production=input('production');production.request.certificate_sha256='1'.repeat(64);const raw=prepare(production);
 assert.throws(()=>validate(production.request,raw,production.values,now));
});

test('Only a private, bounded, fresh JSON heartbeat with its actual next poll qualifies',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'onesa-worker-heartbeat-')),file=join(folder,'heartbeat');
 const save=value=>writeFile(file,JSON.stringify(value),{mode:0o600});
 try{
  const valid={successAt:now-1000,nextPollAt:now+9000};await save(valid);
  assert.deepEqual(await heartbeat(file,600000,now),valid);
  for(const value of [now,{successAt:now+1,nextPollAt:now+10001},{successAt:now-100000,nextPollAt:now-90000},{successAt:now,nextPollAt:now+600001},{successAt:now,nextPollAt:now+4999},{...valid,callerPass:true}]){
   await save(value);await assert.rejects(heartbeat(file,600000,now));
  }
  await save(valid);await chmod(file,0o644);await assert.rejects(heartbeat(file,600000,now));await chmod(file,0o600);
  await link(file,join(folder,'alias'));await assert.rejects(heartbeat(file,600000,now));await unlink(join(folder,'alias'));
  await symlink(file,join(folder,'symlink'));await assert.rejects(heartbeat(join(folder,'symlink'),600000,now));
  await assert.rejects(heartbeat(file,600001,now));
 }finally{await rm(folder,{recursive:true});}
});

test('Bounded observation waits fail closed on a missing result or observer error',async()=>{
 let calls=0;
 assert.equal(await waitFor(async()=>++calls===2&&'actual-result','MISSING',1000),'actual-result');
 await assert.rejects(waitFor(async()=>false,'REQUIRED_RESULT_MISSING',1),/REQUIRED_RESULT_MISSING/);
 await assert.rejects(waitFor(async()=>{throw Error('SYNTHETIC_OBSERVER_FAILURE');},'MISSING',1000),/SYNTHETIC_OBSERVER_FAILURE/);
 for(const bound of [0,-1,90001,'1000'])await assert.rejects(waitFor(async()=>true,'MISSING',bound),/WORKER_WAIT_BOUND/);
});

test('The stdin command never exports private caller values or arbitrary exceptions',async()=>{
 const command=fileURLToPath(new URL('./oracle_portal_worker_probe.mjs',import.meta.url));
 const child=spawn(process.execPath,[command],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
 const stdout=[],stderr=[];child.stdout.on('data',value=>stdout.push(value));child.stderr.on('data',value=>stderr.push(value));
 const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stdin.end(JSON.stringify({owner_uri:'postgresql://synthetic-private-secret@invalid',owner_authorized:true,workflow_run_id:0}));
 const result=await finished;
 assert.deepEqual(result,{code:1,signal:null});
 assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')),{state:'WORKER_PROBE_FAILED_INSPECT_WITHOUT_RETRY',error_category:'Error',phase:'private_input'});
 assert.equal(Buffer.concat(stderr).toString('utf8'),'');
 assert.equal(Buffer.concat(stdout).toString('utf8').includes('synthetic-private-secret'),false);
});
