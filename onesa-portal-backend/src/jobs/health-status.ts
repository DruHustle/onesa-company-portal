import {workerHeartbeatCurrent} from './polling.js';

export async function workerHealthReady(input:{heartbeat:string;now:number;maximumIdleMs:number;processAlive:()=>Promise<boolean>;scannerReady:()=>Promise<boolean>}):Promise<boolean>{
 if(!workerHeartbeatCurrent(input.heartbeat,input.now,input.maximumIdleMs))return false;
 if(!await input.processAlive())return false;
 return input.scannerReady();
}
