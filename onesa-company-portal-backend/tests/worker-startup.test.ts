import './local-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';

test('Production worker refuses missing shared storage before connecting or processing jobs',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','src/jobs/worker.ts'],{
  cwd:process.cwd(),timeout:5000,encoding:'utf8',env:{
   PATH:process.env.PATH,
   NODE_ENV:'production',
   PUBLIC_ORIGIN:'https://synthetic.example.invalid',
   DATABASE_URL:'postgresql://synthetic@127.0.0.1:1/synthetic',
   SESSION_KEY:randomBytes(32).toString('hex'),
   PROXY_SHARED_KEY:randomBytes(32).toString('hex'),
  },
 });
 assert.equal(result.status,1);
 assert.equal(result.stdout,'');
 assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'worker_configuration_rejected'});
});

test('Long idle polling requires explicit staging selection before connecting',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','src/jobs/worker.ts'],{
  cwd:process.cwd(),timeout:5000,encoding:'utf8',env:{
   PATH:process.env.PATH,NODE_ENV:'test',WORKER_IDLE_MAX_MS:'600000',
   DATABASE_URL:'postgresql://synthetic@127.0.0.1:1/synthetic_test',
   SESSION_KEY:randomBytes(32).toString('hex'),
  },
 });
 assert.equal(result.status,1);
 assert.match(result.stderr,/Idle worker backoff requires the explicit staging profile/);
});
