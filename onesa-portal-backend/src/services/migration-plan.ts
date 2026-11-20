import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Caller owns the transaction. This module never loads application environments. */
export async function applyMigrationPlan(connection:Pick<Pool | PoolClient,'query'>) {
 await connection.query('SELECT pg_advisory_xact_lock(757830)');
 await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())');
 let applied=0;
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()) {
  const sql=await readFile('migrations/'+name,'utf8');
  const checksum=createHash('sha256').update(sql).digest('hex');
  const old=await connection.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
  if(old.rowCount) {
   if(old.rows[0].checksum!==checksum)throw new Error('Migration checksum changed: '+name);
   continue;
  }
  await connection.query(sql);
  await connection.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
  applied++;
 }
 return applied;
}
