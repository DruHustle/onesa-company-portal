import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import type {Role} from '../access/roles.js';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt,hash,token} from '../auth/crypto.js';
import {db,transaction,inTransaction} from './db.js';
import {HttpError} from './workflows.js';
import {error as errorSchema} from '../api/contracts.js';
import {env,companyOrigin} from '../config/env.js';
const errors={400:errorSchema,401:errorSchema,403:errorSchema,404:errorSchema,409:errorSchema,413:errorSchema,429:errorSchema,500:errorSchema,503:errorSchema};
const id=z.uuid();
const proof=z.object({ticket:z.string().regex(/^[a-f0-9]{64}$/)});
const sum=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

export function transfers(app:FastifyInstance, hooks:{allow:(roles:readonly Role[])=> (req:FastifyRequest)=>Promise<void>;fileRoles:readonly Role[];address:(req:FastifyRequest)=>string;publication:()=>Promise<void>;limit:(key:string,max:number,seconds:number)=>Promise<void>}){
 const api=app.withTypeProvider<ZodTypeProvider>();
 for(const scope of ['application','document'] as const){
  const prefix=scope==='application'?'/api/v1/public/transfers':'/api/v1/admin/transfers';
  const target=scope==='application'?'/api/v1/public/applications':'/api/v1/admin/files';
  const preHandler=async(req:FastifyRequest)=>{const origin=req.headers.origin;if(!origin||(origin!==env.PUBLIC_ORIGIN&&!(scope==='application'&&origin===companyOrigin)))throw new HttpError(403,'ORIGIN','Untrusted origin');if(scope==='document')await hooks.allow(hooks.fileRoles)(req);else await hooks.publication();await hooks.limit('transfer:'+hooks.address(req),120,60);};
  const schema={tags:['Bounded file transport'],security:scope==='application'?[]:[{sessionCookie:[]}]};
  api.post(prefix,{preHandler,schema:{...schema,operationId:scope+'TransferStart',body:z.object({size:z.number().int().min(1).max(15*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),response:{201:z.object({id,ticket:z.string(),chunkBytes:z.number()}),...errors}}},async(req,reply)=>{
   const identifier=randomUUID(),ticket=token(),peer=hash(hooks.address(req));
   await transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['transfer:'+peer]);await c.query('DELETE FROM bounded_transfers WHERE expires_at<now()');await c.query('SELECT pg_advisory_xact_lock(757836)');const global=Number((await c.query('SELECT count(*) FROM bounded_transfers WHERE result IS NULL')).rows[0].count);if(global>=100)throw new HttpError(429,'TRANSFER_QUOTA','Upload capacity is currently full');const n=Number((await c.query('SELECT count(*) FROM bounded_transfers WHERE peer_hash=$1 AND result IS NULL',[peer])).rows[0].count);if(n>=4)throw new HttpError(429,'TRANSFER_QUOTA','Too many unfinished uploads');await c.query('INSERT INTO bounded_transfers(id,owner_id,peer_hash,capability_hash,scope,expected_bytes,checksum) VALUES($1,$2,$3,$4,$5,$6,$7)',[identifier,req.actor?.id||null,peer,hash(ticket),scope,req.body.size,req.body.sha256]);});
   reply.code(201);return {id:identifier,ticket,chunkBytes:512*1024};
  });
  async function owned(req:FastifyRequest,identifier:string,ticket:string){const r=(await db.query('SELECT * FROM bounded_transfers WHERE id=$1 AND scope=$2 AND capability_hash=$3 AND peer_hash=$4 AND expires_at>now() FOR UPDATE',[identifier,scope,hash(ticket),hash(hooks.address(req))])).rows[0];if(!r||(scope==='document'&&r.owner_id!==req.actor?.id))throw new HttpError(404,'TRANSFER','Upload not found or expired');return r;}
  api.post(prefix+'/:id/chunks',{preHandler,schema:{...schema,operationId:scope+'TransferChunk',params:z.object({id}),body:proof.extend({sequence:z.number().int().min(0).max(30),base64:z.string().min(4).max(699052).regex(/^[A-Za-z0-9+/]+={0,2}$/)}),response:{200:z.object({received:z.number()}),...errors}}},async req=>transaction(async c=>inTransaction(c,async()=>{
   const r=await owned(req,req.params.id,req.body.ticket);const bytes=Buffer.from(req.body.base64,'base64');if(bytes.length>512*1024||bytes.toString('base64')!==req.body.base64)throw new HttpError(413,'TRANSFER_SIZE','Invalid upload chunk');
   const previous=(await c.query('SELECT checksum FROM bounded_transfer_chunks WHERE transfer_id=$1 AND sequence=$2',[r.id,req.body.sequence])).rows[0];if(previous&&previous.checksum===sum(bytes))return {received:r.cursor};
   const count=Number((await c.query('SELECT count(*) FROM bounded_transfer_chunks WHERE transfer_id=$1',[r.id])).rows[0].count);
   if(r.cursor+bytes.length<r.expected_bytes&&bytes.length!==512*1024)throw new HttpError(400,'TRANSFER_SIZE','Non-final chunks must have the announced size');if(r.result||req.body.sequence!==count||r.cursor+bytes.length>r.expected_bytes)throw new HttpError(409,'TRANSFER_ORDER','Upload chunk is out of order');
   await c.query('INSERT INTO bounded_transfer_chunks VALUES($1,$2,$3,$4)',[r.id,count,encrypt(req.body.base64),sum(bytes)]);await c.query('UPDATE bounded_transfers SET cursor=cursor+$1 WHERE id=$2',[bytes.length,r.id]);return {received:r.cursor+bytes.length};
  })));
  api.post(prefix+'/:id/complete',{preHandler,schema:{...schema,operationId:scope+'TransferComplete',params:z.object({id}),body:proof,response:{200:z.object({status:z.number(),body:z.unknown()}),...errors}}},async req=>transaction(async c=>inTransaction(c,async()=>{
   const r=await owned(req,req.params.id,req.body.ticket);if(r.result)return {status:r.result_status,body:r.result};if(r.cursor!==r.expected_bytes)throw new HttpError(409,'TRANSFER_INCOMPLETE','Upload is incomplete');
   const rows=(await c.query('SELECT encrypted_payload FROM bounded_transfer_chunks WHERE transfer_id=$1 ORDER BY sequence',[r.id])).rows;
   const data=Buffer.concat(rows.map(row=>Buffer.from(decrypt(row.encrypted_payload),'base64')));if(sum(data)!==r.checksum)throw new HttpError(400,'TRANSFER_CHECKSUM','Upload integrity check failed');
   let payload;try{payload=JSON.parse(data.toString('utf8'));}catch{throw new HttpError(400,'TRANSFER_BODY','Invalid upload request');}
   const headers={...req.headers,'content-type':'application/json','content-length':String(data.length)};
   const response=await app.inject({method:'POST',url:target,headers,payload,remoteAddress:req.ip});const body=response.json();
   await c.query('UPDATE bounded_transfers SET result=$1,result_status=$2 WHERE id=$3',[JSON.stringify(body),response.statusCode,r.id]);await c.query('DELETE FROM bounded_transfer_chunks WHERE transfer_id=$1',[r.id]);return {status:response.statusCode,body};
  })));
  api.post(prefix+'/:id/cancel',{preHandler,schema:{...schema,operationId:scope+'TransferCancel',params:z.object({id}),body:proof,response:{200:z.object({cancelled:z.literal(true)}),...errors}}},async req=>transaction(async c=>inTransaction(c,async()=>{const r=await owned(req,req.params.id,req.body.ticket);if(r.result)throw new HttpError(409,'TRANSFER_COMPLETE','Upload already finalized');await c.query('DELETE FROM bounded_transfers WHERE id=$1',[r.id]);return {cancelled:true as const};})));
 }
}
