import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {claimMailJob} from '../src/services/mail-claim.js';

test('actual PostgreSQL claims freeze presentation across retries, interruption and competing workers',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Mail claim tests require the guarded disposable PostgreSQL database');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3,connectionTimeoutMillis:5000,statement_timeout:5000});
 const schema='mail_claim_'+randomUUID().replaceAll('-','');
 const first=await pool.connect(),second=await pool.connect();
 try{
  await first.query(`CREATE SCHEMA ${schema}`);
  await first.query(`SET search_path TO ${schema}`);await second.query(`SET search_path TO ${schema}`);
  await first.query(`CREATE TABLE jobs(id uuid PRIMARY KEY,kind text NOT NULL DEFAULT 'email',status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,run_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),last_error text)`);
  const payload={to:'synthetic@example.invalid',subject:'Your Onesa sign-in link',encryptedText:'synthetic-encrypted-placeholder'};
  const insert=async(attempts=0)=>{const id=randomUUID();await first.query('INSERT INTO jobs(id,attempts,payload) VALUES($1,$2,$3)',[id,attempts,payload]);return id;};
  const fresh=await insert();
  await first.query('BEGIN');const claimed=await claimMailJob(first);
  assert.equal(claimed.id,fresh);assert.equal(claimed.attempts,1);assert.equal(claimed.payload.mailPresentation,'branded-v1');
  // A simultaneous worker sees the real held lock and cannot claim the same job.
  await second.query('BEGIN');assert.equal(await claimMailJob(second),undefined);await second.query('COMMIT');
  await first.query('COMMIT');
  assert.deepEqual(claimed.payload,{...payload,mailPresentation:'branded-v1'});
  // Simulate recovery after a committed claim and process interruption. Only the
  // named synthetic job is requeued; the durable version must survive a new client.
  await first.query("UPDATE jobs SET status='pending',locked_at=NULL WHERE id=$1",[fresh]);
  const restarted=await pool.connect();
  try{await restarted.query(`SET search_path TO ${schema}`);const retry=await claimMailJob(restarted);assert.equal(retry.id,fresh);assert.equal(retry.attempts,2);assert.equal(retry.payload.mailPresentation,'branded-v1');}finally{restarted.release();}
  await first.query('TRUNCATE jobs');const legacy=await insert(1);const old=await claimMailJob(first);
  assert.equal(old.id,legacy);assert.equal(old.attempts,2);assert.equal(old.payload.mailPresentation,undefined);assert.deepEqual(old.payload,payload);
  await first.query('TRUNCATE jobs');const interrupted=await insert();await first.query('BEGIN');assert.equal((await claimMailJob(first)).payload.mailPresentation,'branded-v1');await first.query('ROLLBACK');
  const recovered=await claimMailJob(second);assert.equal(recovered.id,interrupted);assert.equal(recovered.attempts,1);assert.equal(recovered.payload.mailPresentation,'branded-v1');
  await first.query('TRUNCATE jobs');await insert(5);assert.equal(await claimMailJob(first),undefined);
  // A committed attempt may already have been accepted externally. A worker
  // restart after the provider's 24-hour deduplication window cannot resend it.
  await first.query('TRUNCATE jobs');const expired=await insert(1);
  await first.query("UPDATE jobs SET created_at=now()-interval '25 hours' WHERE id=$1",[expired]);
  assert.equal(await claimMailJob(first),undefined,'Expired retries must require reconciliation');
  const held=(await first.query('SELECT * FROM jobs WHERE id=$1',[expired])).rows[0];
  assert.equal(held.status,'failed');assert.equal(held.attempts,1);assert.deepEqual(held.payload,payload);
  assert.match(held.last_error,/reconcile provider acceptance/);
  const unsent=await insert();
  await first.query("UPDATE jobs SET created_at=now()-interval '2 days' WHERE id=$1",[unsent]);
  assert.equal((await claimMailJob(first)).id,unsent,'Old queued jobs with no attempt may still send once');
  await first.query('TRUNCATE jobs');const recent=await insert(1);
  await first.query("UPDATE jobs SET created_at=now()-interval '22 hours' WHERE id=$1",[recent]);
  assert.equal((await claimMailJob(first)).id,recent,'Retries remain available within the conservative window');
  await first.query('TRUNCATE jobs');const future=await insert(1);
  await first.query("UPDATE jobs SET created_at=now()+interval '1 hour' WHERE id=$1",[future]);
  assert.equal(await claimMailJob(first),undefined,'Clock rollback cannot extend retry safety');
  assert.equal((await first.query('SELECT status FROM jobs WHERE id=$1',[future])).rows[0].status,'failed');
  await first.query('TRUNCATE jobs');const lockedExpired=await insert(1),independent=await insert();
  await first.query("UPDATE jobs SET created_at=now()-interval '25 hours' WHERE id=$1",[lockedExpired]);
  await first.query('BEGIN');await first.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[lockedExpired]);
  assert.equal((await claimMailJob(second)).id,independent,'Reconciliation locks cannot stall an independent queued message');
  await first.query('COMMIT');assert.equal(await claimMailJob(second),undefined);
  assert.equal((await first.query('SELECT status FROM jobs WHERE id=$1',[lockedExpired])).rows[0].status,'failed');
 }finally{
  await first.query('ROLLBACK');await second.query('ROLLBACK');
  await first.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  first.release();second.release();await pool.end();
 }
});
