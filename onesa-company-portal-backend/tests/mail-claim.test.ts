import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
process.env.SESSION_KEY='synthetic-mail-claim-key-not-for-runtime-123456';
const {claimMailJob}=await import('../src/services/mail-claim.js');
import {createMailer,type Mailer} from '../src/services/mail.js';
const {encrypt,decrypt}=await import('../src/auth/crypto.js');

const config={MAIL_PROVIDER:'resend' as const,RESEND_API_KEY:'synthetic-test-key',MAIL_FROM:'Onesa <sender@example.invalid>',SMTP_PORT:587,NODE_ENV:'test'};
test('real PostgreSQL claims preserve encrypted request custody, retries, locks and reconciliation',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Guarded disposable PostgreSQL required');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3,connectionTimeoutMillis:5000,statement_timeout:5000});
 const schema='mail_claim_'+randomUUID().replaceAll('-','');
 const first=await pool.connect(),second=await pool.connect();
 const calls:RequestInit[]=[];
 const mailer=createMailer(config,async(_url,options)=>{calls.push(options!);return Response.json({id:randomUUID()});})!;
 try{
  await first.query(`CREATE SCHEMA ${schema}`);
  await first.query(`SET search_path TO ${schema}`);await second.query(`SET search_path TO ${schema}`);
  await first.query(`CREATE TABLE jobs(id uuid PRIMARY KEY,kind text NOT NULL DEFAULT 'email',status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,run_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),last_error text)`);
  const payload={to:'synthetic@example.invalid',subject:'Your Onesa sign-in link',encryptedText:encrypt('Private synthetic body')};
  const insert=async(attempts=0)=>{const id=randomUUID();await first.query('INSERT INTO jobs(id,attempts,payload) VALUES($1,$2,$3)',[id,attempts,payload]);return id;};
  const claim=async(client=first,transport:Mailer=mailer)=>{await client.query('BEGIN');try{const job=await claimMailJob(client,transport);await client.query('COMMIT');return job;}catch(error){await client.query('ROLLBACK');throw error;}};
  const requeue=async(id:string)=>first.query("UPDATE jobs SET status='pending',locked_at=NULL WHERE id=$1",[id]);
  const row=async(id:string)=>(await first.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  const fresh=await insert();
  await first.query('BEGIN');const claimed=await claimMailJob(first,mailer);
  assert.equal(claimed.id,fresh);assert.equal(claimed.attempts,1);assert.equal(claimed.payload.mailPresentation,'branded-v2');
  assert.equal(calls.length,0,'Preparation cannot send before transaction commit');
  assert.equal(await claim(second),undefined,'Competing worker skips held row');
  await first.query('COMMIT');
  const stored=await row(fresh);
  assert.equal(typeof stored.payload.mailAttempt,'string');
  assert.doesNotMatch(stored.payload.mailAttempt,/Private synthetic body|synthetic-test-key|sender@example/);
  const custody=JSON.parse(decrypt(stored.payload.mailAttempt));
  assert.equal(custody.attempt.bytes,claimed.mailAttempt.bytes);assert.ok(custody.firstAttemptAt);
  await mailer.deliver(claimed.mailAttempt);
  await requeue(fresh);
  // A genuinely new connection/transport reuses original bytes, not the renderer.
  const restarted=await pool.connect();
  try{
   await restarted.query(`SET search_path TO ${schema}`);
   const transport=createMailer(config,async(_url,options)=>{calls.push(options!);return Response.json({id:randomUUID()});})!;
   transport.prepare=async()=>{throw Error('Retry must not render');};
   const retry=await claim(restarted,transport);assert.equal(retry.attempts,2);
   assert.equal(retry.payload.mailAttempt,stored.payload.mailAttempt);
   await transport.deliver(retry.mailAttempt);
   assert.equal(calls[0].body,calls[1].body);
   assert.equal(new Headers(calls[0].headers).get('Idempotency-Key'),new Headers(calls[1].headers).get('Idempotency-Key'));
  }finally{restarted.release();}
  // Sender, recipient and credential changes hold the original proof untouched.
  for(const changed of [{MAIL_FROM:'Other <other@example.invalid>'},{MAIL_REPLY_TO:'reply@example.invalid'},{RESEND_API_KEY:'rotated-synthetic-key'}]){
   await requeue(fresh);const before=await row(fresh);
   assert.equal(await claim(first,createMailer({...config,...changed})!),undefined);
   const held=await row(fresh);assert.equal(held.status,'failed');assert.equal(held.attempts,before.attempts);assert.deepEqual(held.payload,before.payload);assert.match(held.last_error,/reconciliation/);
  }
  await requeue(fresh);await first.query(`UPDATE jobs SET payload=jsonb_set(payload,'{to}','"changed@example.invalid"') WHERE id=$1`,[fresh]);
  assert.equal(await claim(),undefined);assert.equal((await row(fresh)).status,'failed');
  for(const version of [undefined,'branded-v1','branded-v2']){
   await first.query('TRUNCATE jobs');const legacy=await insert(1);
   if(version)await first.query("UPDATE jobs SET payload=jsonb_set(payload,'{mailPresentation}',$2::jsonb) WHERE id=$1",[legacy,JSON.stringify(version)]);
   const before=await row(legacy);assert.equal(await claim(),undefined);
   const held=await row(legacy);assert.equal(held.status,'failed');assert.equal(held.attempts,1);assert.deepEqual(held.payload,before.payload,'Legacy attempted payload cannot be reconstructed');
  }
  await first.query('TRUNCATE jobs');const interrupted=await insert();
  await first.query('BEGIN');assert.equal((await claimMailJob(first,mailer)).attempts,1);await first.query('ROLLBACK');
  assert.equal((await row(interrupted)).payload.mailAttempt,undefined);
  const recovered=await claim(second);assert.equal(recovered.id,interrupted);assert.equal(recovered.attempts,1);
  await first.query('TRUNCATE jobs');await insert(5);assert.equal(await claim(),undefined);
  for(const age of ["now()-interval '25 hours'","now()+interval '1 hour'"]){
   await first.query('TRUNCATE jobs');const id=await insert();const original=await claim();await requeue(id);
   await first.query(`UPDATE jobs SET created_at=${age} WHERE id=$1`,[id]);
   assert.equal(await claim(),undefined);const held=await row(id);assert.equal(held.status,'failed');assert.equal(held.attempts,1);assert.equal(held.payload.mailAttempt,original.payload.mailAttempt);
  }
  await first.query('TRUNCATE jobs');const unsent=await insert();await first.query("UPDATE jobs SET created_at=now()-interval '2 days' WHERE id=$1",[unsent]);assert.equal((await claim()).id,unsent);
  await first.query('TRUNCATE jobs');const recent=await insert();await claim();await requeue(recent);await first.query("UPDATE jobs SET created_at=now()-interval '22 hours' WHERE id=$1",[recent]);assert.equal((await claim()).id,recent);
  await first.query('TRUNCATE jobs');const lockedExpired=await insert(1),independent=await insert();
  await first.query("UPDATE jobs SET created_at=now()-interval '25 hours' WHERE id=$1",[lockedExpired]);
  await first.query('BEGIN');await first.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[lockedExpired]);assert.equal((await claim(second)).id,independent);await first.query('COMMIT');assert.equal(await claim(),undefined);assert.equal((await row(lockedExpired)).status,'failed');
  // SMTP has immutable MIME but no provider idempotency: never automatically
  // replay a committed, potentially accepted SMTP attempt after interruption.
  await first.query('TRUNCATE jobs');const smtpId=await insert();const smtp=createMailer({...config,MAIL_PROVIDER:'smtp',SMTP_HOST:'smtp.example.invalid'})!;
  const smtpJob=await claim(first,smtp);assert.equal(smtpJob.id,smtpId);assert.match(Buffer.from(smtpJob.mailAttempt.bytes,'base64').toString(),/Message-ID:/);await requeue(smtpId);assert.equal(await claim(first,smtp),undefined);assert.equal((await row(smtpId)).status,'failed');
 }finally{
  await first.query('ROLLBACK');await second.query('ROLLBACK');await first.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);first.release();second.release();await pool.end();
 }
});
