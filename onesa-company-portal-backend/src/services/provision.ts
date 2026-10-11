import pg from 'pg';
import { provisionApplicationRole,applicationRoleStatus } from './database-role.js';
import { provisionTarget } from './provision-target.js';

// Operator-only command: identify the Portal database before importing any runtime configuration.
const raw=process.env.DATABASE_URL;
const expectedHost=process.env.PORTAL_EXPECTED_DB_HOST;
const expectedDatabase=process.env.PORTAL_EXPECTED_DB_NAME;
if(!raw||!expectedHost||!expectedDatabase)throw new Error('Supply DATABASE_URL, PORTAL_EXPECTED_DB_HOST and PORTAL_EXPECTED_DB_NAME privately');
provisionTarget(raw,expectedHost,expectedDatabase);
const apply=process.argv.includes('--apply');
const password=process.env.PORTAL_APP_DB_PASSWORD;
if(apply&&!password)throw new Error('PORTAL_APP_DB_PASSWORD must be supplied privately');
const db=new pg.Pool({connectionString:raw,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,enableChannelBinding:true});
try {
 if(apply) {
  const client=await db.connect();
  try {
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock(757831)');
   await provisionApplicationRole(client,password!);
   await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  console.log('Restricted application role provisioned; existing passwords are not changed. Verify its connection before switching API/worker DATABASE_URL.');
 } else {
  const tls=await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  console.log(JSON.stringify({readOnly:true,identityMatches:true,role:await applicationRoleStatus(db),tls:tls.rows[0]?.ssl===true}));
 }
} catch {console.error('Portal database role operation failed; inspect privately. No credentials emitted.');process.exitCode=1;}
finally {await db.end();}
