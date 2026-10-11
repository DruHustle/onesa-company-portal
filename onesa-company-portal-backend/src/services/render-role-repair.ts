/** Operator-only repair: no migrations, data resets, deployments or secret output. */
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { provisionApplicationRole, applicationRoleStatus } from './database-role.js';

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
const database = 'neondb';
const applicationRole = 'onesa_portal_app';

export function portalDatabaseURL(raw:string, direct=false) {
 let url:URL;
 try {url=new URL(raw);} catch {throw new PortalRepairError('Invalid database connection configuration');}
 const expectedHost=direct?runtimeHost.replace('-pooler.','.'):runtimeHost;
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==expectedHost||url.port&&!['5432'].includes(url.port)||decodeURIComponent(url.pathname.slice(1))!==database||!url.username||!url.password||url.hash)throw new PortalRepairError('Portal database identity mismatch');
 if(!['require','verify-full'].includes(url.searchParams.get('sslmode')||''))throw new PortalRepairError('Portal database requires TLS');
 for(const key of ['sslmode','channel_binding'])if(url.searchParams.getAll(key).length>1)throw new PortalRepairError('Ambiguous database TLS configuration');
 return url;
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
 if(applied.rows.length!==names.length)throw new PortalRepairError('Portal migration inventory mismatch; no migrations applied');
 for(const name of names) {
  const source=await readFile('migrations/'+name,'utf8');
  const checksum=createHash('sha256').update(source).digest('hex');
  if(!applied.rows.some(row=>row.name===name&&row.checksum===checksum))throw new PortalRepairError('Portal schema checksum mismatch; no migrations applied');
  for(const match of source.matchAll(/CREATE TABLE\s+([a-z_]+)/g))expectedTables.add(match[1]);
 }
 const tables=await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 if(tables.rows.length!==expectedTables.size||tables.rows.some(row=>!expectedTables.has(row.tablename)))throw new PortalRepairError('Unrecognized Portal tables; operator review required');
 return names.length;
}

async function verifyRuntime(url:URL,requireSafe=true) {
 const pool=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
 try {
  const status=await applicationRoleStatus(pool);
  if(requireSafe&&!status.safe)throw new PortalRepairError('Runtime database role remains unsafe');
  const migrationCount=await verifiedSchema(pool);
  const tables=await pool.query("SELECT bool_and(has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations'");
  const sequences=await pool.query("SELECT bool_and(has_sequence_privilege(current_user,c.oid,'USAGE') AND has_sequence_privilege(current_user,c.oid,'SELECT')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'");
  if(tables.rows[0]?.allowed!==true||sequences.rows[0]?.allowed===false)throw new PortalRepairError('Incomplete runtime database permissions');
  return {runtime_connection_verified:true,runtime_role_safe:status.safe,runtime_role_reasons:status.reasons,application_permissions_verified:true,migration_checksums_verified:migrationCount};
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
 try {console.log(JSON.stringify(await repairPortalRole(process.argv.includes('--apply')),null,2));}
 catch(error){
  // Database/provider exceptions may contain private values. Only our allowlisted errors leave the runner.
  console.error(safeDiagnostic(error,diagnosticPhase));process.exitCode=1;
 }
}
