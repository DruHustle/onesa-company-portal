import {WorkerProcessLiveness} from '../../src/jobs/process-liveness.js';
import {runWorkerLoop} from '../../src/jobs/worker-loop.js';

const [path,mode]=process.argv.slice(2);
if(!path||!process.connected||!['idle','drain','pulse','startup'].includes(mode))throw new Error('Invalid isolated worker fixture');
const shutdown=new AbortController();
let release!:()=>void;
const work=new Promise<void>(resolve=>{release=resolve;});
let begin!:()=>void;
const startup=new Promise<void>(resolve=>{begin=resolve;});
const report=(event:string)=>process.send?.(event);
process.on('SIGTERM',()=>{shutdown.abort();report('stop-observed');});
process.on('message',message=>{if(message==='release')release();if(message==='start')begin();});
class FixtureLiveness extends WorkerProcessLiveness {
 override async start(){
  await super.start();
  if(mode==='startup'){report('startup-pulse');await startup;}
 }
}
// Only the suspension observation accelerates pulses. Shutdown/drain fixtures
// retain the production interval, so atomic renewal does not race their short
// one-shot custody observation. All parent post-signal deadlines remain three seconds.
const liveness=new FixtureLiveness(mode==='pulse'?{path,interval:20}:{path});
const watchdog=setTimeout(()=>process.exit(1),10000);
watchdog.unref();
try{
 await runWorkerLoop({signal:shutdown.signal,maximumIdleMs:600000,liveness,
  tick:async()=>{report('tick-entered');if(mode!=='idle')await work;report('tick-completed');return false;},
  success:async()=>{},failure:()=>{throw new Error('Unexpected isolated worker failure');},
 });
 report('loop-completed');
 process.disconnect();
}finally{clearTimeout(watchdog);}
