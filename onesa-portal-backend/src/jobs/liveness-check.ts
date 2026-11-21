import {workerProcessAlive} from './process-liveness.js';

const alive=await workerProcessAlive();
console.log(JSON.stringify({event:'worker_liveness',alive}));
process.exitCode=alive?0:1;
