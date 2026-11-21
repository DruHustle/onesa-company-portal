import {constants} from 'node:fs';
import {open,rename,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {activePollMs,maximumIdleMs} from './polling.js';

export const workerLivenessPath='/tmp/onesa-worker-liveness';
export const workerPulseMs=10000;
export const workerPulseMaxAgeMs=60000;
export const workerProgressMaxMs=300000;
export const workerIdleGraceMs=60000;

type Phase='working'|'idle';
type State={phase:Phase;phaseAt:number;deadlineAt:number};
type Heartbeat=State&{version:1;pid:number;pulseAt:number};

/** Dependency-free process evidence. A pulse never renews the progress deadline. */
export class WorkerProcessLiveness {
 private state:State|undefined;
 private timer:ReturnType<typeof setInterval>|undefined;
 private writing:Promise<void>|undefined;
 private stopped=false;
 private readonly path:string;
 private readonly now:()=>number;
 private readonly interval:number;

 constructor(options:{path?:string;now?:()=>number;interval?:number}={}){
  this.path=options.path??workerLivenessPath;
  this.now=options.now??Date.now;
  this.interval=options.interval??workerPulseMs;
  if(!Number.isSafeInteger(this.interval)||this.interval<=0||this.interval>=workerPulseMaxAgeMs)throw new Error('Invalid worker pulse interval');
 }

 async start(){
  if(this.stopped||this.timer)throw new Error('Worker liveness cannot be restarted');
  this.progress();
  await this.pulse();
  this.timer=setInterval(()=>{void this.pulse();},this.interval);
  this.timer.unref();
 }

 /** Called at real work boundaries, never from the pulse timer. */
 progress(){
  if(this.stopped)return;
  const now=this.now();
  this.state={phase:'working',phaseAt:now,deadlineAt:now+workerProgressMaxMs};
 }

 async working(){this.progress();await this.pulse();}

 async idle(delay:number){
  if(!Number.isSafeInteger(delay)||delay<activePollMs||delay>maximumIdleMs)throw new Error('Invalid worker idle interval');
  if(this.stopped)return;
  const now=this.now();
  this.state={phase:'idle',phaseAt:now,deadlineAt:now+delay+workerIdleGraceMs};
  await this.pulse();
 }

 async pulse(){
  if(this.stopped||!this.state)return;
  // Coalesce slow writes instead of accumulating an unbounded timer queue.
  if(this.writing)return this.writing;
  const heartbeat:Heartbeat={version:1,pid:process.pid,...this.state,pulseAt:this.now()};
  const temporary=this.path+'.'+randomUUID()+'.pending';
  this.writing=(async()=>{
   try{
    await writeFile(temporary,JSON.stringify(heartbeat),{mode:0o600,flag:'wx'});
    await rename(temporary,this.path);
   }catch{
    // A failed local heartbeat write expires naturally; it never grants readiness.
   }finally{await unlink(temporary).catch(()=>{});}
  })();
  try{await this.writing;}finally{this.writing=undefined;}
 }

 async stop(){
  this.stopped=true;
  if(this.timer)clearInterval(this.timer);
  await this.writing;
  await unlink(this.path).catch(()=>{});
 }
}

export function workerLivenessCurrent(raw:string,now:number):boolean{
 try{
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(Object.keys(value).sort().join(',')!=='deadlineAt,phase,phaseAt,pid,pulseAt,version')return false;
  const {version,pid,phase,phaseAt,pulseAt,deadlineAt}=value as Heartbeat;
  if(version!==1||!Number.isSafeInteger(pid)||pid<=0||!['working','idle'].includes(phase))return false;
  if(![now,phaseAt,pulseAt,deadlineAt].every(v=>Number.isSafeInteger(v)&&v>0))return false;
  if(phaseAt>pulseAt||pulseAt>now||now-pulseAt>=workerPulseMaxAgeMs||now>=deadlineAt)return false;
  const duration=deadlineAt-phaseAt;
  return phase==='working'?duration===workerProgressMaxMs:duration>=activePollMs+workerIdleGraceMs&&duration<=maximumIdleMs+workerIdleGraceMs;
 }catch{return false;}
}

/** Fixed-size, no-follow read; the checker has no application configuration imports. */
export async function workerProcessAlive(path=workerLivenessPath,now?:number):Promise<boolean>{
 let file;
 try{
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=await file.stat();
  if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid?.()||stat.size<=0||stat.size>1024)return false;
  const buffer=Buffer.alloc(1025);
  const {bytesRead}=await file.read(buffer,0,buffer.length,0);
  if(bytesRead!==stat.size)return false;
  const raw=buffer.subarray(0,bytesRead).toString('utf8');
  if(!workerLivenessCurrent(raw,now??Date.now()))return false;
  const {pid}=JSON.parse(raw) as Heartbeat;
  process.kill(pid,0);
  return true;
 }catch{return false;}finally{await file?.close().catch(()=>{});}
}
