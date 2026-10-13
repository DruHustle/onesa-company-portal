import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { initializeEmptyPortalSchema, verifiedSchema } from '../src/services/render-role-repair.js';
import { applicationRoleStatus } from '../src/services/database-role.js';

test('Empty Portal initialization is atomic, preserves existing objects and creates a restricted login',async()=>{
 const raw=process.env.TEST_DATABASE_URL;
 if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('An isolated TEST_DATABASE_URL ending _test is required');
 const base=new URL(raw),suffix=randomBytes(8).toString('hex');
 const name='onesa_portal_initialization_'+suffix+'_test',role='onesa_portal_init_'+suffix;
 const password=randomBytes(48).toString('base64url');
 const admin=new pg.Pool({connectionString:base.toString(),max:1});
 let created=false;
 base.pathname='/'+name;
 const owner=new pg.Pool({connectionString:base.toString(),max:1});
 const runtime=new URL(base.toString());runtime.username=role;runtime.password=password;
 const application=new pg.Pool({connectionString:runtime.toString(),max:1});
 try {
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const client=await owner.connect();
  try {
   await assert.rejects(initializeEmptyPortalSchema(client,'short',role),/dedicated generated application password/);
   await client.query('BEGIN');
   assert.equal(await initializeEmptyPortalSchema(client,password,role),7);
   await client.query('ROLLBACK');
   assert.equal((await client.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0');
   assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0);

   await client.query('BEGIN');
   assert.equal(await initializeEmptyPortalSchema(client,password,role),7);
   await client.query('COMMIT');
   assert.equal(await verifiedSchema(application),7);
   assert.deepEqual(await applicationRoleStatus(application),{safe:true,reasons:[]});
   assert.equal((await application.query('SELECT count(*) FROM users')).rows[0].count,'0');
   await application.query('BEGIN');
   await application.query("INSERT INTO audit(action) VALUES('synthetic-initialization-test')");
   await application.query('ROLLBACK');
   await assert.rejects(application.query('CREATE TABLE forbidden(id int)'),{code:'42501'});
   await assert.rejects(application.query("UPDATE schema_migrations SET checksum='changed'"),{code:'42501'});
   await client.query('BEGIN');
   await assert.rejects(initializeEmptyPortalSchema(client,password,role),/schema is not empty/);
   await client.query('ROLLBACK');
   assert.equal(await verifiedSchema(application),7);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 } finally {
  await application.end();await owner.end();
  // These uniquely named synthetic resources are owned by this test, never an application database.
  if(created){await admin.query(`DROP DATABASE "${name}"`);await admin.query(`DROP ROLE IF EXISTS "${role}"`);}
  await admin.end();
 }
});
