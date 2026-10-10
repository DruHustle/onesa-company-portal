import type {FastifyInstance} from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import {db} from './db.js';
import {env} from '../config/env.js';
import {HttpError} from './workflows.js';

export function metrics(app:FastifyInstance){
 const counts=new Map<string,number>(),durations=new Map<string,{sum:number;count:number;buckets:number[]}>();
 const buckets=[0.01,0.05,0.1,0.5,1,5,20];
 app.addHook('onResponse',async(req,reply)=>{const route=req.routeOptions.url||'unmatched';const method=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method)?req.method:'OTHER';const key=JSON.stringify({route,method,status:Math.floor(reply.statusCode/100)+'xx'});counts.set(key,(counts.get(key)||0)+1);const elapsed=reply.elapsedTime/1000;const record=durations.get(route)||{sum:0,count:0,buckets:buckets.map(()=>0)};record.sum+=elapsed;record.count++;for(let i=0;i<buckets.length;i++)if(elapsed<=buckets[i])record.buckets[i]++;durations.set(route,record);});
 app.get('/api/v1/metrics',{schema:{hide:true}},async(req,reply)=>{
  const expected=Buffer.from('Bearer '+(env.METRICS_TOKEN||'')),provided=Buffer.from(req.headers.authorization||'');if(!env.METRICS_TOKEN||provided.length!==expected.length||!timingSafeEqual(expected,provided))throw new HttpError(403,'METRICS','Metrics access denied');
  const lines=[];for(const [key,value] of counts){const labels=Object.entries(JSON.parse(key)).map(([name,value])=>`${name}=${JSON.stringify(value)}`).join(',');lines.push(`onesa_portal_http_requests_total{${labels}} ${value}`);}
  for(const [route,value] of durations){for(let i=0;i<buckets.length;i++)lines.push(`onesa_portal_http_latency_seconds_bucket{route=${JSON.stringify(route)},le="${buckets[i]}"} ${value.buckets[i]}`);lines.push(`onesa_portal_http_latency_seconds_bucket{route=${JSON.stringify(route)},le="+Inf"} ${value.count}`,`onesa_portal_http_latency_seconds_sum{route=${JSON.stringify(route)}} ${value.sum}`,`onesa_portal_http_latency_seconds_count{route=${JSON.stringify(route)}} ${value.count}`);}
  try{
   const result=(await db.query("SELECT (SELECT count(*) FROM jobs WHERE status='failed')::int AS failures,(SELECT count(*) FROM jobs WHERE status IN ('pending','running'))::int AS queued,(SELECT coalesce(extract(epoch FROM now()-min(created_at)),0) FROM jobs WHERE status IN ('pending','running')) AS age,(SELECT coalesce(sum(size),0) FROM files) AS bytes,(SELECT extract(epoch FROM updated_at) FROM operational_state WHERE key='worker_success') AS worker,(SELECT extract(epoch FROM updated_at) FROM operational_state WHERE key='backup_success') AS backup")).rows[0];
   lines.push('onesa_portal_database_available 1',`onesa_portal_queue_failures ${result.failures}`,`onesa_portal_queue_jobs ${result.queued}`,`onesa_portal_queue_age_seconds ${result.age}`,`onesa_portal_logical_file_bytes ${result.bytes}`,`onesa_portal_worker_last_success_timestamp_seconds ${result.worker||0}`,`onesa_portal_backup_last_success_timestamp_seconds ${result.backup||0}`);
  }catch{lines.push('onesa_portal_database_available 0');}
  lines.push(`onesa_portal_process_resident_memory_bytes ${process.memoryUsage().rss}`);return reply.type('text/plain; version=0.0.4').send(lines.join('\n')+'\n');
 });
}
