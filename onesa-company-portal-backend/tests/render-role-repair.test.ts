import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { portalDatabaseURL, confirmedPortalDatabaseURL, assertConfirmedClientTLS, confirmedTargetInventory, inspectConfirmedPortalTarget, initializeConfirmedPortalTarget, initializeEmptyPortalSchema, verifiedSchema, repairPortalRole, safeDiagnostic, assertPortalStagingService, repairPortalStagingDatabase } from '../src/services/render-role-repair.js';

const host='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';
const fixture='postgresql://fixture:synthetic-password@'+host+'/neondb?sslmode=require';
const stagingService={id:'srv-db5k5had0e5s73fos4g0',repo:'https://github.com/DruHustle/onesa-company-portal',branch:'staging',type:'web_service',rootDir:'onesa-company-portal-backend',autoDeployTrigger:'off',serviceDetails:{runtime:'docker',plan:'free',region:'frankfurt',url:'https://onesa-company-portal-backend-staging.onrender.com'}};

test('Staging database binding refuses production, foreign services, paid targets and auto deploy',async()=>{
 assert.doesNotThrow(()=>assertPortalStagingService(stagingService));
 for(const changed of [{id:'srv-production'},{branch:'main'},{repo:'https://github.com/DruHustle/onesa-ai-platform'},{autoDeployTrigger:'commit'},{serviceDetails:{...stagingService.serviceDetails,plan:'starter'}},{serviceDetails:{...stagingService.serviceDetails,url:'https://onesa-company-portal-backend.onrender.com'}}])assert.throws(()=>assertPortalStagingService({...stagingService,...changed}));
 const previous={...process.env};
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-company-portal';
  for(const branch of ['main','dev']){process.env.GITHUB_REF='refs/heads/'+branch;await assert.rejects(repairPortalStagingDatabase(),/staging operator branch/);}
 }finally{process.env=previous;}
});

test('Staging binding verifies existing restricted role and schema before one environment write',async()=>{
 const previous={...process.env};const originalFetch=globalThis.fetch;const connect=pg.Pool.prototype.connect;const end=pg.Pool.prototype.end;
 const migrations:{name:string;checksum:string}[]=[];const tables=new Set(['schema_migrations']);
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql'))){
  const source=await readFile('migrations/'+name,'utf8');migrations.push({name,checksum:createHash('sha256').update(source).digest('hex')});
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))tables.add(match[1]);
 }
 const requests:{url:string;method:string}[]=[];const queries:string[]=[];let saved='';let unsafe=true;
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-company-portal';process.env.GITHUB_REF='refs/heads/staging';process.env.RENDER_API_KEY='synthetic-render-token';process.env.PORTAL_APP_DB_PASSWORD='x'.repeat(64);
  pg.Pool.prototype.connect=(async()=>({connection:{stream:{encrypted:true,authorized:true}},release(){},async query(sql:string){
   queries.push(sql);
   if(sql.includes('current_database()'))return {rows:[{database:'neondb',role:'onesa_portal_app'}]};
   if(sql.includes('AS elevated_role'))return {rowCount:1,rows:[{elevated_role:unsafe,schema_create:false,relation_owner:false,migration_write:false,elevated_membership:false}]};
   if(sql.includes('SELECT name,checksum'))return {rows:migrations};
   if(sql.includes('pg_tables'))return {rows:[...tables].map(tablename=>({tablename}))};
   return {rows:[{allowed:true}]};
  }})) as unknown as typeof connect;
  pg.Pool.prototype.end=(async()=>{}) as typeof end;
  globalThis.fetch=async(input,init)=>{
   const url=String(input);const method=init?.method||'GET';requests.push({url,method});
   if(method==='PUT'){saved=JSON.parse(String(init?.body)).value;return new Response(null,{status:204});}
   return new Response(JSON.stringify(url.includes('/env-vars?')?[{envVar:{key:'DATABASE_URL',value:saved}}]:stagingService));
  };
  await assert.rejects(repairPortalStagingDatabase(),/role remains unsafe/);
  assert.ok(requests.every(request=>request.method==='GET'));requests.length=0;unsafe=false;
  const report=await repairPortalStagingDatabase();
  assert.equal(report.migration_checksums_verified,migrations.length);assert.equal(report.production_modified,false);assert.equal(report.deployment_requested,false);assert.equal(report.permissions_changed,false);
  assert.deepEqual(requests.filter(request=>request.method!=='GET'),[{url:'https://api.render.com/v1/services/'+stagingService.id+'/env-vars/DATABASE_URL',method:'PUT'}]);
  const candidate=new URL(saved);assert.equal(candidate.hostname,'ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech');assert.equal(candidate.username,'onesa_portal_app');assert.equal(candidate.searchParams.get('sslmode'),'verify-full');
  assert.ok(queries.every(sql=>sql.startsWith('SELECT ')||sql==='BEGIN TRANSACTION READ ONLY'||sql==='ROLLBACK'));
 }finally{process.env=previous;globalThis.fetch=originalFetch;pg.Pool.prototype.connect=connect;pg.Pool.prototype.end=end;}
});

test('Read-only runtime inspection ignores an unrelated migration credential and never changes data or roles',async()=>{
 const previous={...process.env};const originalFetch=globalThis.fetch;const connect=pg.Pool.prototype.connect;const end=pg.Pool.prototype.end;
 const migrations:{name:string;checksum:string}[]=[];const tables=new Set(['schema_migrations']);
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql'))){
  const source=await readFile('migrations/'+name,'utf8');migrations.push({name,checksum:createHash('sha256').update(source).digest('hex')});
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))tables.add(match[1]);
 }
 const methods:string[]=[];const queries:string[]=[];let safe=true;
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-company-portal';process.env.GITHUB_REF='refs/heads/dev';process.env.RENDER_API_KEY='synthetic-render';process.env.RENDER_BACKEND_SERVICE_ID='srv-synthetic';
  process.env.PORTAL_MIGRATION_DATABASE_URL='postgresql://unrelated:synthetic@unrelated.example.invalid/neondb?sslmode=require';
  globalThis.fetch=async(input,init)=>{methods.push(init?.method||'GET');return Response.json(String(input).includes('/env-vars?')?[{envVar:{key:'DATABASE_URL',value:fixture}}]:{repo:'https://github.com/DruHustle/onesa-company-portal',branch:'main',type:'web_service',rootDir:'onesa-company-portal-backend',autoDeployTrigger:'off',serviceDetails:{runtime:'docker',url:'https://onesa-company-portal-backend.onrender.com'}});};
  pg.Pool.prototype.connect=(async function(this:pg.Pool){
   assert.equal((this as unknown as {options:{connectionString:string}}).options.connectionString,fixture);
   return {connection:{stream:{encrypted:true,authorized:true}},release(){},async query(sql:string){
    queries.push(sql);
    if(sql.includes('current_database()'))return {rows:[{database:'neondb',role:'fixture'}]};
    if(sql.includes('AS elevated_role'))return {rowCount:1,rows:[{elevated_role:!safe,schema_create:false,relation_owner:false,migration_write:false,elevated_membership:false}]};
    if(sql.includes('SELECT name,checksum'))return {rows:migrations};
    if(sql.includes('pg_tables'))return {rows:[...tables].map(tablename=>({tablename}))};
    return {rows:[{allowed:true}]};
   }};
  }) as unknown as typeof connect;
  pg.Pool.prototype.end=(async()=>{}) as typeof end;
  const report=await repairPortalRole(false);assert.ok('runtime_database_host' in report);
  assert.equal(report.runtime_connection_verified,true);assert.equal(report.migration_credential_used,false);assert.equal(report.runtime_database_host,host);assert.equal(report.permissions_changed,false);assert.equal(report.render_database_url_updated,false);assert.equal(report.migrations_applied,false);assert.equal(report.deployment_requested,false);assert.equal(report.runtime_role_safe,true);
  safe=false;const unsafe=await repairPortalRole(false);assert.ok('runtime_database_host' in unsafe);assert.equal(unsafe.runtime_role_safe,false);
  assert.ok(methods.every(method=>method==='GET'));
  assert.ok(queries.every(sql=>sql.startsWith('SELECT ')||sql==='BEGIN TRANSACTION READ ONLY'||sql==='ROLLBACK'));
  assert.ok(!JSON.stringify(report).includes('synthetic-password'));
 }finally{process.env=previous;globalThis.fetch=originalFetch;pg.Pool.prototype.connect=connect;pg.Pool.prototype.end=end;}
});

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
 assert.equal(await verifiedSchema(connection),rows.length);
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
  process.env.GITHUB_REF='refs/heads/main';process.env.RENDER_BACKEND_SERVICE_ID='srv-testfixture';process.env.RENDER_API_KEY='synthetic-private-token';
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

test('Confirmed production target rejects migration and staging projects and another product',async()=>{
 const confirmed=fixture.replace(host,'ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech');
 assert.equal(confirmedPortalDatabaseURL(confirmed).hostname,'ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech');
 assert.equal(portalDatabaseURL(confirmed,true).hostname,confirmedPortalDatabaseURL(confirmed).hostname);
 for(const wrong of ['ep-autumn-glade-b9760olg.c-7.eu-central-1.aws.neon.tech','ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech'])assert.throws(()=>confirmedPortalDatabaseURL(confirmed.replace('ep-dark-boat-b91lg22g.c-7.eu-central-1.aws.neon.tech',wrong)));
 assert.throws(()=>confirmedPortalDatabaseURL(fixture));
 assert.throws(()=>confirmedPortalDatabaseURL(confirmed.replace('sslmode=require','sslmode=disable')));
 const previous={...process.env};
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-ai-platform';process.env.GITHUB_REF='refs/heads/main';
  await assert.rejects(inspectConfirmedPortalTarget(),/Reviewed Portal/);
  await assert.rejects(initializeConfirmedPortalTarget(),/Reviewed Portal/);
 }finally{process.env=previous;}
});

test('Initialization refuses occupied schemas and existing roles before migration or password changes',async()=>{
 const queries:string[]=[];let occupied=true;let roleExists=false;
 const connection={query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('AS occupied')?[{occupied}]:[],rowCount:sql.includes('pg_roles')&&roleExists?1:0};}} as unknown as Pick<pg.Pool,'query'>;
 await assert.rejects(initializeEmptyPortalSchema(connection,'x'.repeat(64)),/schema is not empty/);
 occupied=false;roleExists=true;
 await assert.rejects(initializeEmptyPortalSchema(connection,'x'.repeat(64)),/Existing application role/);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));
});

test('Confirmed target inspection reports empty or unknown schemas using SELECT only',async()=>{
 const queries:string[]=[];let tables:{tablename:string}[]=[];
 const connection={query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('current_database()')?[{database:'neondb'}]:tables};}} as unknown as Pick<pg.Pool,'query'>;
 assert.deepEqual(await confirmedTargetInventory(connection),{schema_state:'empty',contains_application_rows:false});
 tables=[{tablename:'other_product_private_records'}];
 assert.deepEqual(await confirmedTargetInventory(connection),{schema_state:'unrecognized',contains_application_rows:'not_inspected'});
 assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));
});

test('Confirmed inventory requires encrypted and certificate-verified client TLS',()=>{
 assert.doesNotThrow(()=>assertConfirmedClientTLS({encrypted:true,authorized:true}));
 for(const stream of [{},{encrypted:true,authorized:false},{encrypted:false,authorized:true}])assert.throws(()=>assertConfirmedClientTLS(stream),/client TLS/);
});


test('Confirmed inventory distinguishes seeded configuration from operational records without reading content',async()=>{
 const migrations:{name:string;checksum:string}[]=[];const tables=new Set(['schema_migrations']);
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql'))){
  const source=await readFile('migrations/'+name,'utf8');
  migrations.push({name,checksum:createHash('sha256').update(source).digest('hex')});
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))tables.add(match[1]);
 }
 const populated=new Set(['facts','settings']);const queries:string[]=[];
 const connection={query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('current_database()'))return {rows:[{database:'neondb'}]};
  if(sql.includes('SELECT name,checksum'))return {rows:migrations};
  if(sql.includes('pg_tables'))return {rows:[...tables].map(tablename=>({tablename}))};
  const table=sql.match(/FROM public\."([a-z_]+)"/);
  if(!table)throw new Error('Unexpected inventory query');
  return {rows:[{populated:populated.has(table[1])}]};
 }} as unknown as Pick<pg.Pool,'query'>;
 assert.deepEqual(await confirmedTargetInventory(connection),{schema_state:'verified_portal',contains_application_rows:true,contains_configuration_rows:true,contains_operational_rows:false});
 populated.add('enquiries');
 assert.equal((await confirmedTargetInventory(connection)).contains_operational_rows,true);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));
 assert.ok(queries.filter(sql=>sql.includes('FROM public."')).every(sql=>sql.startsWith('SELECT EXISTS(')));
});

test('Retained dev/staging branches cannot mutate production databases',async()=>{
 const previous={...process.env};const previousFetch=globalThis.fetch;let providerCalls=0;
 try {
  process.env.GITHUB_REPOSITORY='DruHustle/onesa-company-portal';
  globalThis.fetch=async()=>{providerCalls++;throw new Error('Provider must not be called');};
  for(const ref of ['refs/heads/dev','refs/heads/staging']) {
   process.env.GITHUB_REF=ref;
   await assert.rejects(repairPortalRole(true),/Approved Portal/);
   await assert.rejects(initializeConfirmedPortalTarget(),/Reviewed Portal/);
  }
  assert.equal(providerCalls,0);
 }finally{process.env=previous;globalThis.fetch=previousFetch;}
});
