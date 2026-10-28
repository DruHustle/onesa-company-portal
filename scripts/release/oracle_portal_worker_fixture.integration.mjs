// Disposable local PostgreSQL/TLS proof, never hosted qualification or authority.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {validate,stagingHost} from './oracle_portal_worker_fixture.mjs';
const require=createRequire('/app/package.json');
const {Client}=require('pg');

async function main(){
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
 const input=JSON.parse(Buffer.concat(chunks));
 const uri=new URL(input.owner_uri);
 assert.equal(input.scope,'LOCAL_DISPOSABLE_POSTGRES17_TLS_ONLY');
 assert.equal(uri.hostname,stagingHost);assert.equal(uri.username,'neondb_owner');
 assert.match(uri.password,/^onesa_local_test_[a-f0-9]{48}$/);
 const connect=async(url)=>{const u=new URL(url);u.search='';const c=new Client({connectionString:u.href,ssl:{rejectUnauthorized:true,servername:stagingHost},enableChannelBinding:true,connectionTimeoutMillis:10000});await c.connect();assert.equal(c.connection.stream.authorized,true);return c;};
 const owner=await connect(uri.href),checks=[];
 const request={action:'inspect',owner_uri:uri.href,context_id:randomUUID(),fixture_id:randomUUID(),source:'a'.repeat(40),runtime_password:'onesa_local_test_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),expires_at:new Date(Date.now()+1800000).toISOString()};
 const plan=validate(request);
 const catalog=async()=>({databases:(await owner.query('SELECT datname,datdba FROM pg_database ORDER BY datname')).rows,roles:(await owner.query('SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles ORDER BY rolname')).rows});
 const before=await catalog();
 const invoke=(value,success=true)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./oracle_portal_worker_fixture.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});let out='',err='';
  child.stdout.on('data',v=>{out+=v;});child.stderr.on('data',v=>{err+=v;});child.on('error',reject);
  child.on('exit',code=>{try{assert.equal(code,success?0:1);assert.equal(err,'');resolve(JSON.parse(out));}catch(error){reject(error);}});child.stdin.end(JSON.stringify(value));
 });
 let runtime;
 try{
  const inspected=await invoke(request);assert.equal(inspected.database_present,false);assert.equal(inspected.roles_present,false);assert.deepEqual(await catalog(),before);checks.push('inspection_creates_no_resources');
  const results=await Promise.all([invoke({...request,action:'provision'}),invoke({...request,action:'provision'})]);
  assert.equal(results[0].database_oid,results[1].database_oid);assert.equal(results[0].owner_oid,results[1].owner_oid);
  assert.equal(results.filter(r=>r.applied_migrations===0).length,1);assert.ok(results.some(r=>r.applied_migrations>0));checks.push('simultaneous_provisioning_has_one_database_and_migration');
  const app=new URL(uri);app.username=plan.runtime;app.password=request.runtime_password;app.pathname='/'+plan.database;
  runtime=await connect(app.href);
  const role=(await runtime.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS migration_write FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role,{elevated:false,schema_create:false,migration_write:false});
  assert.ok(Number((await runtime.query('SELECT count(*) FROM schema_migrations')).rows[0].count)>0);
  assert.equal((await runtime.query('SELECT marker FROM onesa_worker_fixture.metadata')).rows[0].marker,plan.marker);
  for(const sql of ['CREATE TABLE public.not_allowed(id int)',"INSERT INTO schema_migrations(name,checksum) VALUES('not-allowed','bad')","DELETE FROM onesa_worker_fixture.metadata"]){await assert.rejects(runtime.query(sql),e=>e.code==='42501');}
  checks.push('real_tls_runtime_login_and_least_privilege');
  const pid=(await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await invoke({...request,action:'cleanup'},false);
  assert.equal((await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pid);checks.push('cleanup_refuses_open_connections_without_termination');
  for(const change of [{source:'b'.repeat(40)},{context_id:randomUUID()}])await invoke({...request,...change},false);
  assert.equal((await runtime.query('SELECT count(*) FROM onesa_worker_fixture.metadata')).rows[0].count,'1');checks.push('changed_source_or_context_cannot_adopt_owned_resources');
  await invoke({...request,action:'provision',expires_at:new Date(Date.now()-1).toISOString()},false);checks.push('expired_provisioning_cannot_renew_custody');
  await runtime.end();runtime=null;
  const removed=await Promise.all([invoke({...request,action:'cleanup'}),invoke({...request,action:'cleanup'})]);
  assert.ok(removed.every(v=>v.state==='OWNED_STAGING_FIXTURE_REMOVED'));assert.deepEqual(await catalog(),before);checks.push('concurrent_cleanup_removes_only_owned_resources_and_preserves_existing_catalog');
  console.log(JSON.stringify({state:'LOCAL_WORKER_FIXTURE_POSTGRES17_TLS_PASS_NOT_HOSTED_QUALIFICATION',checks,production_access:false,release_records_issued:0}));
 }finally{
  if(runtime)await runtime.end();await owner.end();
 }
}
main().catch(error=>{console.error(JSON.stringify({state:'LOCAL_WORKER_FIXTURE_INTEGRATION_FAILED',category:error?.name||'Error',database_code:/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:undefined}));process.exitCode=1;});
