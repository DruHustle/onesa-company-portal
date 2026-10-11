/** Operator-only operations: never reset data, deploy or emit credentials. */
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { TLSSocket } from 'node:tls';
import { provisionApplicationRole, applicationRoleStatus } from './database-role.js';
import { applyMigrationPlan } from './migration-plan.js';

class PortalRepairError extends Error {}
let diagnosticPhase='target-verification';

export function safeDiagnostic(error:unknown,phase:string) {
 if(error instanceof PortalRepairError)return phase+': '+error.message;
 const code=(error as {code?:unknown})?.code;
 const category=code==='28P01'||code==='28000'?'database_authentication_rejected':code==='42501'?'database_permission_denied':code==='42P01'?'database_schema_missing':'database_or_provider_unavailable';
 return phase+': '+category+'; no credentials or response bodies emitted';
}

const repository = 'https://github.com/DruHustle/onesa-company-portal';
const runtimeHost = 'ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';
// Owner-confirmed on 2026-10-11. Neither inspection nor initialization cuts over runtime.
const confirmedDirectHost = 'ep-autumn-glade-b9760olg.c-7.eu-central-1.aws.neon.tech';
const database = 'neondb';
const applicationRole = 'onesa_portal_app';

function validatedDatabaseURL(raw:string,expectedHost:string) {
 let url:URL;
 try {url=new URL(raw);} catch {throw new PortalRepairError('Invalid database connection configuration');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==expectedHost||url.port&&!['5432'].includes(url.port)||decodeURIComponent(url.pathname.slice(1))!==database||!url.username||!url.password||url.hash)throw new PortalRepairError('Portal database identity mismatch');
 if(!['require','verify-full'].includes(url.searchParams.get('sslmode')||''))throw new PortalRepairError('Portal database requires TLS');
 for(const key of ['sslmode','channel_binding'])if(url.searchParams.getAll(key).length>1)throw new PortalRepairError('Ambiguous database TLS configuration');
 return url;
}

export function portalDatabaseURL(raw:string, direct=false) {
 return validatedDatabaseURL(raw,direct?runtimeHost.replace('-pooler.','.'):runtimeHost);
}

export function confirmedPortalDatabaseURL(raw:string) {
 return validatedDatabaseURL(raw,confirmedDirectHost);
}

export function assertConfirmedClientTLS(stream:{encrypted?:boolean;authorized?:boolean}) {
 if(stream.encrypted!==true||stream.authorized!==true)throw new PortalRepairError('Confirmed Portal client TLS is not certificate verified');
}

export async function confirmedTargetInventory(connection:Pick<pg.Pool,'query'>) {
 const identity=await connection.query('SELECT current_database() AS database');
 if(identity.rows[0]?.database!==database)throw new PortalRepairError('Confirmed Portal target database identity mismatch');
 const tables=await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 if(tables.rows.length===0)return {schema_state:'empty',contains_application_rows:false};
 if(!tables.rows.some(row=>row.tablename==='schema_migrations'))return {schema_state:'unrecognized',contains_application_rows:'not_inspected'};
 try {await verifiedSchema(connection);}
 catch(error) {
  if(error instanceof PortalRepairError)return {schema_state:'portal_schema_mismatch',contains_application_rows:'not_inspected'};
  throw error;
 }
 let populated=false,configurationRows=false,operationalRows=false;
 for(const row of tables.rows.filter(row=>row.tablename!=='schema_migrations')) {
  const table='"'+String(row.tablename).replaceAll('"','""')+'"';
  const result=await connection.query(`SELECT EXISTS(SELECT 1 FROM public.${table} LIMIT 1) AS populated`);
  const present=result.rows[0]?.populated===true;
  populated=populated||present;
  // Migrations seed facts/settings; their presence is not evidence of business records.
  if(['facts','settings'].includes(row.tablename))configurationRows=configurationRows||present;
  else operationalRows=operationalRows||present;
 }
 return {schema_state:'verified_portal',contains_application_rows:populated,contains_configuration_rows:configurationRows,contains_operational_rows:operationalRows};
}

async function confirmedTargetContext() {
 if(process.env.GITHUB_REPOSITORY!=='DruHustle/onesa-company-portal'||process.env.GITHUB_REF!=='refs/heads/audit/portal-master-acceptance')throw new PortalRepairError('Reviewed Portal inspection branch required');
 diagnosticPhase='confirmed-migration-url-validation';
 const owner=confirmedPortalDatabaseURL(process.env.PORTAL_MIGRATION_DATABASE_URL||'');
 const serviceID=process.env.RENDER_BACKEND_SERVICE_ID||'';
 if(!/^srv-[a-zA-Z0-9]+$/.test(serviceID))throw new PortalRepairError('Missing Portal service ID');
 diagnosticPhase='confirmed-target-provider-inspection';
 const service=await provider('services/'+serviceID);
 const details=service.serviceDetails||{};
 if(service.repo?.replace(/\.git$/,'')!==repository||service.branch!=='main'||service.type!=='web_service'||details.env!=='docker'&&details.runtime!=='docker'||service.rootDir!=='onesa-company-portal-backend'||details.url!=='https://onesa-company-portal-backend.onrender.com'||service.autoDeployTrigger!=='off'&&service.autoDeploy!=='no')throw new PortalRepairError('Portal Render target or auto-deploy policy mismatch');
 const entries=await provider('services/'+serviceID+'/env-vars?limit=100');
 if(!Array.isArray(entries)||entries.length>=100)throw new PortalRepairError('Incomplete Portal environment inventory');
 const runtimeValue=entries.map(item=>item.envVar||item).find(item=>item.key==='DATABASE_URL')?.value||'';
 const runtime=portalDatabaseURL(runtimeValue);
 return {owner,runtime};
}

export async function inspectConfirmedPortalTarget() {
 const {owner,runtime}=await confirmedTargetContext();
 diagnosticPhase='confirmed-target-read-only-inventory';
 const pool=new pg.Pool({connectionString:owner.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
 try {
  const client=await pool.connect();
  try {
   // Neon terminates client TLS at its proxy; pg_stat_ssl describes a different hop.
   assertConfirmedClientTLS(client.connection.stream as Partial<TLSSocket>);
   await client.query('BEGIN TRANSACTION READ ONLY');
   const inventory=await confirmedTargetInventory(client);
   await client.query('ROLLBACK');
   return {read_only:true,client_tls_verified:true,confirmed_direct_host:confirmedDirectHost,database,existing_runtime_direct_host:runtime.hostname.replace('-pooler.','.'),runtime_matches_confirmed_target:false,...inventory,database_cutover:false,migrations_applied:false,permissions_changed:false,deployment_requested:false};
  }finally{client.release();}
 }finally{await pool.end();}
}

/** Caller must identify the database and own the transaction. Existing objects/roles are preserved. */
export async function initializeEmptyPortalSchema(client:Pick<pg.Pool,'query'>,password:string,role=applicationRole) {
 if(!/^[A-Za-z0-9_-]{64}$/.test(password))throw new PortalRepairError('A dedicated generated application password must be saved privately before initialization');
 await client.query('SELECT pg_advisory_xact_lock(757830)');
 await client.query('SELECT pg_advisory_xact_lock(757831)');
 const objects=await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS occupied");
 if(objects.rows[0]?.occupied!==false)throw new PortalRepairError('Confirmed Portal schema is not empty; preserve it for operator review');
 const existing=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
 if(existing.rowCount)throw new PortalRepairError('Existing application role must be preserved; initialization cannot replace its password');
 await client.query('SET LOCAL search_path TO public, pg_catalog');
 const applied=await applyMigrationPlan(client);
 if(await verifiedSchema(client)!==applied)throw new PortalRepairError('Initialization migration verification failed');
 await provisionApplicationRole(client,password,role);
 return applied;
}

export async function initializeConfirmedPortalTarget() {
 const {owner,runtime}=await confirmedTargetContext();
 const password=process.env.PORTAL_APP_DB_PASSWORD||'';
 if(!/^[A-Za-z0-9_-]{64}$/.test(password))throw new PortalRepairError('Save the dedicated application password as PORTAL_APP_DB_PASSWORD before initialization');
 const pool=new pg.Pool({connectionString:owner.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
 let applied=0;
 try {
  const client=await pool.connect();
  try {
   diagnosticPhase='confirmed-target-initialization';
   assertConfirmedClientTLS(client.connection.stream as Partial<TLSSocket>);
   await client.query('BEGIN');
   const identity=await client.query('SELECT current_database() AS database');
   if(identity.rows[0]?.database!==database)throw new PortalRepairError('Confirmed Portal target database identity mismatch');
   applied=await initializeEmptyPortalSchema(client,password);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }finally{await pool.end();}
 // Verify the new login directly; do not change any Render setting or deploy an old image.
 diagnosticPhase='confirmed-application-role-verification';
 const candidate=new URL(owner.toString());candidate.username=applicationRole;candidate.password=password;
 const verified=await verifyRuntime(candidate);
 return {read_only:false,client_tls_verified:true,confirmed_direct_host:confirmedDirectHost,database,existing_runtime_direct_host:runtime.hostname.replace('-pooler.','.'),schema_state:'verified_portal',migrations_applied:applied,application_role_created:true,...verified,database_cutover:false,render_database_url_updated:false,existing_runtime_untouched:true,worker_modified:false,deployment_requested:false};
}

async function provider(path:string, method='GET', payload?:unknown) {
 const token=process.env.RENDER_API_KEY;
 if(!token)throw new PortalRepairError('Missing Render access');
 const response=await fetch('https://api.render.com/v1/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw new PortalRepairError('Render operation failed: HTTP '+response.status);
 return response.status===204?null:response.json();
}

export async function verifiedSchema(connection:Pick<pg.Pool,'query'>) {
 const names=(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort();
 const expectedTables=new Set(['schema_migrations']);
 const applied=await connection.query('SELECT name,checksum FROM public.schema_migrations');
 if(applied.rows.length!==names.length)throw new PortalRepairError('Portal migration inventory mismatch');
 for(const name of names) {
  const source=await readFile('migrations/'+name,'utf8');
  const checksum=createHash('sha256').update(source).digest('hex');
  if(!applied.rows.some(row=>row.name===name&&row.checksum===checksum))throw new PortalRepairError('Portal schema checksum mismatch');
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))expectedTables.add(match[1]);
 }
 const tables=await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 if(tables.rows.length!==expectedTables.size||tables.rows.some(row=>!expectedTables.has(row.tablename)))throw new PortalRepairError('Unrecognized Portal tables; operator review required');
 return names.length;
}

async function verifyRuntime(url:URL,requireSafe=true) {
 const pool=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
 try {
  const client=await pool.connect();
  try {
  assertConfirmedClientTLS(client.connection.stream as Partial<TLSSocket>);
  const status=await applicationRoleStatus(client);
  if(requireSafe&&!status.safe)throw new PortalRepairError('Runtime database role remains unsafe');
  const migrationCount=await verifiedSchema(client);
  const tables=await client.query("SELECT bool_and(has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations'");
  const sequences=await client.query("SELECT bool_and(has_sequence_privilege(current_user,c.oid,'USAGE') AND has_sequence_privilege(current_user,c.oid,'SELECT')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'");
  if(tables.rows[0]?.allowed!==true||sequences.rows[0]?.allowed===false)throw new PortalRepairError('Incomplete runtime database permissions');
  return {runtime_connection_verified:true,runtime_tls_verified:true,runtime_role_safe:status.safe,runtime_role_reasons:status.reasons,application_permissions_verified:true,migration_checksums_verified:migrationCount};
  }finally{client.release();}
 }finally{await pool.end();}
}

export async function repairPortalRole(apply=false) {
 const approved=['refs/heads/main','refs/heads/fix/render-runtime-repair',...(!apply?['refs/heads/audit/portal-master-acceptance']:[])];
 if(process.env.GITHUB_REPOSITORY!=='DruHustle/onesa-company-portal'||!approved.includes(process.env.GITHUB_REF||''))throw new PortalRepairError('Approved Portal operator branch required');
 const serviceID=process.env.RENDER_BACKEND_SERVICE_ID||'';
 if(!/^srv-[a-zA-Z0-9]+$/.test(serviceID))throw new PortalRepairError('Missing Portal service ID');
 const service=await provider('services/'+serviceID);
 const details=service.serviceDetails||{};
 if(service.repo?.replace(/\.git$/,'')!==repository||service.branch!=='main'||service.type!=='web_service'||details.env!=='docker'&&details.runtime!=='docker'||service.rootDir!=='onesa-company-portal-backend'||details.url!=='https://onesa-company-portal-backend.onrender.com'||service.autoDeployTrigger!=='off'&&service.autoDeploy!=='no')throw new PortalRepairError('Portal Render target or auto-deploy policy mismatch');
 const entries=await provider('services/'+serviceID+'/env-vars?limit=100');
 if(!Array.isArray(entries)||entries.length>=100)throw new PortalRepairError('Incomplete Portal environment inventory');
 const values:Record<string,string>={};
 for(const entry of entries){const item=entry.envVar||entry;values[item.key]=item.value;}
 diagnosticPhase='runtime-url-validation';
 const runtime=portalDatabaseURL(values.DATABASE_URL||'');
 const rawOwner=process.env.PORTAL_MIGRATION_DATABASE_URL;
 if(!rawOwner) {
  if(apply)throw new PortalRepairError('Save fresh direct PORTAL_MIGRATION_DATABASE_URL privately before applying');
  return {read_only:true,render_identity_verified:true,portal_database_identity_verified:true,owner_secret_configured:false,deployment_requested:false};
 }
 diagnosticPhase='migration-url-validation';
 const owner=portalDatabaseURL(rawOwner,true);
 const pool=new pg.Pool({connectionString:owner.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
 try {
  diagnosticPhase='owner-connection-and-schema';
  const migrationCount=await verifiedSchema(pool);
  const role=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[applicationRole])).rows[0];
  const report={read_only:!apply,render_identity_verified:true,portal_database_identity_verified:true,owner_secret_configured:true,migration_checksums_verified:migrationCount,existing_application_role:!!role,deployment_requested:false};
  if(!apply){diagnosticPhase='runtime-role-verification';return {...report,runtime_is_application_role:decodeURIComponent(runtime.username)===applicationRole,...await verifyRuntime(runtime,false)};}
  if(role&&Object.values(role).some(Boolean))throw new PortalRepairError('Existing Portal role has elevated privileges; operator review required');
  if(role&&decodeURIComponent(runtime.username)!==applicationRole)throw new PortalRepairError('Existing role password is unknown; preserve it and request private operator configuration');
  diagnosticPhase='permission-repair';
  const password=role?decodeURIComponent(runtime.password):randomBytes(48).toString('base64url');
  const client=await pool.connect();
  try {
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(757831)');
   await verifiedSchema(client);
   await provisionApplicationRole(client,password);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const candidate=new URL(runtime.toString());candidate.username=applicationRole;candidate.password=password;
  diagnosticPhase='runtime-role-verification';
  const verified=await verifyRuntime(candidate);
  // Change only DATABASE_URL. Provider updates do not deploy; all other credentials stay scoped.
  diagnosticPhase='provider-runtime-update';
  await provider('services/'+serviceID+'/env-vars/DATABASE_URL','PUT',{value:candidate.toString()});
  const readback=await provider('services/'+serviceID+'/env-vars?limit=100');
  const saved=readback.map((item:{envVar?:{key:string,value:string},key?:string,value?:string})=>item.envVar||item).find((item:{key:string})=>item.key==='DATABASE_URL');
  if(saved?.value!==candidate.toString())throw new PortalRepairError('Private Render environment readback mismatch');
  return {...report,...verified,render_database_url_updated:true,existing_data_preserved:true,worker_modified:false};
 }finally{await pool.end();}
}

if(process.argv[1]?.endsWith('render-role-repair.ts')||process.argv[1]?.endsWith('render-role-repair.js')) {
 try {
  const flags=process.argv.slice(2);
  if(flags.length>1||flags.some(flag=>!['--apply','--inspect-confirmed-target','--initialize-confirmed-target'].includes(flag)))throw new PortalRepairError('Choose exactly one recognized Portal operator action');
  const report=flags.includes('--inspect-confirmed-target')?await inspectConfirmedPortalTarget():flags.includes('--initialize-confirmed-target')?await initializeConfirmedPortalTarget():await repairPortalRole(flags.includes('--apply'));
  console.log(JSON.stringify(report,null,2));
 }
 catch(error){
  // Database/provider exceptions may contain private values. Only our allowlisted errors leave the runner.
  console.error(safeDiagnostic(error,diagnosticPhase));process.exitCode=1;
 }
}
