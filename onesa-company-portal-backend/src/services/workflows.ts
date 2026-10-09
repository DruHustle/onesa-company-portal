import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { db } from './db.js';
import { env } from '../config/env.js';
import { templates } from '../documents/templates.js';
export async function seedTemplates(){for(const [key,t] of Object.entries(templates))await db.query('INSERT INTO templates(key,title,locale,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[key,t.title,t.locale,t.body]);}
export async function enqueue(c:pg.PoolClient,key:string,payload:object,kind='email'){await c.query('INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),kind,key,JSON.stringify(payload)]);}
export async function releaseReady(requirePages=true){const facts=await db.query("SELECT key FROM facts WHERE key=ANY($1) AND status='verified' AND value IS NOT NULL",[['legal_name','register_number','register_court','director','address','contact_email']]);const legal=(await db.query("SELECT value FROM settings WHERE key='legal'")).rows[0]?.value;const pages=await db.query("SELECT count(*) FROM content WHERE kind='page' AND slug IN ('impressum','privacy') AND locale IN ('en','de') AND state='published' AND length(body)>200");return (!requirePages||Number(pages.rows[0].count)===4)&&facts.rowCount===6&&legal?.impressumApproved===true&&legal?.privacyApproved===true&&legal?.recruitmentApproved===true&&legal?.providersReviewed===true&&env.PUBLISH_ENABLED==='true';}
export const notify=(subject:string,text:string)=>({to:env.NOTIFY_EMAIL||null,subject,text});
export function normalize<T>(value:unknown):T{return JSON.parse(JSON.stringify(value));}
export class HttpError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
export const required=<T>(value:T|undefined):T=>{if(value===undefined)throw new HttpError(404,'NOT_FOUND','Record not found');return value;};
