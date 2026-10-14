import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Role} from '../access/roles.js';
import {db,pagedQuery} from '../services/db.js';
import {normalize} from '../services/workflows.js';
import {env,emailConfig} from '../config/env.js';
import {error,pageOf} from '../api/contracts.js';
const job=z.object({id:z.string().uuid(),kind:z.enum(['email','reminder']),status:z.enum(['pending','running','accepted','failed']),attempts:z.number().int(),run_at:z.string(),locked_at:z.string().nullable(),created_at:z.string(),errorCategory:z.enum(['retry_exhausted','dependency_unavailable','cancelled','unclassified']).nullable()});
const query=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(50).default(20),status:job.shape.status.optional()});
const group=z.object({kind:z.string(),status:z.string(),count:z.number().int()});
const overview=z.object({jobs:z.array(group),storageDeletionJobs:z.array(group),oldestQueueAgeSeconds:z.number(),workerLastSuccessAt:z.string().nullable(),workerState:z.enum(['recent','stale','not_observed']),backupLastSuccessAt:z.string().nullable(),quarantineFiles:z.number().int(),scannerConfigurationPresent:z.boolean(),scannerReadiness:z.literal('requires_runtime_evidence'),emailConfigurationPresent:z.boolean(),mailAcceptanceNote:z.string(),mutationRestrictions:z.array(z.string())});
const errors={400:error,401:error,403:error,404:error,409:error,429:error,500:error,503:error};
const meta=(operationId:string)=>({operationId,tags:['Background processing'],security:[{sessionCookie:[]}],description:'INTERNAL owner/administrator queue diagnostics; no personal payloads, recipients, storage keys or raw logs.'});
export async function registerProcessing(app:FastifyInstance,allow:(roles:readonly Role[])=>(req:FastifyRequest)=>Promise<void>){
 const api=app.withTypeProvider<ZodTypeProvider>(),guard=allow(['administrator']);
 api.get('/api/v1/admin/processing/overview',{preHandler:guard,schema:{...meta('processingOverview'),response:{200:overview,...errors}}},async()=>{
  const jobs=(await db.query('SELECT kind,status,count(*)::int AS count FROM jobs GROUP BY kind,status ORDER BY kind,status')).rows;
  const deletions=(await db.query("SELECT 'storage_deletion' AS kind,status,count(*)::int AS count FROM storage_deletions GROUP BY status ORDER BY status")).rows;
  const stats=(await db.query("SELECT coalesce((SELECT extract(epoch FROM now()-min(created_at)) FROM jobs WHERE status IN ('pending','running')),0)::float8 AS age,(SELECT updated_at FROM operational_state WHERE key='worker_success') AS worker,(SELECT updated_at FROM operational_state WHERE key='backup_success') AS backup,(SELECT count(*)::int FROM files WHERE scan_status='quarantine') AS quarantine")).rows[0];
  const workerLastSuccessAt=stats.worker?new Date(stats.worker).toISOString():null;
  return overview.parse({jobs,storageDeletionJobs:deletions,oldestQueueAgeSeconds:Math.max(0,Number(stats.age)),workerLastSuccessAt,workerState:workerLastSuccessAt?(Date.now()-Date.parse(workerLastSuccessAt)<120000?'recent':'stale'):'not_observed',backupLastSuccessAt:stats.backup?new Date(stats.backup).toISOString():null,quarantineFiles:stats.quarantine,scannerConfigurationPresent:!!(env.CLAMAV_HOST||env.CLAMAV_SOCKET),scannerReadiness:'requires_runtime_evidence' as const,emailConfigurationPresent:!!(emailConfig.RESEND_API_KEY||env.SMTP_HOST),mailAcceptanceNote:'Accepted means the transport accepted the message. Delivery, bounce and inbox receipt require separate provider evidence.',mutationRestrictions:['Failed email retries require reconciliation of possible provider acceptance to avoid duplicate delivery.','Running jobs cannot be cancelled safely through this read-only view. Use the controlled worker procedure.','Scanner readiness and signature freshness require the protected runtime evidence; configuration presence is insufficient.']});
 });
 api.get('/api/v1/admin/processing/jobs',{preHandler:guard,schema:{...meta('listProcessingJobs'),querystring:query,response:{200:pageOf(job),...errors}}},async req=>{
  const q=req.query,result=await pagedQuery('SELECT *,count(*) OVER() AS total FROM jobs WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC OFFSET $2 LIMIT $3',[q.status??null,(q.page-1)*q.limit,q.limit]);
  const items=result.rows.map(row=>{const value=normalize<Record<string,unknown>>(row),message=String(value.last_error??'');return job.parse({id:value.id,kind:value.kind,status:value.status,attempts:value.attempts,run_at:value.run_at,locked_at:value.locked_at,created_at:value.created_at,errorCategory:message?(message.includes('retry limit')?'retry_exhausted':message.includes('delivery not accepted')?'dependency_unavailable':message.includes('Cancelled')?'cancelled':'unclassified'):null});});
  return {items,page:q.page,limit:q.limit,total:result.total};
 });
}
