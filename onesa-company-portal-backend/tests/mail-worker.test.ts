import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
if(!process.env.TEST_DATABASE_URL)throw Error('Guarded disposable PostgreSQL required');
process.env.MAIL_PROVIDER='resend';process.env.RESEND_API_KEY='synthetic-worker-key';
process.env.MAIL_FROM='Onesa <synthetic@example.invalid>';process.env.SESSION_KEY='isolated-worker-mail-key-not-for-runtime-123456';
process.env.CLAMAV_HOST='';process.env.PUBLISH_ENABLED='false';process.env.SMTP_HOST='';
const requests:RequestInit[]=[];
const originalFetch=globalThis.fetch;
let observeCommit:()=>Promise<void>=async()=>{};
globalThis.fetch=async(url,options)=>{
 assert.equal(url,'https://api.resend.com/emails');
 await observeCommit();
 requests.push(options!);
 if(requests.length===1)throw Error('Synthetic unknown outcome after provider acceptance');
 return Response.json({id:'a6a389c1-b2ea-42c6-a523-d54dd17a2785'});
};
const {db}=await import('../src/services/db.js');
const {migrate}=await import('../src/services/migrate.js');
const {encrypt}=await import('../src/auth/crypto.js');
const {tick}=await import('../src/jobs/worker.js');

test('actual worker commits custody before submission and replays a recovered Resend claim byte for byte',async()=>{
 try{
  await migrate();await db.query('TRUNCATE jobs,storage_deletions,enquiries,files,content CASCADE');
  const id=randomUUID();
  const payload={to:'recipient@example.invalid',subject:'Synthetic worker notice',encryptedText:encrypt('Synthetic private worker content')};
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1::uuid,'email',($1::uuid)::text,$2)",[id,payload]);
  // The provider callback sees the committed claim through an independent DB
  // query, proving no first external request precedes persistence.
  observeCommit=async()=>{const persisted=(await db.query('SELECT status,attempts,payload FROM jobs WHERE id=$1',[id])).rows[0];assert.equal(persisted.status,'running');assert.equal(persisted.attempts,requests.length+1);assert.equal(typeof persisted.payload.mailAttempt,'string');};
  await tick();assert.equal(requests.length,1);
  const first=(await db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  assert.equal(first.status,'pending');assert.equal(first.attempts,1);assert.equal(typeof first.payload.mailAttempt,'string');
  assert.ok(first.run_at.getTime()>Date.now(),'Existing exponential retry cooldown remains');
  assert.doesNotMatch(first.payload.mailAttempt,/Synthetic private worker content|synthetic-worker-key/);
  await tick();assert.equal(requests.length,1,'Cooldown prevents immediate resubmission');
  await db.query("UPDATE jobs SET status='running',locked_at=now()-interval '6 minutes',run_at=now() WHERE id=$1",[id]);
  await tick();assert.equal(requests.length,2);
  assert.equal(requests[0].body,requests[1].body);
  assert.equal(new Headers(requests[0].headers).get('Idempotency-Key'),new Headers(requests[1].headers).get('Idempotency-Key'));
  const recovered=(await db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  assert.equal(recovered.status,'accepted');assert.equal(recovered.attempts,2);assert.equal(recovered.payload.mailAttempt,first.payload.mailAttempt);
  const legacy=randomUUID();await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,attempts) VALUES($1::uuid,'email',($1::uuid)::text,$2,1)",[legacy,payload]);
  await tick();assert.equal(requests.length,2);assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[legacy])).rows[0].status,'failed');

 }finally{globalThis.fetch=originalFetch;await db.query('TRUNCATE jobs,storage_deletions CASCADE');await db.end();}
});
