/** Temporary synthetic staging identities; no existing account or schema changes. */
import { randomBytes, randomUUID } from 'node:crypto';
import {base32} from './base32.js';
import pg from 'pg';
import type { TLSSocket } from 'node:tls';
import { applicationRoleStatus } from '../services/database-role.js';
import { assertConfirmedClientTLS, verifiedSchema } from '../services/render-role-repair.js';

export type FixtureAccount={id:string;email:string;password:string;totp_secret:string};
type Connection=Pick<pg.PoolClient,'query'>;

export function stagingDatabaseURL(raw:string) {
 const value=new URL(raw);
 if(!['postgres:','postgresql:'].includes(value.protocol)||value.hostname!=='ep-autumn-glade-b9760olg-pooler.c-7.eu-central-1.aws.neon.tech'||decodeURIComponent(value.username)!=='onesa_portal_app'||value.pathname!=='/neondb'||!value.password||value.hash||value.port&&value.port!=='5432')throw new Error('STAGING_FIXTURE_DATABASE');
 if(!['require','verify-full'].includes(value.searchParams.get('sslmode')||'')||value.searchParams.getAll('sslmode').length!==1)throw new Error('STAGING_FIXTURE_TLS');
 value.searchParams.set('sslmode','verify-full');
 return value;
}

export async function createFixtureAccounts(client:Connection,run:string,encode:{password:(value:string)=>string;secret:(value:string)=>string}) {
 if(!/^\d{1,20}$/.test(run))throw new Error('STAGING_FIXTURE_RUN');
 const accounts:FixtureAccount[]=[];
 for(const role of ['administrator','viewer']) {
  const id=randomUUID(),password=randomBytes(32).toString('base64url'),secret=base32(randomBytes(20));
  const email=`release-audit-${run}-${randomBytes(12).toString('hex')}@example.com`;
  await client.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[id,email,encode.password(password),role,encode.secret(secret)]);
  accounts.push({id,email,password,totp_secret:secret});
 }
 return accounts;
}

export async function revokeFixtureAccounts(client:Connection,run:string,accounts:FixtureAccount[]) {
 if(!/^\d{1,20}$/.test(run)||accounts.length!==2||accounts.some(account=>!new RegExp(`^release-audit-${run}-[a-f0-9]{24}@example\\.com$`).test(account.email)||!/^[a-f0-9-]{36}$/.test(account.id)))throw new Error('STAGING_FIXTURE_OWNERSHIP');
 for(const account of accounts) {
  const row=await client.query('UPDATE users SET disabled=true WHERE id=$1 AND email=$2 RETURNING id',[account.id,account.email]);
  if(row.rowCount!==1)throw new Error('STAGING_FIXTURE_OWNERSHIP');
  await client.query('DELETE FROM sessions WHERE user_id=$1',[account.id]);
 }
}

async function main() {
 if(process.env.GITHUB_REPOSITORY!=='DruHustle/onesa-company-portal'||process.env.GITHUB_REF!=='refs/heads/staging'||process.env.GITHUB_ACTOR!=='DruHustle'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('STAGING_FIXTURE_CONTEXT');
 const action=process.argv[2];
 if(!['create','cleanup'].includes(action))throw new Error('STAGING_FIXTURE_ACTION');
 let inputText='';
 for await(const chunk of process.stdin){inputText+=chunk.toString('utf8');if(Buffer.byteLength(inputText)>16384)throw new Error('STAGING_FIXTURE_INPUT');}
 const input=JSON.parse(inputText);
 if(input.scope!=='approved-synthetic-staging'||input.candidate_commit!==process.env.GITHUB_SHA||input.run_id!==process.env.GITHUB_RUN_ID)throw new Error('STAGING_FIXTURE_CONTEXT');
 const url=stagingDatabaseURL(process.env.DATABASE_URL||'');
 const pool=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000,statement_timeout:10000,enableChannelBinding:true});
 try {
  const client=await pool.connect();
  try {
   assertConfirmedClientTLS(client.connection.stream as Partial<TLSSocket>);
   await client.query('BEGIN TRANSACTION READ ONLY');
   const identity=await client.query('SELECT current_database() AS database,current_user AS role');
   if(identity.rows[0]?.database!=='neondb'||identity.rows[0]?.role!=='onesa_portal_app'||!(await applicationRoleStatus(client)).safe)throw new Error('STAGING_FIXTURE_ROLE');
   await verifiedSchema(client);await client.query('ROLLBACK');
   await client.query('BEGIN');
   if(action==='create') {
    const {passwordHash,encrypt}=await import('./crypto.js');
    const accounts=await createFixtureAccounts(client,input.run_id,{password:passwordHash,secret:encrypt});
    await client.query('COMMIT');
    // Private pipe to the caller, never inherited console output or an uploaded artifact.
    process.stdout.write(JSON.stringify(accounts));
   } else {
    await revokeFixtureAccounts(client,input.run_id,input.users);await client.query('COMMIT');
    process.stdout.write('{}');
   }
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 } finally {await pool.end();}
}

if(process.argv[1]?.endsWith('staging-fixtures.ts')) {
 main().catch(()=>{process.stderr.write('STAGING_FIXTURE_OPERATION_FAILED\n');process.exitCode=1;});
}
