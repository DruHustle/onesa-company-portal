import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { BillingError, ensure } from './domain.js';

export async function verifyMigration(connection: Pick<pg.Pool, 'query'>): Promise<void> {
  const sql = await readFile(new URL('../migrations/001_company_billing.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const rows = (await connection.query('SELECT version,checksum FROM billing.schema_migrations ORDER BY version')).rows;
  ensure(rows.length === 1 && rows[0].version === '001_company_billing' && rows[0].checksum === checksum,
    'MIGRATION_CHECKSUM_MISMATCH', 503);
}

export async function migrate(connectionString: string): Promise<'applied' | 'current'> {
  ensure(/^postgres(?:ql)?:\/\//.test(connectionString), 'MIGRATION_DATABASE_REQUIRED', 503);
  const sql = await readFile(new URL('../migrations/001_company_billing.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, application_name: 'onesa-billing-migration' });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('onesa-billing-migration',0))");
    const exists = (await client.query("SELECT to_regclass('billing.schema_migrations') AS relation")).rows[0].relation;
    if (exists) {
      const rows = (await client.query('SELECT version,checksum FROM billing.schema_migrations ORDER BY version')).rows;
      ensure(rows.length === 1 && rows[0].version === '001_company_billing', 'MIGRATION_HISTORY_MISMATCH', 409);
      ensure(rows[0].checksum === checksum, 'MIGRATION_CHECKSUM_MISMATCH', 409);
      return 'current';
    }
    const other = (await client.query("SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows[0].count;
    ensure(other === 0, 'DEDICATED_BILLING_DATABASE_REQUIRED', 409);
    await client.query("SELECT set_config('onesa_billing.migration_checksum',$1,false)", [checksum]);
    await client.query(sql);
    return 'applied';
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('onesa-billing-migration',0))").catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensure(!(process.env.BILLING_MIGRATION_DATABASE_URL && process.env.BILLING_MIGRATION_DATABASE_URL_FILE), 'MIGRATION_AMBIGUOUS_CREDENTIAL', 503);
    const connection = process.env.BILLING_MIGRATION_DATABASE_URL_FILE
      ? (await readFile(process.env.BILLING_MIGRATION_DATABASE_URL_FILE, 'utf8')).trim() : process.env.BILLING_MIGRATION_DATABASE_URL;
    ensure(connection, 'MIGRATION_DATABASE_REQUIRED', 503);
    process.stdout.write(`BILLING_MIGRATION_${(await migrate(connection)).toUpperCase()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof BillingError ? error.code : 'BILLING_MIGRATION_FAILED'}\n`);
    process.exitCode = 1;
  }
}
