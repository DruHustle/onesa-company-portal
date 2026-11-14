// Run the real migration plan on a local disposable restore and always roll it back.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {Socket} from 'node:net';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {applyMigrationPlan} from './migration-plan.js';

const reviewedInventory = 'bb1ada87c19d9521b873d610ed0e53a74c1d4fc701ac03f7cc00a2d5cc0a4d5f';
const ordinaryRoles = {
  ai: 'user', drone: 'viewer', robot: 'viewer', mobile: 'customer',
  farmer: 'user', logistics: 'user', pasofi: 'customer', factory: 'user',
};
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function localConnection(connectionString: string) {
  const url = new URL(connectionString);
  const database = url.pathname.slice(1);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname));
  assert.match(database, /^[a-z][a-z0-9_]*_test$/);
  assert.ok(url.username && !url.search && !url.hash);
  return {
    host: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    port: Number(url.port || 5432),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  };
}

async function reviewedMigrations() {
  const names = (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort();
  const rows = await Promise.all(names.map(async name => ({
    name, checksum: digest(await readFile('migrations/' + name)),
  })));
  assert.equal(digest(rows.map(row => row.checksum + '  ' + row.name + '\n').join('')), reviewedInventory);
  return rows;
}

async function storedMigrations(client: pg.Client) {
  return (await client.query('SELECT name,checksum FROM public.schema_migrations ORDER BY name')).rows;
}

async function checkRoles(client: pg.Client) {
  const user = randomUUID();
  await client.query("INSERT INTO public.users(id,email,password_hash,role,disabled) VALUES($1,$2,'unusable-rehearsal-fixture','viewer',true)",
    [user, user + '@example.invalid']);
  for (const [product, role] of Object.entries(ordinaryRoles)) {
    await client.query("INSERT INTO public.identity_product_access(user_id,product,role,status) VALUES($1,$2,$3,'active')",
      [user, product, role]);
  }
  for (const product of ['farmer', 'logistics', 'pasofi', 'factory']) {
    await client.query('SAVEPOINT forbidden_role');
    await assert.rejects(client.query("UPDATE public.identity_product_access SET role='admin' WHERE user_id=$1 AND product=$2",
      [user, product]), {code: '23514', constraint: 'identity_product_access_check'});
    await client.query('ROLLBACK TO SAVEPOINT forbidden_role');
    await client.query('RELEASE SAVEPOINT forbidden_role');
  }
}

export async function rehearse(connectionString: string) {
  const config = localConnection(connectionString);
  const inventory = await reviewedMigrations();
  // A loopback-published Docker database reports its container interface in SQL.
  // Verify the peer of the actual client connection, where local delivery occurs.
  const transport = new Socket();
  const client = new pg.Client({...config, stream: () => transport});
  await client.connect();
  try {
    assert.equal(transport.remoteAddress, config.host);
    await client.query('BEGIN');
    let before;
    try {
      const identity = (await client.query('SELECT current_database() AS database')).rows[0];
      assert.equal(identity.database, config.database);
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query('SET LOCAL search_path=public,pg_catalog');
      await client.query('SELECT pg_advisory_xact_lock(757830)');
      before = await storedMigrations(client);
      assert.ok([16, 17, 18, 19, 20].includes(before.length));
      assert.deepEqual(before, inventory.slice(0, before.length));
      await client.query('LOCK TABLE public.identity_product_access IN SHARE ROW EXCLUSIVE MODE');
      await client.query('CREATE TEMP TABLE retained_grants ON COMMIT DROP AS TABLE public.identity_product_access');
      const applied = await applyMigrationPlan(client);
      assert.equal(applied, inventory.length - before.length);
      assert.deepEqual(await storedMigrations(client), inventory);
      const differences = await client.query(`
        (TABLE pg_temp.retained_grants EXCEPT ALL TABLE public.identity_product_access)
        UNION ALL
        (TABLE public.identity_product_access EXCEPT ALL TABLE pg_temp.retained_grants) LIMIT 1`);
      assert.equal(differences.rowCount, 0);
      const bindingTable = await client.query("SELECT to_regclass('public.engineering_enrollment_accounts') IS NOT NULL AS present");
      assert.equal(bindingTable.rows[0].present, true);
      if (before.length < 19) {
        assert.equal((await client.query('SELECT 1 FROM public.engineering_enrollment_accounts LIMIT 1')).rowCount, 0);
      }
      const transactions = await client.query("SELECT to_regclass('public.portal_login_transactions') IS NOT NULL AS present");
      assert.equal(transactions.rows[0].present, true);
      assert.equal(await applyMigrationPlan(client), 0);
      await checkRoles(client);
    } finally {
      await client.query('ROLLBACK');
    }
    assert.deepEqual(await storedMigrations(client), before);
    const rolledBackBinding = await client.query("SELECT to_regclass('public.engineering_enrollment_accounts') IS NOT NULL AS present");
    assert.equal(rolledBackBinding.rows[0].present, before.length >= 19);
    const rollbackTransactions = await client.query("SELECT to_regclass('public.portal_login_transactions') IS NOT NULL AS present");
    assert.equal(rollbackTransactions.rows[0].present, before.length >= 20);
    return {baseline: before.length, migrations_rehearsed: inventory.length - before.length, ordinary_roles: 8,
      restricted_admin_roles_denied: 4, grants_preserved: true, rollback_verified: true};
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await rehearse(process.env.TEST_DATABASE_URL ?? '')));
  } catch {
    console.error('Customer identity rehearsal failed. Check the local test database and the reviewed schema inventory.');
    process.exitCode = 1;
  }
}
