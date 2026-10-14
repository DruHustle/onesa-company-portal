import { z } from 'zod';
import { locale,id,publicContentMetadata } from './schemas.js';
export const error=z.object({error:z.object({code:z.string(),message:z.string(),requestId:z.string()})});
export const ok=z.object({ok:z.literal(true)});
export const query=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20),search:z.string().max(200).default(''),status:z.string().max(30).optional(),kind:z.enum(['page','product','article','job','research','section']).optional(),locale:locale.optional(),category:z.string().max(100).optional()});
export const idParams=z.object({id});
export const user=z.object({id,email:z.email(),role:z.enum(['owner','administrator','editor','business','hr','viewer']),disabled:z.boolean(),created_at:z.string()});
export const editorialReview=z.object({status:z.enum(['draft','pending_review','approved','needs_changes']),reviewedRevision:z.number().int().nullable(),sourceRevision:z.number().int().nullable(),digest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),reviewedBy:id.nullable(),reviewedAt:z.string().nullable(),note:z.string()});
export const content=z.object({id,kind:z.enum(['page','product','article','job','research','section']),slug:z.string(),locale,title:z.string(),summary:z.string(),body:z.string(),metadata:publicContentMetadata.extend({publishedAt:z.string().optional(),editorialReview:editorialReview.optional()}),state:z.enum(['draft','published','archived']),publish_at:z.string().nullable(),author_id:id.nullable(),revision:z.number(),updated_at:z.string()});
export const enquiry=z.object({id,category:z.enum(['general','enterprise','partnership','research','media']),name:z.string(),email:z.email(),organization:z.string(),message:z.string(),locale,status:z.enum(['new','active','closed']),owner_id:id.nullable(),notes:z.string(),follow_up_at:z.string().nullable(),consent_at:z.string(),created_at:z.string()});
export const application=z.object({id,job_id:id,name:z.string(),email:z.email(),message:z.string(),file_id:id,status:z.enum(['new','review','interview','rejected','hired']),notes:z.string(),consent_at:z.string(),delete_after:z.string(),created_at:z.string()});
export const file=z.object({id,filename:z.string(),mime:z.string(),size:z.number(),sha256:z.string(),classification:z.enum(['public','internal','confidential','applicant']),scan_status:z.enum(['quarantine','clean','rejected']),approval:z.enum(['pending','approved','rejected']),version:z.number(),title:z.string(),owner_id:id.nullable(),review_at:z.string().nullable(),association:z.string().nullable(),created_at:z.string(),parent_id:id.nullable(),archived:z.boolean()});
export const auditRecord=z.object({id:z.coerce.number(),actor_id:id.nullable(),action:z.string(),record_id:z.string().nullable(),request_id:z.string().nullable(),created_at:z.string()});
export const fact=z.object({key:z.string(),value:z.string().nullable(),status:z.enum(['supplied','verified','missing']),source:z.string(),verified_by:id.nullable(),verified_at:z.string().nullable()});
export const template=z.object({key:z.string(),title:z.string(),locale,body:z.string(),status:z.enum(['draft','approved','archived']),version:z.number()});
export const pageOf=<T extends z.ZodType>(schema:T)=>z.object({items:z.array(schema),page:z.number(),limit:z.number(),total:z.number()});
export const upload=z.object({filename:z.string().min(1).max(180).regex(/^[a-zA-Z0-9._ -]+\.(pdf|png|jpe?g|webp)$/i),base64:z.string().min(16).max(13981016).regex(/^[A-Za-z0-9+/]+={0,2}$/),title:z.string().min(1).max(200),classification:z.enum(['public','internal','confidential']).default('internal'),reviewAt:z.string().datetime().nullable().optional(),association:z.string().max(200).optional(),parentId:id.optional()});
export const templateKey=z.object({key:z.string().regex(/^[a-z0-9-]+$/).max(100)});

export const publicContent=content.omit({author_id:true,publish_at:true,revision:true,state:true}).extend({metadata:publicContentMetadata.extend({publishedAt:z.string().optional()})});
export const publicFile=file.pick({id:true,filename:true,mime:true,size:true,title:true,version:true,created_at:true});

export const factKey=z.object({key:z.string().regex(/^[a-z0-9_-]+$/).max(100)});

export const publicFact=fact.pick({key:true,value:true,status:true,verified_at:true});

export const reauthentication=z.object({password:z.string().min(1).max(256),code:z.string().min(6).max(64)});
