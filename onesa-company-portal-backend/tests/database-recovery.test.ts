import './local-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
if(!process.env.TEST_DATABASE_URL)throw new Error('Isolated TEST_DATABASE_URL required');
process.env.SESSION_KEY='isolated-database-recovery-key-not-for-runtime-123456';
const {db}=await import('../src/services/db.js');

test('An idle PostgreSQL disconnect is handled and the next operation reconnects', {timeout:10000},async()=>{
 const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
 try{
  const original=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const disconnected=new Promise<void>(resolve=>db.once('error',()=>resolve()));
  const result=await control.query('SELECT pg_terminate_backend($1) AS terminated',[original]);
  assert.equal(result.rows[0].terminated,true);
  await disconnected;
  const recovered=(await db.query('SELECT pg_backend_pid() AS pid,1 AS ready')).rows[0];
  assert.equal(recovered.ready,1);
  assert.notEqual(recovered.pid,original);
 }finally{await control.end();await db.end();}
});
