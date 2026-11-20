import {setTimeout as sleep} from 'node:timers/promises';
import {activePollMs,nextPollMs} from './polling.js';
import {WorkerProcessLiveness} from './process-liveness.js';

export async function runWorkerLoop(options:{
 signal:AbortSignal;
 maximumIdleMs:number;
 tick:(progress:()=>void)=>Promise<boolean>;
 success:(nextPollMs:number)=>Promise<void>;
 failure:()=>void;
 liveness?:WorkerProcessLiveness;
}){
 const {signal,maximumIdleMs,tick,success,failure}=options;
 const liveness=options.liveness??new WorkerProcessLiveness();
 let delay=activePollMs;
 await liveness.start();
 try{
  while(!signal.aborted){
   await liveness.working();
   try{delay=nextPollMs(delay,await tick(()=>liveness.progress()),maximumIdleMs);await success(delay);}
   catch{delay=activePollMs;failure();}
   if(!signal.aborted){
    await liveness.idle(delay);
    await sleep(delay,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
   }
  }
 }finally{await liveness.stop();}
}
