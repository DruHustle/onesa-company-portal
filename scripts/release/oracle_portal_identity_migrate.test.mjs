import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {additions,connectionScope,migrate,validateRequest,validateState} from './oracle_portal_identity_migrate.mjs';

const directory=fileURLToPath(new URL('../../onesa-company-portal-backend/migrations/',import.meta.url));
const files={};for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())files[name]=await readFile(directory+name,'utf8');
const manifest=Object.fromEntries(Object.entries(files).map(([name,raw])=>[name,createHash('sha256').update(raw).digest('hex')]));
const request=()=>({action:'apply',environment:'staging',operation_id:'11111111-1111-4111-8111-111111111111',source_commit:'a'.repeat(40),
 database:{host:'ep-identity.example.test',database:'portal_test',owner_role:'portal_owner',application_role:'portal_app'},
 owner_uri:'postgresql://portal_owner:synthetic-owner@ep-identity.example.test/portal_test?sslmode=verify-full',
 runtime_uri:'postgresql://portal_app:synthetic-app@ep-identity.example.test/portal_test?sslmode=verify-full',migrations:structuredClone(manifest)});

function fixture(count=12){
 let rows=Object.entries(manifest).slice(0,count).map(([name,checksum])=>({name,checksum}));
 const calls=[];let preserved='unchanged',committed=false;
 const io={
  async begin(readonly){calls.push(readonly?'read-only':'begin');},async lock(){calls.push('lock');},
  async identity(){return true;},async files(){return structuredClone(files);},async rows(){return structuredClone(rows);},
  async preservation(){return preserved;},async apply(name,sql,checksum){calls.push(name);assert.equal(sql,files[name]);rows.push({name,checksum});},
  async grants(role){assert.equal(role,'portal_app');calls.push('existing-role-grants');},
  async commit(){committed=true;calls.push('commit');},async rollback(){calls.push(committed?'inspect-after-commit':'rollback');},
  async runtimeReady(){calls.push('runtime-readiness');return true;},async close(){calls.push('close');},
 };
 return {io,calls,get rows(){return rows;},set rows(value){rows=value;},changeAccounts(){preserved='changed';}};
}

test('only the reviewed additive migration bytes are permitted',()=>{
 assert.deepEqual(Object.fromEntries(Object.keys(additions).map(n=>[n,manifest[n]])),additions);
 for(const name of Object.keys(additions)){
  const r=request();r.migrations[name]='0'.repeat(64);assert.throws(()=>validateRequest(r),/SOURCE_CHANGED/);
 }
 const r=request();r.migrations['015_unreviewed.sql']='0'.repeat(64);assert.throws(()=>validateRequest(r));
});

test('foreign host/database/role, disabled TLS and duplicated query parameters fail closed',()=>{
 const r=request();connectionScope(r.owner_uri,r.database,true);
 for(const uri of [
  r.owner_uri.replace('ep-identity.example.test','production.example.test'),r.owner_uri.replace('/portal_test','/production'),
  r.owner_uri.replace('portal_owner:','portal_app:'),r.owner_uri.replace('verify-full','require'),
  r.owner_uri+'&sslmode=disable',r.owner_uri+'&options=-csearch_path=foreign',r.owner_uri.replace('postgresql:','http:'),
 ])assert.throws(()=>connectionScope(uri,r.database,true));
});

test('migration is atomic, grants only after both migrations, and checks real runtime readiness',async()=>{
 const f=fixture();const result=await migrate(request(),f.io);
 assert.equal(result.applied_migrations,2);assert.equal(result.schema_version,14);assert.equal(result.credential_changes,0);
 assert.deepEqual(f.calls,['begin','lock',...Object.keys(additions),'existing-role-grants','commit','runtime-readiness','close']);
});

test('already-applied 014 is idempotent without recreating tables or credentials',async()=>{
 const f=fixture(14);const result=await migrate(request(),f.io);
 assert.equal(result.applied_migrations,0);assert.ok(!f.calls.some(name=>name.endsWith('.sql')));
 assert.deepEqual(f.calls,['begin','lock','existing-role-grants','commit','runtime-readiness','close']);
});

test('inspection is read only and never grants, migrates or runs writable readiness',async()=>{
 const f=fixture();const result=await migrate({...request(),action:'inspect'},f.io);
 assert.equal(result.schema_version,12);assert.equal(result.applied_migrations,0);
 assert.deepEqual(f.calls,['read-only','lock','commit','close']);
});

test('partial schema, checksum drift and duplicate migration rows refuse before writes',async()=>{
 for(const change of ['partial','checksum','duplicate','unknown']){
  const f=fixture(change==='partial'?13:12);
  if(change==='checksum')f.rows[0].checksum='0'.repeat(64);
  if(change==='duplicate')f.rows[1]={...f.rows[0]};
  if(change==='unknown')f.rows[0].name='999_foreign.sql';
  await assert.rejects(()=>migrate(request(),f.io));
  assert.deepEqual(f.calls,['begin','lock','rollback','close']);
 }
});

test('changed image SQL refuses even when the supplied manifest looks valid',async()=>{
 const f=fixture();f.io.files=async()=>({...files,[Object.keys(additions)[0]]:'DROP TABLE users;'});
 await assert.rejects(()=>migrate(request(),f.io),/IMAGE_CHANGED/);
 assert.deepEqual(f.calls,['begin','lock','rollback','close']);
});

test('failure in migration 014 or grants rolls back instead of continuing or retrying',async()=>{
 for(const stage of ['014','grants']){
  const f=fixture();const original=f.io.apply;
  if(stage==='014')f.io.apply=async(...args)=>{if(args[0].startsWith('014'))throw Error('synthetic failure');await original(...args);};
  else f.io.grants=async()=>{throw Error('synthetic grant failure');};
  await assert.rejects(()=>migrate(request(),f.io),/synthetic/);
  assert.ok(!f.calls.includes('commit'));assert.equal(f.calls.filter(x=>x==='rollback').length,1);assert.equal(f.calls.at(-1),'close');
 }
});

test('changing any existing credential or role prevents commit',async()=>{
 const f=fixture();f.io.grants=async()=>f.changeAccounts();
 await assert.rejects(()=>migrate(request(),f.io),/EXISTING_ACCOUNTS_CHANGED/);
 assert.ok(!f.calls.includes('commit'));assert.ok(f.calls.includes('rollback'));
});

test('post-commit readiness ambiguity cannot return a success receipt or rerun migrations',async()=>{
 const f=fixture();f.io.runtimeReady=async()=>false;
 await assert.rejects(()=>migrate(request(),f.io),/GRANTS_UNQUALIFIED/);
 assert.equal(f.calls.filter(x=>x==='commit').length,1);
 assert.equal(f.calls.filter(x=>x.startsWith('013')).length,1);
 assert.ok(f.calls.includes('inspect-after-commit'));
});

test('connection identity is checked before any schema write',async()=>{
 const f=fixture();f.io.identity=async()=>false;
 await assert.rejects(()=>migrate(request(),f.io),/IDENTITY_CHANGED/);
 assert.deepEqual(f.calls,['begin','lock','rollback','close']);
});

test('exact 001–014 state matching excludes newer or reordered counterfeit names',()=>{
 const rows=Object.entries(manifest).map(([name,checksum])=>({name,checksum}));
 assert.equal(validateState(rows.reverse(),manifest),14);
 rows[0]={name:'099_forged.sql',checksum:rows[0].checksum};assert.throws(()=>validateState(rows,manifest));
});
