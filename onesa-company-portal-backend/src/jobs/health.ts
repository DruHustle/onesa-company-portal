import {createConnection} from 'node:net';
import {readFile} from 'node:fs/promises';
import {env,workerIdleMaxMs} from '../config/env.js';
import {workerHeartbeatCurrent} from './polling.js';
import {scannerStatusCurrent} from '../services/storage.js';

async function scannerReady():Promise<boolean>{
 if(!await scannerStatusCurrent())return false;
 return new Promise(resolve=>{
  const socket=createConnection(env.CLAMAV_SOCKET?{path:env.CLAMAV_SOCKET}:{host:env.CLAMAV_HOST!,port:env.CLAMAV_PORT});
  let response='';const deadline=setTimeout(()=>socket.destroy(),3000);
  socket.on('connect',()=>socket.write('zPING\0'));
  socket.on('data',part=>{response+=part.toString();if(response.length>16)socket.destroy();});
  socket.on('end',()=>{clearTimeout(deadline);resolve(response==='PONG\0');});
  socket.on('error',()=>{clearTimeout(deadline);resolve(false);});
  socket.on('close',()=>{clearTimeout(deadline);resolve(response==='PONG\0');});
 });
}
try{
 const ready=workerHeartbeatCurrent(await readFile('/tmp/onesa-worker-success','utf8'),Date.now(),workerIdleMaxMs)&&await scannerReady();
 process.exitCode=ready?0:1;
 console.log(JSON.stringify({event:'worker_health',ready}));
}catch{process.exitCode=1;console.log(JSON.stringify({event:'worker_health',ready:false}));}
