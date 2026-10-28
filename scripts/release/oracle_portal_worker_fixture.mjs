// Private stdin helper for the commissioned worker runner. This is not an issuer.
// Only a fresh, source-bound, empty database on the existing staging compute is
// eligible. Never clone or migrate an existing application database.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const stagingHost='ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw Error('OWNED_STAGING_WORKER_FIXTURE_REFUSED');};
const require=value=>{if(!value)fail();};
const ident=value=>'"'+value+'"'; // Names are generated and validated below.

export function validate(request,now=Date.now()){
 require(request&&Object.getPrototypeOf(request)===Object.prototype);
 require(Object.keys(request).sort().join(',')==='action,context_id,expires_at,fixture_id,owner_uri,runtime_password,source');
 require(['provision','inspect','cleanup'].includes(request.action));
 require(uuid.test(request.context_id)&&uuid.test(request.fixture_id));
 require(/^[a-f0-9]{40}$/.test(request.source));
 const expiry=Date.parse(request.expires_at);
 require(Number.isFinite(expiry)&&new Date(expiry).toISOString()===request.expires_at);
 // Expired credentials may only be inspected or removed, never reactivated.
 require(expiry<=now+3600000&&(request.action!=='provision'||expiry>now+60000));
 require(/^[A-Za-z0-9_-]{40,128}$/.test(request.runtime_password));
 const uri=new URL(request.owner_uri);
 require(['postgres:','postgresql:'].includes(uri.protocol)&&uri.hostname===stagingHost);
 require(uri.username==='neondb_owner'&&uri.password.length>0&&uri.pathname==='/neondb');
 require(!uri.hash&&(!uri.port||uri.port==='5432'));
 require(uri.searchParams.get('sslmode')==='verify-full');
 require(![...uri.searchParams.keys()].some(k=>!['sslmode','sslrootcert','channel_binding','connect_timeout'].includes(k)));
 const suffix=request.fixture_id.replaceAll('-','');
 const database='onesa_wq_'+suffix+'_test',owner='onesa_wq_'+suffix+'_owner',runtime='onesa_wq_'+suffix+'_app';
 const marker='onesa-worker-fixture-v1:'+request.context_id+':'+request.source;
 return {database,owner,runtime,marker,expiry};
}

export function ownedRole(row,marker,login){
 return row&&row.description===marker&&row.rolcanlogin===login&&
  ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(k=>row[k]===false);
}

export function ownedDatabase(row,ownerOid){
 return row&&row.datdba===ownerOid&&row.datname?.startsWith('onesa_wq_')&&row.datname.endsWith('_test');
}

async function connect(uri,database='neondb'){
 const {default:pg}=await import('pg');
 const url=new URL(uri);url.pathname='/'+database;
 // Use the image's reviewed Node CA policy. Host-specific libpq paths are not
 // Node trust stores, and no caller may disable certificate verification.
 for(const k of [...url.searchParams.keys()])url.searchParams.delete(k);
 const client=new pg.Client({connectionString:url.href,ssl:{rejectUnauthorized:true,servername:stagingHost},enableChannelBinding:true,connectionTimeoutMillis:10000,statement_timeout:15000,query_timeout:20000});
 await client.connect();
 require(client.connection.stream.encrypted===true&&client.connection.stream.authorized===true);
 return client;
}

async function roles(client,plan){
 return (await client.query("SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,shobj_description(oid,'pg_authid') AS description FROM pg_roles WHERE rolname=ANY($1::text[])",[[plan.owner,plan.runtime]])).rows;
}

async function inspect(client,plan){
 const found=await roles(client,plan),owner=found.find(r=>r.rolname===plan.owner),runtime=found.find(r=>r.rolname===plan.runtime);
 require(!owner||ownedRole(owner,plan.marker,false));
 require(!runtime||ownedRole(runtime,plan.marker,true));
 require(Boolean(owner)===Boolean(runtime));
 const db=(await client.query('SELECT oid,datname,datdba FROM pg_database WHERE datname=$1',[plan.database])).rows[0];
 require(!db||owner&&ownedDatabase(db,owner.oid));
 return {owner,runtime,db};
}

export async function run(request){
 const plan=validate(request),client=await connect(request.owner_uri);
 try{
  const who=(await client.query('SELECT current_user,current_database(),rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  require(who.current_user==='neondb_owner'&&who.current_database==='neondb'&&who.rolcreatedb&&who.rolcreaterole);
  // Session advisory lock serializes provisioning, inspection and cleanup for
  // this unique fixture. Timeout fails closed; no duplicate DDL request follows.
  await client.query("SELECT pg_advisory_lock(hashtextextended('onesa-worker-fixture:'||$1,0))",[plan.database]);
  let state=await inspect(client,plan);
  async function ownerAccess(){
   // PostgreSQL 16+ gives a non-superuser role creator ADMIN, without SET or
   // INHERIT by default. Access is limited to this transactionally marked,
   // non-login fixture owner; no existing application role is granted.
   require(state.owner&&ownedRole(state.owner,plan.marker,false));
   const access=async()=>((await client.query("SELECT pg_has_role(current_user,$1,'SET') AS can_set,pg_has_role(current_user,$1,'USAGE') AS can_inherit",[plan.owner])).rows[0]);
   let granted=await access();
   if(!granted.can_set||!granted.can_inherit){
    await client.query('BEGIN');
    try{
     await client.query(`GRANT ${ident(plan.owner)} TO CURRENT_USER WITH INHERIT TRUE`);
     await client.query(`GRANT ${ident(plan.owner)} TO CURRENT_USER WITH SET TRUE`);
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    granted=await access();
   }
   require(granted.can_set&&granted.can_inherit);
  }
  if(request.action==='provision'){
   if(!state.owner){
    await client.query('BEGIN');
    try{
     await client.query(`CREATE ROLE ${ident(plan.owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS`);
     const statement=(await client.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS PASSWORD %L VALID UNTIL %L',$1::text,$2::text,$3::text)",[plan.runtime,request.runtime_password,request.expires_at])).rows[0].format;
     await client.query(statement);
     for(const role of [plan.owner,plan.runtime]){
      const comment=(await client.query("SELECT format('COMMENT ON ROLE %I IS %L',$1::text,$2::text)",[role,plan.marker])).rows[0].format;
      await client.query(comment);
     }
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    state=await inspect(client,plan);require(state.owner&&state.runtime&&!state.db);
   }
   await ownerAccess();
   if(!state.db){
    // If interrupted after CREATE DATABASE, its unique, transactionally marked
    // owner role proves ownership on inspection. Never repeat an uncertain DDL.
    await client.query(`CREATE DATABASE ${ident(plan.database)} OWNER ${ident(plan.owner)} TEMPLATE template0`);
    state=await inspect(client,plan);require(state.db);
   }
   const target=await connect(request.owner_uri,plan.database);
   try{
    const comment=(await target.query("SELECT format('COMMENT ON DATABASE %I IS %L',$1::text,$2::text)",[plan.database,plan.marker])).rows[0].format;await target.query(comment);
    // A separate ownership marker prevents treating an arbitrary populated DB
    // as an interrupted migration. Canonical migrations are transactional.
    const tables=(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
    const markerTable=(await target.query("SELECT to_regclass('onesa_worker_fixture.metadata') AS relation")).rows[0].relation;
    require(tables.length===0||markerTable);
    await target.query('BEGIN');
    try{
     await target.query('CREATE SCHEMA IF NOT EXISTS onesa_worker_fixture');
     await target.query('CREATE TABLE IF NOT EXISTS onesa_worker_fixture.metadata(marker text PRIMARY KEY)');
     const old=(await target.query('SELECT marker FROM onesa_worker_fixture.metadata')).rows;
     require(old.length===0||old.length===1&&old[0].marker===plan.marker);
     await target.query('INSERT INTO onesa_worker_fixture.metadata(marker) VALUES($1) ON CONFLICT DO NOTHING',[plan.marker]);
     const {applyMigrationPlan}=await import('/app/dist/src/services/migration-plan.js');
     const applied=await applyMigrationPlan(target);
     await target.query(`REVOKE CONNECT ON DATABASE ${ident(plan.database)} FROM PUBLIC`);
     await target.query(`GRANT CONNECT ON DATABASE ${ident(plan.database)} TO ${ident(plan.runtime)}`);
     const {provisionApplicationRole}=await import('/app/dist/src/services/database-role.js');
     await provisionApplicationRole(target,request.runtime_password,plan.runtime);
     // Runtime can read its marker, but cannot modify its ownership proof.
     await target.query(`GRANT USAGE ON SCHEMA onesa_worker_fixture TO ${ident(plan.runtime)}`);
     await target.query(`GRANT SELECT ON onesa_worker_fixture.metadata TO ${ident(plan.runtime)}`);
     await target.query('COMMIT');
     return {state:'OWNED_STAGING_FIXTURE_PROVISIONED_NOT_AUTHORIZATION',...plan,owner_oid:state.owner.oid,database_oid:state.db.oid,applied_migrations:applied,client_tls_verified:true};
    }catch(error){await target.query('ROLLBACK');throw error;}
   }finally{await target.end();}
  }
  if(request.action==='cleanup'){
   if(state.owner)await ownerAccess();
   if(state.db){
    const n=(await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1',[state.db.oid])).rows[0].n;
    require(n===0); // No FORCE, backend termination or unknown connection killing.
    await client.query(`DROP DATABASE ${ident(plan.database)}`);
   }
   if(state.owner){
    await client.query('BEGIN');
    try{
     await client.query(`DROP ROLE ${ident(plan.runtime)}`);await client.query(`DROP ROLE ${ident(plan.owner)}`);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
   }
   const after=await inspect(client,plan);require(!after.owner&&!after.runtime&&!after.db);
   return {state:'OWNED_STAGING_FIXTURE_REMOVED',database:plan.database,context_id:request.context_id,source:request.source,existing_application_databases_changed:false};
  }
  return {state:'OWNED_STAGING_FIXTURE_INSPECTED_NO_DDL',database:plan.database,roles_present:Boolean(state.owner),database_present:Boolean(state.db),context_id:request.context_id,source:request.source};
 }finally{await client.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;require(size<=16384);chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');
  const result=await run(JSON.parse(raw));
  // No URI, password, SQL statement or arbitrary provider exception is logged.
  delete result.marker;delete result.expiry;
  console.log(JSON.stringify(result));
 }catch(error){
  console.log(JSON.stringify({state:'OWNED_STAGING_FIXTURE_REFUSED_INSPECT_WITHOUT_RETRY',error_code:/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:undefined,request_id:createHash('sha256').update('worker-fixture-v1').digest('hex')}));process.exitCode=1;
 }
}
