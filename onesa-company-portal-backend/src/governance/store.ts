import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {db,transaction} from '../services/db.js';
import {HttpError,required,normalize} from '../services/workflows.js';
import {reauthenticate} from '../auth/reauthenticate.js';
import type {Actor} from '../access/roles.js';
import * as G from './schemas.js';

export const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selection=`SELECT r.*, (SELECT max(e.created_at) FROM governance_events e WHERE e.record_id=r.stable_id AND e.action LIKE 'review.%') AS last_reviewed_at, v.revision,v.version_label,v.title,v.owner,v.product_scopes,v.payload,v.evidence_refs,v.status,v.source_fingerprint,v.source_file,v.created_by,v.created_at AS version_created_at,v.review_due_at,v.effective_at,v.approved_by,v.approved_email,v.approved_role,v.approved_at,v.approval_scope,v.approval_evidence_refs FROM governance_records r JOIN governance_versions v ON v.record_id=r.stable_id AND v.revision=coalesce($2::integer,r.current_revision)`;
export function asRecord(raw:unknown):z.infer<typeof G.record>{
 const r=normalize<Record<string,unknown>>(raw);
 const displayStatus=r.archived?'archived':r.status==='approved'&&typeof r.effective_revision==='number'&&Number(r.revision)<r.effective_revision?'superseded':r.status;
 return G.record.parse({stableId:r.stable_id,kind:r.kind,documentId:r.document_id,classification:r.classification,currentRevision:r.current_revision,effectiveRevision:r.effective_revision,archived:r.archived,createdAt:r.created_at,updatedAt:r.updated_at,lastReviewedAt:r.last_reviewed_at??null,version:{recordId:r.stable_id,revision:r.revision,versionLabel:r.version_label,title:r.title,owner:r.owner,productScopes:r.product_scopes,payload:r.payload,evidenceRefs:r.evidence_refs,status:r.status,sourceFingerprint:r.source_fingerprint,sourceFile:r.source_file,createdBy:r.created_by,createdAt:r.version_created_at,reviewDueAt:r.review_due_at,effectiveAt:r.effective_at,approvedBy:r.approved_by,approvedEmail:r.approved_email,approvedRole:r.approved_role,approvedAt:r.approved_at,approvalScope:r.approval_scope,approvalEvidenceRefs:r.approval_evidence_refs,displayStatus}});
}
export async function getRecord(stableId:string,revision?:number,connection:Pick<PoolClient,'query'>=db){
 return asRecord(required((await connection.query(selection+' WHERE r.stable_id=$1',[stableId,revision??null])).rows[0]));
}
export async function listRecords(q:z.infer<typeof G.query>){
 const values=[q.kind??null,q.status??null,q.product??null,q.archived==='true',q.search];
 const where=`WHERE ($1::text IS NULL OR r.kind=$1) AND ($2::text IS NULL OR v.status=$2) AND ($3::text IS NULL OR $3=ANY(v.product_scopes)) AND r.archived=$4 AND (r.stable_id ILIKE '%'||$5||'%' OR v.title ILIKE '%'||$5||'%')`;
 const from=' FROM governance_records r JOIN governance_versions v ON v.record_id=r.stable_id AND v.revision=r.current_revision ';
 const count=Number((await db.query('SELECT count(*) AS total'+from+where,values)).rows[0].total);
 const rows=(await db.query('SELECT r.*,v.*,(SELECT max(e.created_at) FROM governance_events e WHERE e.record_id=r.stable_id AND e.action LIKE \'review.%\') AS last_reviewed_at,r.created_at AS created_at,v.created_at AS version_created_at'+from+where+' ORDER BY r.kind,r.stable_id OFFSET $6 LIMIT $7',[...values,(q.page-1)*q.limit,q.limit])).rows;
 return {items:rows.map(asRecord),page:q.page,limit:q.limit,total:count};
}
export async function versions(stableId:string,q:z.infer<typeof G.historyQuery>){
 await getRecord(stableId);
 const total=Number((await db.query('SELECT count(*) AS n FROM governance_versions WHERE record_id=$1',[stableId])).rows[0].n);
 const rows=(await db.query('SELECT r.*,v.*,(SELECT max(e.created_at) FROM governance_events e WHERE e.record_id=r.stable_id AND e.action LIKE \'review.%\') AS last_reviewed_at,r.created_at AS created_at,v.created_at AS version_created_at FROM governance_records r JOIN governance_versions v ON v.record_id=r.stable_id WHERE r.stable_id=$1 ORDER BY v.revision DESC OFFSET $2 LIMIT $3',[stableId,(q.page-1)*q.limit,q.limit])).rows;
 return {items:rows.map(row=>G.versionSummary.strip().parse(asRecord(row).version)),page:q.page,limit:q.limit,total};
}
export async function recordEvent(c:PoolClient,id:string,revision:number,action:string,actor:Actor|null,note='',scope='',refs:string[]=[],requestId?:string){
 await c.query('INSERT INTO governance_events(record_id,revision,actor_id,actor_email,actor_role,action,note,scope,evidence_refs,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,revision,actor?.id??null,actor?.email??null,actor?.role??null,action,note,scope,refs,requestId??null]);
 await c.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)',[actor?.id??null,'governance.'+action,id,requestId??null]);
}
export async function insertVersion(c:PoolClient,id:string,revision:number,input:G.Snapshot,actor:Actor|null,sourceFile:string|null=null){
 await c.query('INSERT INTO governance_versions(record_id,revision,version_label,title,owner,product_scopes,payload,evidence_refs,source_fingerprint,source_file,created_by,review_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,revision,input.versionLabel,input.title,input.owner,input.productScopes,JSON.stringify(input.payload),input.evidenceRefs,fingerprint(input),sourceFile,actor?.id??null,input.reviewDueAt]);
}
async function locked(c:PoolClient,id:string,expected:number){
 const row=required((await c.query('SELECT * FROM governance_records WHERE stable_id=$1 FOR UPDATE',[id])).rows[0]);
 if(row.current_revision!==expected)throw new HttpError(409,'REVISION','This record changed. Reload before saving.');
 return row;
}
export async function amend(id:string,input:z.infer<typeof G.revisionInput>,actor:Actor,requestId:string){
 return transaction(async c=>{
  const old=await locked(c,id,input.expectedRevision);
  if(old.archived)throw new HttpError(409,'ARCHIVED','Restore the archived record before amending it.');
  if(input.payload.type!==old.kind)throw new HttpError(400,'KIND','Record type cannot change.');
  const {expectedRevision,...draft}=input;
  const next=expectedRevision+1,snapshot=G.snapshot.parse(draft);
  await insertVersion(c,id,next,snapshot,actor);
  await c.query('UPDATE governance_records SET current_revision=$2,updated_at=now() WHERE stable_id=$1',[id,next]);
  await recordEvent(c,id,next,'revision.created',actor,'New draft revision; prior versions retained.','Draft amendment',input.evidenceRefs,requestId);
  return getRecord(id,next,c);
 });
}
export async function review(id:string,input:z.infer<typeof G.reviewInput>,actor:Actor,sessionToken:string,requestId:string){
 if(['approved','rejected'].includes(input.verdict)&&actor.role!=='owner')throw new HttpError(403,'APPROVER','Only the authenticated owner may approve or reject a privacy decision.');
 return transaction(async c=>{
  const meta=await locked(c,id,input.expectedRevision);
  if(meta.archived)throw new HttpError(409,'ARCHIVED','Archived records cannot be reviewed.');
  const old=await getRecord(id,input.expectedRevision,c);
  if(old.version.status==='approved')throw new HttpError(409,'IMMUTABLE','Approved versions are immutable. Create an amendment.');
  if(['approved','rejected'].includes(input.verdict)){
   const role=await reauthenticate(c,{userId:actor.id,token:sessionToken,csrf:actor.csrf},input.stepUp);
   if(role!=='owner')throw new HttpError(403,'APPROVER','Owner approval required.');
  }
  if(input.verdict==='approved'){
   await c.query("UPDATE governance_versions SET status='approved',approved_by=$3,approved_email=$4,approved_role='owner',approved_at=now(),effective_at=$5,review_due_at=$6,approval_scope=$7,approval_evidence_refs=$8 WHERE record_id=$1 AND revision=$2",[id,input.expectedRevision,actor.id,actor.email,input.effectiveAt,input.reviewDueAt,input.scope,input.evidenceRefs]);
   await c.query('UPDATE governance_records SET effective_revision=$2,updated_at=now() WHERE stable_id=$1',[id,input.expectedRevision]);
  }else{
   await c.query('UPDATE governance_versions SET status=$3,review_due_at=$4 WHERE record_id=$1 AND revision=$2',[id,input.expectedRevision,input.verdict,input.reviewDueAt]);
   await c.query('UPDATE governance_records SET updated_at=now() WHERE stable_id=$1',[id]);
  }
  await recordEvent(c,id,input.expectedRevision,'review.'+input.verdict,actor,input.note,input.scope,input.evidenceRefs,requestId);
  // Approval records a scoped management decision. It never changes public/legal flags or worker settings.
  return getRecord(id,input.expectedRevision,c);
 });
}
export async function archive(id:string,expected:number,archived:boolean,actor:Actor,requestId:string){
 return transaction(async c=>{
  await locked(c,id,expected);await c.query('UPDATE governance_records SET archived=$2,updated_at=now() WHERE stable_id=$1',[id,archived]);
  await recordEvent(c,id,expected,archived?'record.archived':'record.restored',actor,'Version history and approval evidence retained.','Internal record lifecycle',[],requestId);
  return getRecord(id,undefined,c);
 });
}
export async function events(stableId?:string){
 const rows=(await db.query('SELECT * FROM governance_events WHERE ($1::text IS NULL OR record_id=$1) ORDER BY id DESC LIMIT 200',[stableId??null])).rows;
 return {items:rows.map(row=>G.event.parse(normalize({id:row.id,recordId:row.record_id,revision:row.revision,actorId:row.actor_id,actorEmail:row.actor_email,actorRole:row.actor_role,action:row.action,note:row.note,scope:row.scope,evidenceRefs:row.evidence_refs,createdAt:row.created_at})))};
}
export async function summary(){
 const row=(await db.query(`SELECT count(*) FILTER(WHERE r.kind='document')::int AS documents,count(*) FILTER(WHERE r.kind='document' AND v.status<>'approved')::int AS drafts,count(*) FILTER(WHERE r.kind='document' AND v.status='approved')::int AS approved,count(*) FILTER(WHERE r.kind='decision' AND v.status<>'approved')::int AS decisions,count(*) FILTER(WHERE r.kind='processor' AND v.status<>'approved')::int AS processors,count(*) FILTER(WHERE v.review_due_at<=now()+interval '30 days')::int AS reviews,count(*) FILTER(WHERE cardinality(v.evidence_refs)=0 AND cardinality(coalesce(v.approval_evidence_refs,'{}'))=0)::int AS missing FROM governance_records r JOIN governance_versions v ON v.record_id=r.stable_id AND v.revision=r.current_revision WHERE NOT r.archived`)).rows[0];
 return {documents:row.documents,draftDocuments:row.drafts,approvedDocuments:row.approved,decisionsAwaitingReview:row.decisions,processorAssessmentsPending:row.processors,upcomingReviews:row.reviews,missingEvidence:row.missing,automaticDeletionEnabled:false as const,publicPublicationEnabled:false as const,restrictions:['Draft proposals are not effective processing policies.','Record approval does not enable production deletion or publish privacy notices.','Provider hosting choices, DPA applicability and transfer decisions require separate scoped assessments.','Data subject request automation is deferred; use the existing privacy contact and documented controlled workflow.']};
}
