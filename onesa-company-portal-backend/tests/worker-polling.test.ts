import test from 'node:test';
import assert from 'node:assert/strict';
import {nextPollMs,workerHeartbeatCurrent} from '../src/jobs/polling.js';

test('Empty staging backs off within ten minutes; pending work and defaults retain five seconds',()=>{
 let delay=5000;
 for(let i=0;i<20;i++){delay=nextPollMs(delay,false,600000);assert.ok(delay>=5000&&delay<=600000);}
 assert.equal(delay,600000);
 assert.equal(nextPollMs(delay,true,600000),5000);
 assert.equal(nextPollMs(5000,false,5000),5000);
});

test('Worker health follows its bounded successful schedule without a database probe',()=>{
 const now=2000000;
 const heartbeat=JSON.stringify({successAt:now,nextPollAt:now+600000});
 assert.equal(workerHeartbeatCurrent(heartbeat,now+599999,600000),true);
 assert.equal(workerHeartbeatCurrent(heartbeat,now+660000,600000),false);
 assert.equal(workerHeartbeatCurrent(heartbeat,now,5000),false);
 for(const raw of ['{}','null','NaN',JSON.stringify({successAt:now+1,nextPollAt:now+5001}),JSON.stringify({successAt:now,nextPollAt:now+600001})])assert.equal(workerHeartbeatCurrent(raw,now,600000),false);
 assert.equal(workerHeartbeatCurrent(String(now-59999),now,600000),true);
 assert.equal(workerHeartbeatCurrent(String(now-60000),now,600000),false);
});
