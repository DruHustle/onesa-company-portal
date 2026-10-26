import './local-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
if(!process.env.TEST_DATABASE_URL)throw new Error('Isolated TEST_DATABASE_URL required');
process.env.WORKER_PROFILE='staging';
process.env.WORKER_IDLE_MAX_MS='600000';
process.env.SESSION_KEY='isolated-worker-test-key-not-for-runtime-123456';
process.env.SMTP_HOST='';process.env.CLAMAV_HOST='';process.env.PUBLISH_ENABLED='false';
const {db}=await import('../src/services/db.js');
const {migrate}=await import('../src/services/migrate.js');
const {tick}=await import('../src/jobs/worker.js');
const {env}=await import('../src/config/env.js');

test('Staging idle detection retains disabled mail, processes reminders and recovers exhausted work',async()=>{
 await migrate();
 const environment=env.NODE_ENV;
 try{env.NODE_ENV='production';await assert.rejects(tick,/Worker database role is not production safe/);}
 finally{env.NODE_ENV=environment;}
 await db.query('TRUNCATE jobs,storage_deletions,enquiries,files,content CASCADE');
 const pending=randomUUID(),exhausted=randomUUID(),reminder=randomUUID();
 try{
  assert.equal(await tick(),false);
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1::uuid,'email',($1::uuid)::text,'{}')",[pending]);
  assert.equal(await tick(),false,'Disabled or unaddressed mail is retained without keeping compute awake');
  assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[pending])).rows[0].status,'pending');
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1::uuid,'reminder',($1::uuid)::text,'{}')",[reminder]);
  await tick();
  assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[reminder])).rows[0].status,'accepted');
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,status,attempts,locked_at) VALUES($1::uuid,'email',($1::uuid)::text,'{}','running',5,now()-interval '6 minutes')",[exhausted]);
  await tick();
  assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[exhausted])).rows[0].status,'failed');
  // Pending retries retain the five-second path, without touching external storage.
  await db.query("INSERT INTO storage_deletions(storage_key,status,run_at) VALUES($1,'pending',now()+interval '1 minute')",[randomUUID()]);
  assert.equal(await tick(),true);
 }finally{await db.query('TRUNCATE jobs,storage_deletions CASCADE');await db.end();}
});
