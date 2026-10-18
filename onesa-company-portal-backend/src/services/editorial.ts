import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {contentInput,publicContentMetadata} from '../api/schemas.js';
import {editorialReview} from '../api/contracts.js';
import type {Actor} from '../access/roles.js';
import {permitted,permissions} from '../access/roles.js';
import {transaction} from './db.js';
import {required,HttpError,enqueue,notify} from './workflows.js';

type ContentFields={kind:string;slug:string;locale:string;title:string;summary:string;body:string;metadata:unknown};
export function editorialDigest(row:ContentFields){
 const metadata=publicContentMetadata.parse(row.metadata);
 return createHash('sha256').update(JSON.stringify({kind:row.kind,slug:row.slug,locale:row.locale,title:row.title,summary:row.summary,body:row.body,metadata})).digest('hex');
}
const draftReview=()=>({status:'draft' as const,reviewedRevision:null,sourceRevision:null,digest:null,reviewedBy:null,reviewedAt:null,note:''});
export function editorialApproved(row:ContentFields&{revision:number}){
 const parsed=editorialReview.safeParse((row.metadata as {editorialReview?:unknown})?.editorialReview);
 return parsed.success&&parsed.data.status==='approved'&&parsed.data.reviewedRevision===row.revision&&parsed.data.digest===editorialDigest(row);
}
async function history(c:PoolClient,row:{id:string},actorId:string|null,action:string,requestId?:string){
 const snapshot={...row} as Record<string,unknown>;delete snapshot.published_snapshot;
 await c.query('INSERT INTO revisions(content_id,snapshot,actor_id) VALUES($1,$2,$3)',[row.id,JSON.stringify(snapshot),actorId]);
 await c.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)',[actorId,action,row.id,requestId??null]);
}
export async function createEditorialContent(b:z.infer<typeof contentInput>,actor:Actor,requestId:string){
 if(b.state==='published'||b.publishAt)throw new HttpError(409,'EDITORIAL_REVIEW','Save a draft and approve its exact revision before publishing or scheduling.');
 return transaction(async c=>{
  const metadata={...b.metadata,editorialReview:draftReview()};
  const row=required((await c.query('INSERT INTO content(id,kind,slug,locale,title,summary,body,metadata,state,publish_at,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[randomUUID(),b.kind,b.slug,b.locale,b.title,b.summary,b.body,metadata,b.state,b.publishAt||null,actor.id])).rows[0]);
  await history(c,row,actor.id,'content.created',requestId);return row;
 });
}
export async function updateEditorialContent(id:string,b:z.infer<typeof contentInput>&{revision:number},actor:Actor,requestId:string){
 return transaction(async c=>{
  const old=required((await c.query('SELECT * FROM content WHERE id=$1 FOR UPDATE',[id])).rows[0]);
  if(old.revision!==b.revision)throw new HttpError(409,'REVISION','Content changed. Reload before saving.');
  if((b.state==='published'||b.state==='archived'||b.publishAt)&&!permitted(actor.role,permissions.publish))throw new HttpError(403,'PUBLISH','Publisher role required for published or scheduled content.');
  const same=editorialDigest(old)===editorialDigest(b),approved=editorialApproved(old)&&same;
  if((b.state==='published'||b.publishAt)&&!approved)throw new HttpError(409,'EDITORIAL_REVIEW','Approve this exact content revision before publishing or scheduling; edited text requires a new review.');
  if(old.state==='published'&&!old.published_snapshot)await capturePublication(c,id);
  const next=old.revision+1,state=b.state==='published'&&b.publishAt&&Date.parse(b.publishAt)>Date.now()?'draft':b.state;
  const metadata={...b.metadata,...old.metadata.publishedAt?{publishedAt:old.metadata.publishedAt}:{},editorialReview:approved?{...old.metadata.editorialReview,reviewedRevision:next}:draftReview()};
  if(state==='published')metadata.publishedAt=old.metadata.publishedAt??new Date().toISOString();
  const row=required((await c.query('UPDATE content SET kind=$1,slug=$2,locale=$3,title=$4,summary=$5,body=$6,metadata=$7,state=$8,publish_at=$9,revision=revision+1,updated_at=now() WHERE id=$10 RETURNING *',[b.kind,b.slug,b.locale,b.title,b.summary,b.body,metadata,state,b.publishAt||null,id])).rows[0]);
  if(state==='published')await capturePublication(c,row.id);
  if(state==='archived')await c.query('UPDATE content SET published_snapshot=NULL WHERE id=$1',[id]);
  await history(c,row,actor.id,'content.updated',requestId);
  if(state==='published')await enqueue(c,'publish:'+row.id+':'+row.revision,notify('Content publication',b.title));return row;
 });
}
export const editorialReviewInput=z.object({expectedRevision:z.number().int().positive(),verdict:z.enum(['pending_review','approved','needs_changes']),note:z.string().min(10).max(4000)}).strict();
export async function reviewEditorialContent(id:string,input:z.infer<typeof editorialReviewInput>,actor:Actor,requestId:string){
 if(input.verdict==='approved'&&!permitted(actor.role,permissions.publish))throw new HttpError(403,'PUBLISH','Publisher role required to approve editorial content.');
 return transaction(async c=>{
  const old=required((await c.query('SELECT * FROM content WHERE id=$1 FOR UPDATE',[id])).rows[0]);
  if(old.revision!==input.expectedRevision)throw new HttpError(409,'REVISION','Content changed. Reload before reviewing.');
  if(old.state==='archived')throw new HttpError(409,'ARCHIVED','Restore this content as a draft before review.');
  if(input.verdict==='approved'&&old.metadata.imageId){
   if(!old.metadata.imageAlt?.trim()||!old.metadata.imageRights?.trim())throw new HttpError(409,'MEDIA_REVIEW','Record meaningful image alt text and public-safe rights/source before approval.');
   const media=await c.query("SELECT id FROM files WHERE id=$1 AND classification='public' AND approval='approved' AND scan_status='clean' AND NOT archived AND mime IN ('image/png','image/jpeg','image/webp') FOR SHARE",[old.metadata.imageId]);
   if(!media.rowCount)throw new HttpError(409,'MEDIA_REVIEW','Select an approved, clean public image before approving this content.');
  }
  const next=old.revision+1,approved=input.verdict==='approved';
  const review={status:input.verdict,reviewedRevision:approved?next:null,sourceRevision:old.revision,digest:approved?editorialDigest(old):null,reviewedBy:actor.id,reviewedAt:new Date().toISOString(),note:input.note};
  const row=required((await c.query('UPDATE content SET metadata=$2,revision=$3,updated_at=now() WHERE id=$1 RETURNING *',[id,{...old.metadata,editorialReview:review},next])).rows[0]);
  await history(c,row,actor.id,'content.review.'+input.verdict,requestId);return row;
 });
}
export async function publishScheduledContent(c:PoolClient,id:string){
 const old=(await c.query("SELECT * FROM content WHERE id=$1 AND state='draft' AND publish_at<=now() FOR UPDATE SKIP LOCKED",[id])).rows[0];
 if(!old||!editorialApproved(old))return;
 const metadata={...old.metadata,publishedAt:old.metadata.publishedAt??new Date().toISOString(),editorialReview:{...old.metadata.editorialReview,reviewedRevision:old.revision+1}};
 const row=required((await c.query("UPDATE content SET state='published',metadata=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[id,metadata])).rows[0]);
 await capturePublication(c,row.id);
 await history(c,row,null,'content.scheduled_publish');await enqueue(c,'publish:'+row.id+':'+row.revision,notify('Scheduled publication',row.title));
}

// The row lock held by every caller binds publication to the reviewed revision.
async function capturePublication(c:PoolClient,id:string){
 await c.query("UPDATE content c SET published_snapshot=to_jsonb(c)-'published_snapshot' WHERE id=$1",[id]);
}
export async function unpublishEditorialContent(id:string,expectedRevision:number,actor:Actor,requestId:string){
 if(!permitted(actor.role,permissions.publish))throw new HttpError(403,'PUBLISH','Publisher role required.');
 return transaction(async c=>{
  const old=required((await c.query('SELECT * FROM content WHERE id=$1 FOR UPDATE',[id])).rows[0]);
  if(old.revision!==expectedRevision)throw new HttpError(409,'REVISION','Content changed. Reload before unpublishing.');
  const row=required((await c.query("UPDATE content SET published_snapshot=NULL,state='draft',publish_at=NULL,metadata=jsonb_set(metadata,'{editorialReview}',$2::jsonb),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[id,JSON.stringify(draftReview())])).rows[0]);
  await history(c,row,actor.id,'content.unpublished',requestId);return row;
 });
}
