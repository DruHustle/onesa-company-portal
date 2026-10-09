import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {provisionApplicationRole,applicationRoleSafe} from '../src/services/database-role.js';

test('Production role has CRUD access without database administration or migration writes',async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('An isolated TEST_DATABASE_URL ending _test is required');
 process.env.DATABASE_URL=url;process.env.NODE_ENV='test';process.env.SESSION_KEY='database-role-test-placeholder-key-123456789';
 const {migrate}=await import('../src/services/migrate.js');
 const {db}=await import('../src/services/db.js');
 const password='database-role-test-only-password-1234567890';
 const appUrl=new URL(url);appUrl.username='onesa_portal_app_test';appUrl.password=password;
 const app=new pg.Pool({connectionString:appUrl.toString()});
 try {
  await migrate();
  assert.equal(await applicationRoleSafe(db),false);
  await provisionApplicationRole(db,password,'onesa_portal_app_test');
  await provisionApplicationRole(db,password,'onesa_portal_app_test');
  assert.equal(await applicationRoleSafe(app),true);
  await app.query('SELECT count(*) FROM users');
  await app.query('SELECT count(*) FROM schema_migrations');
  await assert.rejects(app.query('CREATE TABLE forbidden_test_table(id integer)'),{code:'42501'});
  await assert.rejects(app.query("INSERT INTO schema_migrations(name,checksum) VALUES('forbidden','fixture')"),{code:'42501'});
  await assert.rejects(provisionApplicationRole(db,password,'portal_test'),/elevated privileges/);
 } finally {await app.end();await db.end();}
});
