import './local-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,readFile,stat,chmod,symlink,link,unlink,writeFile,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {WorkerProcessLiveness,workerLivenessCurrent,workerProcessAlive,workerProgressMaxMs,workerPulseMaxAgeMs,workerIdleGraceMs} from '../src/jobs/process-liveness.js';
import {runWorkerLoop} from '../src/jobs/worker-loop.js';
import {workerHeartbeatCurrent} from '../src/jobs/polling.js';

async function until(check:()=>Promise<boolean>,timeout=3000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await check())return;await sleep(10);}
 assert.fail('Worker liveness fixture did not reach its expected state');
}
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'onesa-worker-liveness-test-'));return {directory,path:join(directory,'heartbeat')};}
async function snapshot(path:string){return JSON.parse(await readFile(path,'utf8')) as {pid:number;phase:string;phaseAt:number;pulseAt:number;deadlineAt:number};}

test('Process pulses cannot hide expired progress, future evidence or an overdue idle wake',()=>{
 const now=2000000;
 const work={version:1,pid:process.pid,phase:'working',phaseAt:now,pulseAt:now,deadlineAt:now+workerProgressMaxMs};
 assert.equal(workerLivenessCurrent(JSON.stringify(work),now),true);
 assert.equal(workerLivenessCurrent(JSON.stringify(work),now+workerPulseMaxAgeMs),false);
 assert.equal(workerLivenessCurrent(JSON.stringify({...work,pulseAt:now+workerProgressMaxMs}),now+workerProgressMaxMs),false);
 const idle={...work,phase:'idle',deadlineAt:now+600000+workerIdleGraceMs,pulseAt:now+599999};
 assert.equal(workerLivenessCurrent(JSON.stringify(idle),now+599999),true);
 assert.equal(workerLivenessCurrent(JSON.stringify({...idle,pulseAt:idle.deadlineAt}),idle.deadlineAt),false);
 for(const bad of [null,{},[],{...work,extra:true},{...work,pid:0},{...work,pulseAt:now+1},{...work,phaseAt:now+1},{...work,deadlineAt:now+workerProgressMaxMs+1},{...idle,deadlineAt:now+600001+workerIdleGraceMs}])assert.equal(workerLivenessCurrent(JSON.stringify(bad),now),false);
});

test('Private atomic process evidence rejects links, wrong modes, corrupt and oversized files',async()=>{
 const {directory,path}=await fixture();
 const liveness=new WorkerProcessLiveness({path,interval:20000});
 try{
  assert.equal(await workerProcessAlive(path),false);
  await liveness.start();
  assert.equal(await workerProcessAlive(path),true);
  assert.equal((await stat(path)).mode&0o777,0o600);
  await symlink(path,path+'.symlink');
  assert.equal(await workerProcessAlive(path+'.symlink'),false);
  await link(path,path+'.hardlink');
  assert.equal(await workerProcessAlive(path),false);
  await unlink(path+'.hardlink');
  await chmod(path,0o644);
  assert.equal(await workerProcessAlive(path),false);
  await liveness.pulse();
  assert.equal(await workerProcessAlive(path),true);
  for(const raw of ['{',JSON.stringify({pid:process.pid}),' '.repeat(1025)]){
   await writeFile(path,raw,{mode:0o600});
   assert.equal(await workerProcessAlive(path),false);
  }
  assert.equal(await workerProcessAlive(directory),false);
 }finally{await liveness.stop();await rm(directory,{recursive:true,force:true});}
});

test('Atomic heartbeat replacement refuses an unlinked open inode while the current record remains live',async()=>{
 const {directory,path}=await fixture();
 const liveness=new WorkerProcessLiveness({path});
 const originalOpen=fsPromises.open;
 let replaced=false;
 let observedLinks:number|undefined;
 try{
  await liveness.start();
  fsPromises.open=async(...args:Parameters<typeof originalOpen>)=>{
   const file=await originalOpen(...args);
   if(args[0]===path&&!replaced){
    replaced=true;
    await liveness.pulse();
    observedLinks=(await file.stat()).nlink;
   }
   return file;
  };
  syncBuiltinESMExports();
  try{
   assert.equal(await workerProcessAlive(path),false);
   assert.equal(replaced,true);
   assert.equal(observedLinks,0);
  }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();}
  assert.equal(await workerProcessAlive(path),true);
 }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();await liveness.stop();await rm(directory,{recursive:true,force:true});}
});

test('An unresolved work promise fails its progress bound while event-loop pulses continue',async()=>{
 const {directory,path}=await fixture();
 let now=2000000;
 const liveness=new WorkerProcessLiveness({path,now:()=>now,interval:20});
 const shutdown=new AbortController();
 let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 let entered=false;
 const loop=runWorkerLoop({signal:shutdown.signal,maximumIdleMs:5000,liveness,
  tick:async()=>{entered=true;await blocked;return false;},success:async()=>{},failure:()=>assert.fail('Unexpected worker failure'),
 });
 try{
  await until(async()=>entered&&await workerProcessAlive(path,now));
  const started=(await snapshot(path)).phaseAt;
  now=started+workerProgressMaxMs;
  await until(async()=>(await snapshot(path)).pulseAt===now);
  assert.equal((await snapshot(path)).deadlineAt,started+workerProgressMaxMs);
  assert.equal(await workerProcessAlive(path,now),false);
 }finally{shutdown.abort();release();await loop;await rm(directory,{recursive:true,force:true});}
});

test('Real work checkpoints keep a long batch alive without renewing progress from its pulse timer',async()=>{
 const {directory,path}=await fixture();
 let now=2000000;
 const liveness=new WorkerProcessLiveness({path,now:()=>now,interval:20000});
 try{
  await liveness.start();
  for(let completed=0;completed<10;completed++){
   now+=100000;
   liveness.progress();
   await liveness.pulse();
   assert.equal(await workerProcessAlive(path,now),true);
  }
  now+=workerProgressMaxMs;
  await liveness.pulse();
  assert.equal(await workerProcessAlive(path,now),false);
 }finally{await liveness.stop();await rm(directory,{recursive:true,force:true});}
});

test('Ten-minute staging idle has fresh process pulses and stop removes evidence without waiting for idle',async()=>{
 const {directory,path}=await fixture();
 let now=2000000;
 const liveness=new WorkerProcessLiveness({path,now:()=>now,interval:20});
 try{
  await liveness.start();
  await liveness.idle(600000);
  now+=599999;
  await until(async()=>(await snapshot(path)).pulseAt===now);
  assert.equal(await workerProcessAlive(path,now),true);
  const deadline=(await snapshot(path)).deadlineAt;
  now=deadline;
  await until(async()=>(await snapshot(path)).pulseAt===now);
  assert.equal(await workerProcessAlive(path,now),false);
  await liveness.stop();
  await sleep(50);
  assert.equal(await workerProcessAlive(path,now),false);
  await assert.rejects(readFile(path,'utf8'),{code:'ENOENT'});
 }finally{await liveness.stop();await rm(directory,{recursive:true,force:true});}
});

test('Rejected dependency work remains live, retries, and never mints successful-work readiness',async()=>{
 const {directory,path}=await fixture();
 const liveness=new WorkerProcessLiveness({path,interval:20});
 const shutdown=new AbortController();
 let attempts=0,failures=0,successes=0;
 const loop=runWorkerLoop({signal:shutdown.signal,maximumIdleMs:600000,liveness,
  tick:async()=>{attempts++;throw new Error(attempts===1?'Synthetic database refusal':'Synthetic scanner refusal');},
  success:async()=>{successes++;},failure:()=>{failures++;if(failures===2)shutdown.abort();},
 });
 try{
  await until(async()=>failures===1&&(await snapshot(path)).phase==='idle');
  assert.equal(await workerProcessAlive(path),true);
  assert.equal((await snapshot(path)).deadlineAt-(await snapshot(path)).phaseAt,5000+workerIdleGraceMs);
  assert.equal(workerHeartbeatCurrent('{}',Date.now(),600000),false);
  await loop;
  assert.equal(attempts,2);assert.equal(failures,2);assert.equal(successes,0);
  assert.equal(await workerProcessAlive(path),false);
 }finally{shutdown.abort();await loop;await rm(directory,{recursive:true,force:true});}
});

test('SIGTERM interrupts real worker-loop idle promptly and drains in-flight work before exiting',async()=>{
 for(const mode of ['idle','drain']){
  const {directory,path}=await fixture();
  const child=spawn(process.execPath,['--import','tsx','tests/fixtures/worker-liveness-child.ts',path,mode],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
  let stderr='';child.stderr?.on('data',part=>{stderr+=part.toString();});
  const events:unknown[]=[];child.on('message',message=>{events.push(message);});
  const exited=once(child,'exit');
  try{
   await until(async()=>{try{return events.includes('tick-entered')&&(await snapshot(path)).phase===(mode==='idle'?'idle':'working')&&await workerProcessAlive(path);}catch{return false;}});
   const before=Date.now();
   const remaining=()=>Math.max(1,3000-(Date.now()-before));
   assert.equal(child.kill('SIGTERM'),true);
   await until(async()=>events.includes('stop-observed'),remaining());
   if(mode==='drain'){
    await sleep(50);
    assert.equal(child.exitCode,null);
    assert.equal(events.includes('tick-completed'),false);
    assert.equal(await workerProcessAlive(path),true);
    child.send('release');
   }
   await until(async()=>events.includes('loop-completed'),remaining());
   const [code,signal]=await Promise.race([exited,sleep(remaining()).then(()=>{throw new Error('Worker did not drain promptly');})]);
   assert.equal(code,0);assert.equal(signal,null);assert.equal(stderr,'');
   assert.equal(events.includes('tick-completed'),true);
   assert.ok(Date.now()-before<3000);
   assert.equal(await workerProcessAlive(path),false);
  }finally{if(child.exitCode===null){child.kill('SIGKILL');await exited;}await rm(directory,{recursive:true,force:true});}
 }
});

test('A startup working heartbeat does not prove tick entry and SIGTERM skips work not yet started',async()=>{
 const {directory,path}=await fixture();
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/worker-liveness-child.ts',path,'startup'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
 const events:unknown[]=[];child.on('message',message=>{events.push(message);});
 let stderr='';child.stderr?.on('data',part=>{stderr+=part.toString();});
 const exited=once(child,'exit');
 try{
  await until(async()=>events.includes('startup-pulse'));
  assert.equal((await snapshot(path)).phase,'working');
  assert.equal(await workerProcessAlive(path),true);
  assert.equal(events.includes('tick-entered'),false);
  const before=Date.now();
  const remaining=()=>Math.max(1,3000-(Date.now()-before));
  assert.equal(child.kill('SIGTERM'),true);
  await until(async()=>events.includes('stop-observed'),remaining());
  child.send('start');
  await until(async()=>events.includes('loop-completed'),remaining());
  const [code,signal]=await Promise.race([exited,sleep(remaining()).then(()=>{throw new Error('Startup fixture did not stop promptly');})]);
  assert.equal(code,0);assert.equal(signal,null);assert.equal(stderr,'');
  assert.ok(Date.now()-before<3000);
  assert.equal(events.includes('tick-entered'),false);
  assert.equal(events.includes('tick-completed'),false);
  assert.equal(await workerProcessAlive(path),false);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}await rm(directory,{recursive:true,force:true});}
});

test('A real suspended worker stops pulsing and a crashed process fails even with fresh evidence',async()=>{
 const {directory,path}=await fixture();
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/worker-liveness-child.ts',path,'pulse'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
 const exited=once(child,'exit');
 try{
  await until(async()=>await workerProcessAlive(path));
  let observed=await snapshot(path);
  await until(async()=>{const next=await snapshot(path);if(next.pulseAt>observed.pulseAt){observed=next;return true;}return false;});
  child.kill('SIGSTOP');
  // Allow an already submitted atomic write to settle before recording the frozen pulse.
  await sleep(50);
  const stopped=await snapshot(path);
  await sleep(80);
  assert.equal((await snapshot(path)).pulseAt,stopped.pulseAt);
  assert.equal(await workerProcessAlive(path,stopped.pulseAt+workerPulseMaxAgeMs),false);
  child.kill('SIGCONT');
  await until(async()=>(await snapshot(path)).pulseAt>stopped.pulseAt&&await workerProcessAlive(path));
  child.kill('SIGKILL');
  const [code,signal]=await exited;
  assert.equal(code,null);assert.equal(signal,'SIGKILL');
  assert.equal(workerLivenessCurrent(await readFile(path,'utf8'),Date.now()),true);
  assert.equal(await workerProcessAlive(path),false);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}await rm(directory,{recursive:true,force:true});}
});
