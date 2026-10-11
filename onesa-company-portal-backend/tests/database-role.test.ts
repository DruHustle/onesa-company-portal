import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFileSync} from 'node:child_process';
import {provisionApplicationRole,applicationRoleSafe} from '../src/services/database-role.js';

test('Production role has CRUD access without database administration or migration writes',async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('An isolated TEST_DATABASE_URL ending _test is required');
 process.env.DATABASE_URL=url;process.env.NODE_ENV='test';process.env.SESSION_KEY='database-role-test-placeholder-key-123456789';
 const {migrate}=await import('../src/services/migrate.js');
 const {db}=await import('../src/services/db.js');
 const {databaseReady}=await import('../src/services/database-readiness.js');
 const password='database-role-test-only-password-1234567890';
 const appUrl=new URL(url);appUrl.username='onesa_portal_app_test';appUrl.password=password;
 const app=new pg.Pool({connectionString:appUrl.toString()});
 try {
  await migrate();
  assert.equal(await applicationRoleSafe(db),false);
  await assert.rejects(databaseReady(db,true),{code:'DATABASE_ROLE'});
  await provisionApplicationRole(db,password,'onesa_portal_app_test');
  await provisionApplicationRole(db,password,'onesa_portal_app_test');
  assert.equal(await applicationRoleSafe(app),true);
  await databaseReady(app,true);
  await app.query('SELECT count(*) FROM users');
  await app.query('SELECT count(*) FROM schema_migrations');
  await assert.rejects(app.query('CREATE TABLE forbidden_test_table(id integer)'),{code:'42501'});
  await assert.rejects(app.query("INSERT INTO schema_migrations(name,checksum) VALUES('forbidden','fixture')"),{code:'42501'});
  await app.query('BEGIN');
  await app.query("INSERT INTO audit(action) VALUES('restricted-role-regression')");
  await app.query('ROLLBACK');
  await db.query('REVOKE USAGE ON SEQUENCE audit_id_seq FROM onesa_portal_app_test');
  await assert.rejects(databaseReady(app,true),{code:'DATABASE_PERMISSIONS'});
  await db.query('GRANT USAGE ON SEQUENCE audit_id_seq TO onesa_portal_app_test');
  await db.query('REVOKE INSERT ON audit FROM onesa_portal_app_test');
  await assert.rejects(databaseReady(app,true),{code:'DATABASE_PERMISSIONS'});
  await db.query('GRANT INSERT ON audit TO onesa_portal_app_test');
  await db.query("UPDATE schema_migrations SET checksum='invalid' WHERE name='007_operational_state.sql'");
  await assert.rejects(databaseReady(app,true),{code:'DATABASE_SCHEMA'});
  const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
  await db.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2',[createHash('sha256').update(await readFile('migrations/007_operational_state.sql')).digest('hex'),'007_operational_state.sql']);
  await databaseReady(app,true);
  const probe=`import assert from 'node:assert/strict';import {buildApp} from './src/app.ts';import {db} from './src/services/db.ts';const app=await buildApp({logging:false});try{assert.equal((await app.inject({url:'/api/v1/health'})).statusCode,200);const ready=await app.inject({url:'/api/v1/ready'});assert.equal(ready.statusCode,Number(process.env.EXPECT_READY),ready.body);assert.equal((await app.inject({url:'/api/v1/auth/me'})).statusCode,401);}finally{await app.close();await db.end();}`;
  for(const [connection,expected] of [[url,503],[appUrl.toString(),200]] as const)execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',probe],{env:{...process.env,DATABASE_URL:connection,NODE_ENV:'production',PUBLIC_ORIGIN:'https://portal.example.invalid',SESSION_KEY:'x'.repeat(64),PROXY_SHARED_KEY:'x'.repeat(64),EXPECT_READY:String(expected)},stdio:'pipe'});
  const unavailable=new pg.Pool({connectionString:'postgresql://fixture:fixture@127.0.0.1:1/onesa_portal_test',connectionTimeoutMillis:200});
  try{await assert.rejects(databaseReady(unavailable,true),{code:'DATABASE_CONNECTION'});}finally{await unavailable.end();}
  const owner=(await db.query('SELECT current_user AS name')).rows[0].name;
  await assert.rejects(provisionApplicationRole(db,password,owner),/elevated privileges/);
  await db.query('GRANT UPDATE ON schema_migrations TO onesa_portal_app_test');
  assert.equal(await applicationRoleSafe(app),false);
  await db.query('REVOKE UPDATE ON schema_migrations FROM onesa_portal_app_test');
  assert.equal(await applicationRoleSafe(app),true);
 } finally {await app.end();await db.end();}
});
