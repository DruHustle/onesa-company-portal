import '../security/tls-trust.js';
import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import { env } from '../config/env.js';
const pool = new pg.Pool({ connectionString:env.DATABASE_URL, max:10, connectionTimeoutMillis:5000, statement_timeout:10000 });
const context=new AsyncLocalStorage<pg.PoolClient>();
// Transfer finalization and its existing route handler share a transaction.
// Other requests retain the original pool behavior; context never comes from HTTP input.
export const db=new Proxy(pool,{get(target,property){if(property==='query'&&context.getStore())return context.getStore()!.query.bind(context.getStore()!);const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
export const inTransaction=<T>(client:pg.PoolClient,fn:()=>Promise<T>)=>context.run(client,fn);
export async function transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> { const shared=context.getStore();if(shared){await shared.query('SAVEPOINT route_operation');try{const result=await fn(shared);await shared.query('RELEASE SAVEPOINT route_operation');return result;}catch(error){await shared.query('ROLLBACK TO SAVEPOINT route_operation');throw error;}}const client=await pool.connect(); try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
export async function audit(actor:string|null, action:string, record:string|null=null, request:string|null=null) { await db.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)',[actor,action,record,request]); }

export async function pagedQuery(sql:string,args:unknown[]){const result=await db.query(sql,args);let total=Number(result.rows[0]?.total||0);if(!result.rows.length){const countSql=sql.replace(/^SELECT \*,count\(\*\) OVER\(\) AS total/i,'SELECT count(*) AS total').replace(/ ORDER BY[\s\S]+$/i,'');total=Number((await db.query(countSql,args.slice(0,-2))).rows[0].total);}return {...result,total};}
