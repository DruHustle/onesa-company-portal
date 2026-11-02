import {WorkerProcessLiveness} from '../../src/jobs/process-liveness.js';
import {runWorkerLoop} from '../../src/jobs/worker-loop.js';

const [path,mode]=process.argv.slice(2);
if(!path||!['idle','drain'].includes(mode))throw new Error('Invalid isolated worker fixture');
const shutdown=new AbortController();
let release!:()=>void;
const work=new Promise<void>(resolve=>{release=resolve;});
process.on('SIGTERM',()=>shutdown.abort());
process.on('message',message=>{if(message==='release')release();});
await runWorkerLoop({signal:shutdown.signal,maximumIdleMs:600000,liveness:new WorkerProcessLiveness({path,interval:20}),
 tick:async()=>{if(mode==='drain')await work;return false;},success:async()=>{},failure:()=>{throw new Error('Unexpected isolated worker failure');},
});
process.disconnect();
