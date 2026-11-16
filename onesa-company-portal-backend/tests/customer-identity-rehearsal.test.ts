import './local-environment.js';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {test} from 'node:test';
import pg from 'pg';
import {localConnection, rehearse} from '../src/services/rehearse-customer-identity.js';

test('rehearsal accepts only explicit local test databases', () => {
  const url = 'postgresql://example:unused@127.0.0.1:5432/portal_test';
  assert.equal(localConnection(url).database, 'portal_test');
  for (const invalid of [
    url.replace('127.0.0.1', 'db.example.invalid'), url.replace('portal_test', 'portal'),
    url + '?host=elsewhere', url.replace('postgresql:', 'https:'), url.replace('example:unused@', ''),
  ]) assert.throws(() => localConnection(invalid));
});

test('real upgrades from 016–019 and the 020 no-op restore their grants and schema baseline', async () => {
  const source = process.env.TEST_DATABASE_URL;
  assert.ok(source);
  const config = localConnection(source);
  const database = 'identity_' + randomUUID().replaceAll('-', '') + '_test';
  const admin = new pg.Client(config);
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE ' + database);
    try {
      const copy = new pg.Client({...config, database});
      await copy.connect();
      try {
        const uri = new URL(source);
        uri.pathname = '/' + database;
        const names = (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort();
        async function apply(name: string) {
          const sql = await readFile('migrations/' + name, 'utf8');
          await copy.query(sql);
          await copy.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
            [name, createHash('sha256').update(sql).digest('hex')]);
        }
        await copy.query('BEGIN');
        await copy.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())');
        for (const name of names.slice(0, 16)) await apply(name);
        const user = randomUUID();
        await copy.query("INSERT INTO users(id,email,password_hash,role,disabled) VALUES($1,$2,'disabled-test-fixture','viewer',true)", [user, user + '@example.invalid']);
        await copy.query("INSERT INTO identity_product_access(user_id,product,role,status,revision) VALUES($1,'ai','user','active',4),($1,'mobile','customer','revoked',7)", [user]);
        await copy.query('COMMIT');
        for (const baseline of [16, 17, 18, 19, 20]) {
          assert.deepEqual(await rehearse(uri.href), {
            baseline, migrations_rehearsed: 20 - baseline, ordinary_roles: 8,
            restricted_admin_roles_denied: 4, grants_preserved: true, rollback_verified: true,
          });
          const grants = await copy.query('SELECT product,status,revision FROM identity_product_access ORDER BY product');
          assert.deepEqual(grants.rows, [
            {product: 'ai', status: 'active', revision: 4}, {product: 'mobile', status: 'revoked', revision: 7},
          ]);
          if (baseline < 20) {
            await copy.query('BEGIN');
            await apply(names[baseline]);
            await copy.query('COMMIT');
          }
        }
        await copy.query("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE name=$1", [names[18]]);
        await assert.rejects(rehearse(uri.href));
      } finally {
        await copy.end();
      }
    } finally {
      await admin.query('DROP DATABASE ' + database);
    }
  } finally {
    await admin.end();
  }
});
