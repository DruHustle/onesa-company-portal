import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validate,ownedRole,ownedDatabase,stagingHost} from './oracle_portal_worker_fixture.mjs';

const now=Date.parse('2026-10-28T01:00:00.000Z');
const request=()=>({action:'provision',context_id:'01234567-89ab-4cde-8123-456789abcdef',fixture_id:'11234567-89ab-4cde-8123-456789abcdef',source:'a'.repeat(40),expires_at:new Date(now+1800000).toISOString(),owner_uri:`postgresql://neondb_owner:synthetic-not-a-credential@${stagingHost}/neondb?sslmode=verify-full&channel_binding=require`,runtime_password:'synthetic-owned-fixture-password-00000000000000'});

test('only a unique empty staging namespace is derived from the fixture UUID',()=>{
 const plan=validate(request(),now);
 assert.match(plan.database,/^onesa_wq_[a-f0-9]{32}_test$/);
 assert.match(plan.owner,/^onesa_wq_[a-f0-9]{32}_owner$/);
 assert.match(plan.runtime,/^onesa_wq_[a-f0-9]{32}_app$/);
 assert.notEqual(plan.database,'neondb');
 assert.ok(plan.marker.includes(request().context_id)&&plan.marker.endsWith(request().source));
 for(const name of [plan.database,plan.owner,plan.runtime])assert.ok(name.length<=63);
});

test('production, pooled, foreign, application-role and existing-data targets fail before importing pg',()=>{
 for(const change of [
  {owner_uri:request().owner_uri.replace(stagingHost,'ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech')},
  {owner_uri:request().owner_uri.replace(stagingHost,stagingHost.replace('.c-7.','-pooler.c-7.'))},
  {owner_uri:request().owner_uri.replace(stagingHost,'localhost')},
  {owner_uri:request().owner_uri.replace('neondb_owner','onesa_portal_app')},
  {owner_uri:request().owner_uri.replace('/neondb?','/customer_data?')},
  {owner_uri:request().owner_uri.replace('verify-full','disable')},
  {owner_uri:request().owner_uri+'&options=-c%20role%3Dpostgres'},
  {owner_uri:request().owner_uri+'#caller-data'},
  {fixture_id:'existing_database'}, {context_id:'0'}, {source:'main'},
  {action:'deploy'}, {workflow_run_id:0}, {owner_authorized:true},
 ])assert.throws(()=>validate({...request(),...change},now),/REFUSED/);
});

test('expired provisioning refuses reuse; inspection and bounded cleanup never renew expiry',()=>{
 const expires_at=new Date(now-1).toISOString();
 assert.throws(()=>validate({...request(),expires_at},now),/REFUSED/);
 for(const action of ['inspect','cleanup'])assert.equal(validate({...request(),expires_at,action},now).expiry,now-1);
 assert.throws(()=>validate({...request(),expires_at:new Date(now+3600001).toISOString()},now),/REFUSED/);
});

test('source-bound role comments and exact privileges are required before any cleanup',()=>{
 const marker=validate(request(),now).marker;
 const role={description:marker,rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false};
 assert.equal(ownedRole(role,marker,false),true);
 for(const key of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(ownedRole({...role,[key]:true},marker,false),false);
 assert.equal(ownedRole({...role,description:marker.replace('a'.repeat(40),'b'.repeat(40))},marker,false),false);
 assert.equal(ownedRole({...role,rolcanlogin:true},marker,false),false);
 assert.equal(Boolean(ownedRole(undefined,marker,false)),false);
});

test('the database must belong to the unique marked owner role',()=>{
 const p=validate(request(),now),row={datname:p.database,datdba:123};
 assert.equal(ownedDatabase(row,123),true);
 assert.equal(ownedDatabase(row,124),false);
 assert.equal(ownedDatabase({...row,datname:'neondb'},123),false);
});

test('CLI failure output contains no supplied URI, password or exception payload',()=>{
 const value={...request(),owner_uri:'postgresql://private-user:do-not-log-this@foreign.invalid/neondb'};
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./oracle_portal_worker_fixture.mjs',import.meta.url))],{input:JSON.stringify(value),encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(result.status,1);
 const output=JSON.parse(result.stdout);
 assert.equal(output.state,'OWNED_STAGING_FIXTURE_REFUSED_INSPECT_WITHOUT_RETRY');
 assert.doesNotMatch(result.stdout+result.stderr,/private-user|do-not-log-this|foreign\.invalid|postgresql:/);
 assert.equal(result.stderr,'');
});
