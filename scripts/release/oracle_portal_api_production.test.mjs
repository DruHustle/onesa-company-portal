// Synthetic I/O only. No owner record, provider request or production access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {observe,validate,live} from './oracle_portal_api_production.mjs';
function input(){
 const values={NODE_ENV:'production',PORT:'8300',PUBLIC_ORIGIN:'https://portal.onesa.eu',PUBLISH_ENABLED:'true',SESSION_KEY:'synthetic-session-material-for-disposable-tests-only-000',PROXY_SHARED_KEY:'synthetic-proxy-material-for-disposable-tests-only',DATABASE_URL:'postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'};
 const raw=Object.entries(values).map(([key,value])=>key+'='+value+'\n').join('');
 return {values,raw,request:{binding:{repository:'DruHustle/onesa-company-portal',component:'api',candidate_commit:'a'.repeat(40),source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:'1'.repeat(64),production:'2'.repeat(64)},target_environment:'production'},operation_id:randomUUID(),environment:'production',ci_run_id:123,runtime_sha256:createHash('sha256').update(raw).digest('hex'),mode:'read-only'}};
}
function fixture(){const calls=[];return {calls,async identity(){calls.push('identity');return {database:'neondb',role:'onesa_portal_app',tls_verified:true,application_role_safe:true,schema_current:true,transaction_read_only:true};},async close(){calls.push('close');}};}
test('Read-only runtime observation retains the existing publication configuration and issues no authority',async()=>{
 const value=input(),io=fixture();const result=await observe(value.request,value.raw,value.values,io);assert.deepEqual(io.calls,['identity','close']);assert.equal(result.state,'API_READ_ONLY_RUNTIME_OBSERVED_NOT_AUTHORIZATION');assert.equal(result.production_writes,0);assert.equal(result.release_records_issued,0);
});
test('Omitted publication setting retains the application false default with exact raw binding',async()=>{
 const value=input();delete value.values.PUBLISH_ENABLED;
 value.raw=Object.entries(value.values).map(([key,item])=>key+'='+item+'\n').join('');
 value.request.runtime_sha256=createHash('sha256').update(value.raw).digest('hex');
 assert.equal((await observe(value.request,value.raw,value.values,fixture())).production_writes,0);
 for(const invalid of ['', '0', 'TRUE', 'invalid']){
  const changed={...value.values,PUBLISH_ENABLED:invalid};
  const raw=Object.entries(changed).map(([key,item])=>key+'='+item+'\n').join('');
  assert.throws(()=>validate({...value.request,runtime_sha256:createHash('sha256').update(raw).digest('hex')},raw,changed));
 }
 assert.throws(()=>validate(value.request,value.raw,{...value.values,PUBLISH_ENABLED:'true'}));
});
test('Wrong component/source types, write mode, invented authority and CI zero fail before I/O',async()=>{
 for(const change of [v=>{v.request.binding.component='worker';},v=>{v.request.binding.repository='foreign/repo';},v=>{v.request.binding.candidate_commit=['a'.repeat(40)];},v=>{v.request.binding.artifact_digest='latest';},v=>{v.request.environment='staging';},v=>{v.request.binding.target_environment='staging';},v=>{v.request.ci_run_id=0;},v=>{v.request.ci_run_id=true;},v=>{v.request.mode='prepare';},v=>{v.request.owner_authorized=true;},v=>{v.raw+='NODE_TLS_REJECT_UNAUTHORIZED=0\n';},v=>{v.values.PUBLISH_ENABLED='false';}]){
  const value=input(),io=fixture();change(value);await assert.rejects(observe(value.request,value.raw,value.values,io));assert.deepEqual(io.calls,[]);
 }
});
test('Even freshly hashed runtime bytes cannot enable an owner role, wrong target or TLS bypass',()=>{
 for(const [key,replacement]of [['DATABASE_URL','postgresql://neondb_owner:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full'],['DATABASE_URL','postgresql://onesa_portal_app:synthetic@foreign.invalid/neondb?sslmode=verify-full'],['DATABASE_URL','postgresql://onesa_portal_app:synthetic@ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=disable'],['NODE_TLS_REJECT_UNAUTHORIZED','0'],['WORKER_PROFILE','staging']]){
  const value=input();value.values[key]=replacement;value.raw=Object.entries(value.values).map(([k,v])=>k+'='+v+'\n').join('');value.request.runtime_sha256=createHash('sha256').update(value.raw).digest('hex');assert.throws(()=>validate(value.request,value.raw,value.values));
 }
});
test('Failed role/TLS/schema/read-only checks close the connection and remain unqualified',async()=>{
 for(const change of [{database:'foreign'},{role:'neondb_owner'},{tls_verified:false},{schema_current:false},{application_role_safe:false},{transaction_read_only:false}]){
  const value=input(),io=fixture(),valid=await io.identity();io.calls.length=0;io.identity=async()=>{io.calls.push('identity');return {...valid,...change};};await assert.rejects(observe(value.request,value.raw,value.values,io));assert.deepEqual(io.calls,['identity','close']);
 }
});
test('Live entry rejects an unsigned caller approval before loading application modules',async()=>{
 const value=input();value.request.workflow_run_id=0;value.request.owner_approved=true;await assert.rejects(live(value.request,value.raw),/API_PRODUCTION_OBSERVATION_REFUSED/);
});
