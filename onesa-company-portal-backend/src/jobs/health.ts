import {createConnection} from 'node:net';
import {readFile} from 'node:fs/promises';
import {env} from '../config/env.js';
import {db} from '../services/db.js';
import {applicationRoleSafe} from '../services/database-role.js';
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
 const heartbeat=await db.query("SELECT updated_at>now()-interval '60 seconds' AS recent FROM operational_state WHERE key='worker_success'");
 const ownSuccess=Number(await readFile('/tmp/onesa-worker-success','utf8'));
 const age=Date.now()-ownSuccess;
 const ready=Number.isFinite(ownSuccess)&&age>=0&&age<60000&&heartbeat.rows[0]?.recent===true&&await applicationRoleSafe(db)&&await scannerReady();
 process.exitCode=ready?0:1;
 console.log(JSON.stringify({event:'worker_health',ready}));
}catch{process.exitCode=1;console.log(JSON.stringify({event:'worker_health',ready:false}));}
finally{await db.end();}
