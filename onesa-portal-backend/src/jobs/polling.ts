export const activePollMs=5000;
export const maximumIdleMs=600000;

/** Only an explicitly configured, empty staging queue may back off. */
export function nextPollMs(previous:number,pending:boolean,maximum:number){
 return pending?activePollMs:Math.min(maximum,Math.max(activePollMs,previous*2));
}

export function workerHeartbeatCurrent(raw:string,now:number,maximum:number){
 try{
  const value:unknown=JSON.parse(raw);
  // A retained old worker writes a timestamp every five seconds.
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0&&now>=value&&now-value<60000;
  if(!value||typeof value!=='object')return false;
  const {successAt,nextPollAt}=value as {successAt:unknown;nextPollAt:unknown};
  return typeof successAt==='number'&&typeof nextPollAt==='number'&&
   Number.isSafeInteger(successAt)&&Number.isSafeInteger(nextPollAt)&&successAt>0&&now>=successAt&&
   nextPollAt-successAt>=activePollMs&&nextPollAt-successAt<=maximum&&now<nextPollAt+60000;
 }catch{return false;}
}
