// Synthetic parser/sequence fixtures only. No hosted records or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from './oracle_portal_worker_probe.mjs';
import {observe,validate,requiredChecks} from './oracle_portal_scanner_workflows.mjs';

function input(){
 const fixture='01234567-89ab-4cde-8123-456789abcdef',operation='11234567-89ab-4cde-8123-456789abcdef';
 const suffix=fixture.replaceAll('-',''),password='synthetic_fixture_runtime_material_only_0000000000';
 const values={NODE_ENV:'production',PUBLISH_ENABLED:'false',SESSION_KEY:'synthetic-session-material-for-disposable-tests-only-000',PROXY_SHARED_KEY:'synthetic-proxy-material-for-disposable-tests-only',PUBLIC_ORIGIN:'https://portal-worker-fixture.invalid',S3_ENDPOINT:'https://synthetic.storage.invalid/',S3_BUCKET:'synthetic-test',CLAMAV_SOCKET:'/run/onesa-scanner/clamd.sock',DATABASE_URL:`postgresql://onesa_wq_${suffix}_app:${password}@ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech/onesa_wq_${suffix}_test?sslmode=verify-full`,WORKER_PROFILE:'staging',WORKER_IDLE_MAX_MS:'600000',MAIL_PROVIDER:'smtp',SMTP_HOST:'127.0.0.1',SMTP_PORT:'2525',MAIL_FROM:'qualification@example.invalid',NODE_EXTRA_CA_CERTS:'/private/tls/cert.pem'};
 const raw=Object.entries(values).map(([key,value])=>key+'='+value+'\n').join('');
 const binding={repository:'DruHustle/onesa-company-portal',component:'worker',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:digest(Buffer.from(raw)),production:'f'.repeat(64)},target_environment:'production'};
 const expires=new Date(Date.now()+1800000).toISOString();
 return {raw,values,request:{scanner_binding:{...binding,component:'scanner',build_sha256:'1'.repeat(64),artifact_digest:'sha256:'+'2'.repeat(64)},worker_probe:{binding,operation_id:operation,fixture_id:fixture,environment:'staging',ci_run_id:123,expires_at:expires,runtime_sha256:binding.configuration_sha256.staging,certificate_sha256:'3'.repeat(64),rollback:{source:'f'.repeat(40),artifact_digest:'sha256:'+'f'.repeat(64)}},fixture:{action:'provision',owner_uri:'postgresql://neondb_owner:synthetic-owner-test-only@ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',context_id:operation,fixture_id:fixture,source:binding.candidate_commit,runtime_password:password,expires_at:expires}}};
}
function result(){return {state:'OWNED_STAGING_WORKER_OBSERVATIONS_NOT_AUTHORIZATION',checks:Object.fromEntries(requiredChecks.map(key=>[key,true])),existing_application_databases_changed:false,global_tick_imported:false,inbox_delivery_verified:false};}
function operations(observed=result()){
 const calls=[];
 return {calls,fixture:async request=>{calls.push(request);return {state:request.action==='provision'?'OWNED_STAGING_FIXTURE_PROVISIONED_NOT_AUTHORIZATION':'OWNED_STAGING_FIXTURE_REMOVED',applied_migrations:3};},probe:async request=>{calls.push({action:'probe',request});return observed;},conditional:async()=>{calls.push({action:'conditional'});return {conditional_object_ownership:true,synthetic_object_cleanup:true};}};
}

test('The scanner and observed application retain separate actual artifact bindings and a genuine CI reference',async()=>{
 const value=input(),ops=operations();
 validate(value.request,value.raw,value.values);
 const observed=await observe(value.request,value.raw,value.values,ops);
 assert.equal(observed.state,'SCANNER_DEPENDENCY_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION');
 assert.deepEqual(observed.scanner_binding,value.request.scanner_binding);
 assert.deepEqual(observed.application_binding,value.request.worker_probe.binding);
 assert.equal(observed.ci_run_id,123);assert.equal(observed.worker_deployed,false);assert.equal(observed.release_records_issued,0);
 assert.deepEqual(ops.calls.map(value=>value.action),['provision','probe','cleanup']);
 assert.equal(ops.calls[2].context_id,value.request.fixture.context_id);
});

function workerInput(){
 const value=input();
 const {scanner_binding,...request}=value.request;
 value.request={...request,worker_binding:{...request.worker_probe.binding,configuration_sha256:{staging:'4'.repeat(64),production:'5'.repeat(64)}}};
 return value;
}

test('A worker observation binds the exact worker image without borrowing scanner authority',async()=>{
 const value=workerInput(),ops=operations();
 const observed=await observe(value.request,value.raw,value.values,ops);
 assert.equal(observed.state,'WORKER_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION');
 assert.deepEqual(observed.worker_binding,value.request.worker_binding);
 assert.deepEqual(observed.application_binding,value.request.worker_probe.binding);
 assert.equal(Object.hasOwn(observed,'scanner_binding'),false);
 assert.deepEqual(observed.provider_conditional_ownership,{conditional_object_ownership:true,synthetic_object_cleanup:true});
 assert.equal(observed.ci_run_id,123);
 assert.equal(observed.release_records_issued,0);
 assert.equal(observed.worker_deployed,false);
 assert.deepEqual(ops.calls.map(value=>value.action),['provision','probe','conditional','cleanup']);
});

test('Worker source, image, build and component confusion fail before any fixture operation',async()=>{
 for(const change of [
  v=>{v.request.worker_binding.component='scanner';},
  v=>{v.request.worker_binding.candidate_commit='f'.repeat(40);},
  v=>{v.request.worker_binding.source_tree='f'.repeat(40);},
  v=>{v.request.worker_binding.source_sha256='f'.repeat(64);},
  v=>{v.request.worker_binding.artifact_digest='sha256:'+'f'.repeat(64);},
  v=>{v.request.worker_binding.build_sha256='f'.repeat(64);},
  v=>{v.request.worker_binding.target_environment='staging';},
  v=>{v.request.scanner_binding={...v.request.worker_binding,component:'scanner'};},
  v=>{v.request.worker_probe.ci_run_id=0;},
  v=>{v.request.owner_approved=true;},
 ]){
  const value=workerInput(),ops=operations();change(value);
  await assert.rejects(observe(value.request,value.raw,value.values,ops));
  assert.equal(ops.calls.length,0);
 }
});

test('Worker observations require every check and exact cleanup after interruption',async()=>{
 for(const change of [v=>{delete v.checks.clean_download_integrity;},v=>{v.checks.real_worker_clean_and_infected_scan=false;},v=>{v.checks.clean_download_integrity='SKIP';}]){
  const value=workerInput(),observed=result();change(observed);const ops=operations(observed);
  await assert.rejects(observe(value.request,value.raw,value.values,ops));
  assert.equal(ops.calls.at(-1).action,'cleanup');
 }
 const value=workerInput(),ops=operations();
 ops.probe=async()=>{throw Error('SYNTHETIC_INTERRUPTION');};
 await assert.rejects(observe(value.request,value.raw,value.values,ops),/SYNTHETIC_INTERRUPTION/);
 assert.deepEqual(ops.calls.map(value=>value.action),['provision','cleanup']);
 assert.equal(ops.calls[1].context_id,value.request.fixture.context_id);
});

test('Missing or failed provider conditional-write proof cannot qualify the worker',async()=>{
 for(const proof of [undefined,{conditional_object_ownership:false,synthetic_object_cleanup:true},{conditional_object_ownership:'SKIP',synthetic_object_cleanup:true},{conditional_object_ownership:true}]){
  const value=workerInput(),ops=operations();ops.conditional=async()=>proof;
  await assert.rejects(observe(value.request,value.raw,value.values,ops));
  assert.equal(ops.calls.at(-1).action,'cleanup');
 }
});

test('Wrong source, component, environment, artifacts or fixture ownership refuse before I/O',async()=>{
 for(const change of [
  v=>{v.request.scanner_binding.component='worker';},v=>{v.request.worker_probe.binding.component='scanner';},
  v=>{v.request.scanner_binding.candidate_commit='f'.repeat(40);},v=>{v.request.scanner_binding.source_sha256='f'.repeat(64);},
  v=>{v.request.scanner_binding.target_environment='staging';},v=>{v.request.worker_probe.environment='production';},
  v=>{v.request.scanner_binding.artifact_digest=v.request.worker_probe.binding.artifact_digest;},
  v=>{v.request.fixture.source='f'.repeat(40);},v=>{v.request.fixture.context_id=v.request.fixture.fixture_id;},
  v=>{v.request.fixture.runtime_password='different_synthetic_material_0000000000000000000';},
  v=>{v.request.fixture.owner_uri='postgresql://neondb_owner:synthetic@ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full';},
  v=>{v.request.worker_probe.ci_run_id=0;},v=>{v.request.owner_approved=true;},
 ]){
  const value=input(),ops=operations();change(value);
  await assert.rejects(observe(value.request,value.raw,value.values,ops));assert.equal(ops.calls.length,0);
 }
});

test('No missing, failed, skipped or additional workflow claim can become qualified',async()=>{
 for(const change of [v=>{delete v.checks.clean_download_integrity;},v=>{v.checks.clean_download_integrity=false;},v=>{v.checks.real_worker_clean_and_infected_scan='SKIP';},v=>{v.checks.clean_download_integrity='PASS';},v=>{v.checks.caller_approved=true;},v=>{v.inbox_delivery_verified=true;}]){
  const value=input(),observed=result();change(observed);const ops=operations(observed);
  await assert.rejects(observe(value.request,value.raw,value.values,ops));
  assert.equal(ops.calls.at(-1).action,'cleanup');
 }
});

test('An interrupted probe still cleans only its exact marked fixture and never claims success',async()=>{
 const value=input(),ops=operations();ops.probe=async()=>{throw Error('SYNTHETIC_INTERRUPTION');};
 await assert.rejects(observe(value.request,value.raw,value.values,ops),/SYNTHETIC_INTERRUPTION/);
 assert.deepEqual(ops.calls.map(value=>value.action),['provision','cleanup']);
 assert.equal(ops.calls[1].source,value.request.scanner_binding.candidate_commit);
 assert.equal(ops.calls[1].fixture_id,value.request.fixture.fixture_id);
});

test('Cleanup failure prevents success even after every workflow passed',async()=>{
 const value=input(),ops=operations(),fixture=ops.fixture;
 ops.fixture=async request=>{if(request.action==='cleanup')throw Error('SYNTHETIC_ACTIVE_CLIENT_REFUSAL');return fixture(request);};
 await assert.rejects(observe(value.request,value.raw,value.values,ops),/SYNTHETIC_ACTIVE_CLIENT_REFUSAL/);
});

test('The stdin command never exports private input or an arbitrary exception',async()=>{
 const command=fileURLToPath(new URL('./oracle_portal_scanner_workflows.mjs',import.meta.url));
 const child=spawn(process.execPath,[command],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stdin.end(JSON.stringify({owner_uri:'postgresql://synthetic-private-sentinel@invalid',owner_approved:true}));
 assert.deepEqual(await ended,{code:1,signal:null});assert.equal(stderr,'');
 assert.deepEqual(JSON.parse(stdout),{state:'SCANNER_DEPENDENCY_WORKFLOWS_FAILED_NOT_QUALIFIED'});
 assert.equal(stdout.includes('synthetic-private-sentinel'),false);
});
