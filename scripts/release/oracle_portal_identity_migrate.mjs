// Fixed, transaction-bound 012 -> 014 migration for the owner identity adapter.
// Credentials arrive on private stdin; this helper never creates release authority.
import {createHash,X509Certificate} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const additions={
 '013_onesa_identity.sql':'ce7f4ab09f7fafb915b4a4e8b1657ef1e6520494bd28a0492fc3d46d0f4d79e7',
 '014_identity_grant_sessions.sql':'a45640fc7a946f410033c0cc9cd666bfcb2e6a8e02a4f5a200bc2b548f7ce03f',
};
const need=(value,code='IDENTITY_MIGRATION_REFUSED')=>{if(!value)throw Error(code);};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hex=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');

export function connectionScope(uri,target,owner){
 const u=new URL(uri);
 need(['postgres:','postgresql:'].includes(u.protocol)&&u.hostname===target.host&&u.pathname==='/'+target.database&&!u.hash&&(!u.port||u.port==='5432'));
 need(decodeURIComponent(u.username)===(owner?target.owner_role:target.application_role)&&u.password.length>0);
 need(u.searchParams.getAll('sslmode').length===1&&u.searchParams.get('sslmode')==='verify-full');
 need(![...u.searchParams.keys()].some(k=>!['sslmode','sslrootcert','channel_binding','connect_timeout'].includes(k)));
 return u;
}

export function validateRequest(request){
 const fields=['action','environment','operation_id','source_commit','database','owner_uri','runtime_uri','migrations'];
 if(Object.hasOwn(request||{},'database_ca_pem'))fields.push('database_ca_pem');
 need(exact(request,fields));
 if(Object.hasOwn(request,'database_ca_pem'))validateDatabaseCA(request.database_ca_pem);
 need(['inspect','apply'].includes(request.action)&&['staging','production'].includes(request.environment));
 need(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.operation_id));
 need(/^[a-f0-9]{40}$/.test(request.source_commit));
 const db=request.database;
 need(exact(db,['host','database','owner_role','application_role']));
 need(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(db.host)&&/^[a-z][a-z0-9_]{0,62}$/.test(db.database));
 need([db.owner_role,db.application_role].every(v=>/^[a-z][a-z0-9_]{0,62}$/.test(v))&&db.owner_role!==db.application_role);
 need(exact(request.migrations,Object.keys(request.migrations))&&Object.keys(request.migrations).length===14);
 const names=Object.keys(request.migrations).sort();
 need(names.every((n,i)=>n.startsWith(String(i+1).padStart(3,'0')+'_')&&/^\d{3}_[a-z_]+\.sql$/.test(n)&&hex.test(request.migrations[n])));
 need(Object.entries(additions).every(([n,h])=>request.migrations[n]===h),'IDENTITY_MIGRATION_SOURCE_CHANGED');
 connectionScope(request.owner_uri,db,true);connectionScope(request.runtime_uri,db,false);
 return request;
}

// A custody-pinned private CA is optional for a self-hosted database. Accept
// exactly one certificate authority, never keys, chains or unbounded input.
export function validateDatabaseCA(pem){
 need(typeof pem==='string'&&Buffer.byteLength(pem)<=8192&&/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(pem),'IDENTITY_DATABASE_CA_INVALID');
 let certificate;try{certificate=new X509Certificate(pem);}catch{need(false,'IDENTITY_DATABASE_CA_INVALID');}
 need(certificate.ca===true,'IDENTITY_DATABASE_CA_INVALID');
 return pem;
}

export function validateState(rows,manifest){
 need(Array.isArray(rows)&&[12,14].includes(rows.length),'IDENTITY_MIGRATION_BASELINE_REQUIRED');
 const names=Object.keys(manifest).sort();
 const actual=new Map(rows.map(r=>[r.name,r.checksum]));
 need(actual.size===rows.length&&rows.every(r=>exact(r,['name','checksum'])),'IDENTITY_MIGRATION_ROWS_INVALID');
 need(names.slice(0,rows.length).every(n=>actual.get(n)===manifest[n]),'IDENTITY_MIGRATION_CHECKSUM_CHANGED');
 return rows.length;
}

/** The I/O implementation must own one transaction; every error rolls it back. */
export async function migrate(request,io){
 validateRequest(request);
 try{
  await io.begin(request.action==='inspect');
  await io.lock();
  need(await io.identity(request.database),'IDENTITY_DATABASE_IDENTITY_CHANGED');
  const files=await io.files();
  need(exact(files,Object.keys(request.migrations))&&Object.entries(files).every(([n,sql])=>typeof sql==='string'&&digest(sql)===request.migrations[n]),'IDENTITY_MIGRATION_IMAGE_CHANGED');
  const count=validateState(await io.rows(),request.migrations);
  const before=await io.preservation();
  let applied=0;
  if(request.action==='apply'){
   for(const [name,checksum] of Object.entries(additions)){
    if(count===14)break;
    await io.apply(name,files[name],checksum);applied++;
   }
   await io.grants(request.database.application_role);
   need(validateState(await io.rows(),request.migrations)===14,'IDENTITY_MIGRATION_READBACK_FAILED');
   need(await io.preservation()===before,'IDENTITY_EXISTING_ACCOUNTS_CHANGED');
  }
  await io.commit();
  if(request.action==='apply')need(await io.runtimeReady(),'IDENTITY_APPLICATION_GRANTS_UNQUALIFIED');
  return {state:request.action==='apply'?'IDENTITY_SCHEMA_014_APPLIED_NOT_AUTHORIZATION':'IDENTITY_SCHEMA_INSPECTED_NOT_AUTHORIZATION',
   environment:request.environment,operation_id:request.operation_id,source_commit:request.source_commit,
   applied_migrations:applied,schema_version:request.action==='apply'?14:count,
   existing_accounts_preserved:true,credential_changes:0,down_migrations:0};
 }catch(error){await io.rollback().catch(()=>{});throw error;}finally{await io.close();}
}

export async function live(request){
 validateRequest(request);
 // Keep the application TLS trust policy even though readiness is side-effect-free.
 const {permittedCertificateRoots}=await import('/app/dist/src/security/tls-trust.js');
 if(request.database_ca_pem)need(permittedCertificateRoots([request.database_ca_pem]).length===1,'IDENTITY_DATABASE_CA_BLOCKED');
 const {default:pg}=await import('/app/node_modules/pg/lib/index.js');
 const {applicationRoleSafe}=await import('/app/dist/src/services/database-role.js');
 const {databaseReady}=await import('/app/dist/src/services/database-readiness.js');
 const connect=async(uri,owner)=>{
  const u=connectionScope(uri,request.database,owner);
  for(const key of [...u.searchParams.keys()])u.searchParams.delete(key);
  const c=new pg.Client({connectionString:u.href,ssl:{rejectUnauthorized:true,servername:request.database.host,...(request.database_ca_pem?{ca:request.database_ca_pem}:{})},enableChannelBinding:true,connectionTimeoutMillis:10000,statement_timeout:45000,query_timeout:50000});
  await c.connect();need(c.connection.stream.encrypted===true&&c.connection.stream.authorized===true);return c;
 };
 let client,runtime,active=false;
 return migrate(request,{
  async begin(readonly){client=await connect(request.owner_uri,true);await client.query(readonly?'BEGIN READ ONLY':'BEGIN');active=true;await client.query("SET LOCAL lock_timeout='5s'");},
  async lock(){await client.query('SELECT pg_advisory_xact_lock(757830)');},
  async identity(target){const row=(await client.query('SELECT current_user AS role,current_database() AS database')).rows[0];return row.role===target.owner_role&&row.database===target.database;},
  async files(){const result={};for(const name of (await readdir('/app/migrations')).filter(n=>n.endsWith('.sql')).sort())result[name]=await readFile('/app/migrations/'+name,'utf8');return result;},
  async rows(){return (await client.query('SELECT name,checksum FROM public.schema_migrations ORDER BY name')).rows;},
  async preservation(){
   // Existing credential/role identities are compared inside the transaction;
   // only a digest remains in memory and no data rows enter a receipt.
   if(request.action==='apply')await client.query('LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE');
   return (await client.query("SELECT md5(coalesce(string_agg(row(id,email,password_hash,mfa_secret,role,disabled)::text,E'\\n' ORDER BY id),'')) AS fingerprint FROM public.users")).rows[0].fingerprint;
  },
  async apply(name,sql,checksum){await client.query(sql);await client.query('INSERT INTO public.schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);},
  async grants(role){
   const state=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows;
   need(state.length===1&&Object.values(state[0]).every(v=>v===false),'IDENTITY_EXISTING_APPLICATION_ROLE_REQUIRED');
   const quoted='"'+role+'"';
   for(const name of ['identity_profiles','identity_sessions','identity_records','identity_product_access','identity_drone_memberships','identity_registration_links','identity_grant_sessions'])await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${name} TO ${quoted}`);
  },
  async commit(){await client.query('COMMIT');active=false;},
  async rollback(){if(active)await client.query('ROLLBACK');active=false;},
  async runtimeReady(){runtime=await connect(request.runtime_uri,false);await runtime.query('BEGIN READ ONLY');try{await databaseReady(runtime,true);return await applicationRoleSafe(runtime);}finally{await runtime.query('ROLLBACK');}},
  async close(){await runtime?.end();await client?.end();},
 });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const parts=[];let bytes=0;for await(const part of process.stdin){bytes+=part.length;need(bytes<=131072);parts.push(part);}console.log(JSON.stringify(await live(JSON.parse(Buffer.concat(parts).toString('utf8')))));}
 catch{console.log(JSON.stringify({state:'IDENTITY_MIGRATION_REFUSED_INSPECT_WITHOUT_RETRY'}));process.exitCode=1;}
}
