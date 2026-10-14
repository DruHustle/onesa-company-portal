import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Role} from '../access/roles.js';
import {error,pageOf} from '../api/contracts.js';
import {generatePDF} from '../documents/pdf.js';
import {audit} from '../services/db.js';
import * as G from './schemas.js';
import * as store from './store.js';

type Guard=(roles:readonly Role[])=>(request:FastifyRequest)=>Promise<void>;
const responses={400:error,401:error,403:error,404:error,409:error,429:error,500:error,503:error};
const meta=(operationId:string)=>({operationId,tags:['Privacy governance'],security:[{sessionCookie:[]}],description:'INTERNAL. Owner/administrator access only; no public CMS or cache. Mutations require CSRF; final decisions require owner reauthentication.'});
const params=z.object({stableId:G.stableId});
export async function registerGovernance(app:FastifyInstance,allow:Guard){
 const api=app.withTypeProvider<ZodTypeProvider>(),guard=allow(['administrator']);
 api.get('/api/v1/admin/governance/overview',{preHandler:guard,schema:{...meta('privacyGovernanceOverview'),response:{200:G.overview,...responses}}},async()=>store.summary());
 api.get('/api/v1/admin/governance/records',{preHandler:guard,schema:{...meta('listGovernanceRecords'),querystring:G.query,response:{200:pageOf(G.record),...responses}}},async req=>store.listRecords(req.query));
 api.get('/api/v1/admin/governance/records/:stableId',{preHandler:guard,schema:{...meta('getGovernanceRecord'),params,querystring:z.object({revision:z.coerce.number().int().min(1).optional()}),response:{200:G.record,...responses}}},async req=>store.getRecord(req.params.stableId,req.query.revision));
 api.get('/api/v1/admin/governance/records/:stableId/versions',{preHandler:guard,schema:{...meta('governanceVersionHistory'),params,querystring:G.historyQuery,response:{200:pageOf(G.versionSummary),...responses}}},async req=>store.versions(req.params.stableId,req.query));
 api.post('/api/v1/admin/governance/records/:stableId/revisions',{preHandler:guard,schema:{...meta('amendGovernanceRecord'),params,body:G.revisionInput,response:{201:G.record,...responses}}},async(req,reply)=>{reply.code(201);return store.amend(req.params.stableId,req.body,req.actor!,req.id);});
 api.post('/api/v1/admin/governance/records/:stableId/review',{preHandler:guard,schema:{...meta('reviewGovernanceRecord'),params,body:G.reviewInput,response:{200:G.record,...responses}}},async req=>store.review(req.params.stableId,req.body,req.actor!,req.cookies.onesa_session!,req.id));
 api.patch('/api/v1/admin/governance/records/:stableId/archive',{preHandler:guard,schema:{...meta('archiveGovernanceRecord'),params,body:z.object({expectedRevision:z.number().int().min(1),archived:z.boolean()}).strict(),response:{200:G.record,...responses}}},async req=>store.archive(req.params.stableId,req.body.expectedRevision,req.body.archived,req.actor!,req.id));
 api.get('/api/v1/admin/governance/events',{preHandler:guard,schema:{...meta('governanceReviewEvents'),querystring:z.object({stableId:G.stableId.optional()}),response:{200:z.object({items:z.array(G.event)}),...responses}}},async req=>store.events(req.query.stableId));
 api.get('/api/v1/admin/governance/records/:stableId/pdf',{preHandler:guard,schema:{...meta('downloadGovernancePdf'),produces:['application/pdf'],params,querystring:z.object({revision:z.coerce.number().int().min(1).optional()}),response:{200:z.string().meta({format:'binary'}),...responses}}},async(req,reply)=>{
  const record=await store.getRecord(req.params.stableId,req.query.revision),v=record.version;
  const body=v.payload.type==='document'?v.payload.markdown:Object.entries(v.payload).filter(([key])=>key!=='type').map(([key,value])=>`## ${key}\n${typeof value==='string'?value:JSON.stringify(value,null,2)}`).join('\n\n');
  const status=v.status==='approved'?`INTERNAL · APPROVED · ${v.approvedAt}`:'INTERNAL · DRAFT — NOT APPROVED';
  const interpretation=v.interpretationIssues.length?`\n\n## Unresolved duration interpretation\n${v.interpretationIssues.map(issue=>'- '+issue).join('\n')}`:'';
  const bytes=await generatePDF(v.title,`Record ${record.stableId}\nVersion ${v.versionLabel} · Revision ${v.revision}\n${status}${interpretation}\n\n${body}`,{version:v.revision,status});
  await audit(req.actor!.id,'governance.pdf_downloaded',record.stableId,req.id);
  reply.header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="${record.stableId}-r${v.revision}.pdf"`).header('X-Content-Type-Options','nosniff').type('application/pdf');
  return (reply as FastifyReply).send(bytes);
 });
}
