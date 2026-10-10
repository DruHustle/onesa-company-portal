import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { applicationRoleSafe } from './database-role.js';
import { HttpError } from './workflows.js';

type Connection = Pick<Pool | PoolClient, 'query'>;
export async function databaseReady(connection:Connection, production:boolean) {
 try {await connection.query('SELECT 1');}
 catch {throw new HttpError(503,'DATABASE_CONNECTION','Database unavailable');}
 try {
  if(production&&!await applicationRoleSafe(connection))throw new HttpError(503,'DATABASE_ROLE','Database role is not production safe');
  const applied=await connection.query('SELECT name,checksum FROM public.schema_migrations');
  const checksums=new Map(applied.rows.map(row=>[row.name,row.checksum]));
  for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql'))) {
   const checksum=createHash('sha256').update(await readFile(`migrations/${name}`)).digest('hex');
   if(checksums.get(name)!==checksum)throw new HttpError(503,'DATABASE_SCHEMA','Database migrations do not match this application');
  }
  const permissions=await connection.query("SELECT bool_and(has_table_privilege(current_user, c.oid, 'SELECT') AND has_table_privilege(current_user, c.oid, 'INSERT') AND has_table_privilege(current_user, c.oid, 'UPDATE') AND has_table_privilege(current_user, c.oid, 'DELETE')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations'");
  const sequences=await connection.query("SELECT bool_and(has_sequence_privilege(current_user,c.oid,'USAGE') AND has_sequence_privilege(current_user,c.oid,'SELECT')) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'");
  if(sequences.rows[0]?.allowed===false)throw new HttpError(503,'DATABASE_PERMISSIONS','Application sequence privileges are incomplete');
  if(permissions.rows[0]?.allowed!==true)throw new HttpError(503,'DATABASE_PERMISSIONS','Application table privileges are incomplete');
 } catch(error) {
  if(error instanceof HttpError)throw error;
  throw new HttpError(503,'DATABASE_SCHEMA','Database schema or privileges unavailable');
 }
}
