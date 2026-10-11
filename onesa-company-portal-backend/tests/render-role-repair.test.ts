import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { portalDatabaseURL, verifiedSchema, repairPortalRole, safeDiagnostic } from '../src/services/render-role-repair.js';

const host='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';
const fixture='postgresql://fixture:synthetic-password@'+host+'/neondb?sslmode=require';
test('Operator repair accepts only the established Portal database and correct pooling scope',()=>{
 assert.equal(portalDatabaseURL(fixture).hostname,host);
 assert.equal(portalDatabaseURL(fixture.replace('-pooler.','.'),true).hostname,host.replace('-pooler.','.'));
 for(const value of [fixture.replace(host,'ep-falling-thunder-b9x4ka3b-pooler.c-7.eu-central-1.aws.neon.tech'),fixture.replace('/neondb','/other'),fixture.replace('sslmode=require','sslmode=disable'),fixture+'&sslmode=disable',fixture.replace('-pooler.','.'),fixture.replace('postgresql:','https:'),fixture+'#ignored'])assert.throws(()=>portalDatabaseURL(value));
 assert.throws(()=>portalDatabaseURL(fixture,true));
});
test('Schema repair refuses missing, changed, extra migrations and unknown tables without applying SQL',async()=>{
 const rows=[];const tables=new Set(['schema_migrations']);
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql'))) {
  const source=await readFile('migrations/'+name,'utf8');
  rows.push({name,checksum:createHash('sha256').update(source).digest('hex')});
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))tables.add(match[1]);
 }
 let migrations=rows;let tableNames=[...tables];
 const queries:string[]=[];
 const connection={query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('schema_migrations')?migrations:tableNames.map(tablename=>({tablename}))};}} as unknown as Pick<pg.Pool,'query'>;
 assert.equal(await verifiedSchema(connection),7);
 migrations=rows.slice(1);await assert.rejects(verifiedSchema(connection),/migration inventory/);
 migrations=rows.map((row,index)=>index?row:{...row,checksum:'changed'});await assert.rejects(verifiedSchema(connection),/checksum mismatch/);
 migrations=[...rows,{name:'unknown.sql',checksum:'unknown'}];await assert.rejects(verifiedSchema(connection),/migration inventory/);
 migrations=rows;tableNames.push('private_other_product');await assert.rejects(verifiedSchema(connection),/Unrecognized Portal tables/);
 tableNames=[...tables].slice(1);await assert.rejects(verifiedSchema(connection),/Unrecognized Portal tables/);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));
});
test('Operator repair cannot target staging AI or a different repository/service',async()=>{
 const previous={...process.env};const previousFetch=globalThis.fetch;
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-ai-platform';process.env.GITHUB_REF='refs/heads/main';
  await assert.rejects(repairPortalRole(true),/Approved Portal/);
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-company-portal';process.env.GITHUB_REF='refs/heads/staging';
  await assert.rejects(repairPortalRole(true),/Approved Portal/);
  process.env.GITHUB_REF='refs/heads/fix/render-runtime-repair';process.env.RENDER_BACKEND_SERVICE_ID='srv-testfixture';process.env.RENDER_API_KEY='synthetic-private-token';
  const methods:string[]=[];
  globalThis.fetch=async(_input,init)=>{methods.push(init?.method||'GET');return new Response(JSON.stringify({repo:'https://github.com/DruHustle/onesa-ai-platform',type:'web_service'}));};
  await assert.rejects(repairPortalRole(true),/Portal Render target/);assert.deepEqual(methods,['GET']);
 }finally{process.env=previous;globalThis.fetch=previousFetch;}
});
test('Operator diagnostics identify the failed phase without disclosing database errors',()=>{
 for(const [code,expected] of [['28P01','database_authentication_rejected'],['42501','database_permission_denied'],['42P01','database_schema_missing'],['other','database_or_provider_unavailable']]){
  const error=Object.assign(new Error('private-password-and-database-url'),{code});
  const diagnostic=safeDiagnostic(error,'migration-url-validation');
  assert.ok(diagnostic.startsWith('migration-url-validation: '+expected));
  assert.ok(!diagnostic.includes('private-password'));
 }
 assert.ok(!safeDiagnostic(null,'target-verification').includes('null'));
});
