import pg from 'pg';
import { env } from '../config/env.js';
export const db = new pg.Pool({ connectionString:env.DATABASE_URL, max:10, connectionTimeoutMillis:5000, statement_timeout:10000 });
export async function transaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> { const client=await db.connect(); try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
export async function audit(actor:string|null, action:string, record:string|null=null, request:string|null=null) { await db.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)',[actor,action,record,request]); }

export async function pagedQuery(sql:string,args:unknown[]){const result=await db.query(sql,args);let total=Number(result.rows[0]?.total||0);if(!result.rows.length){const countSql=sql.replace(/^SELECT \*,count\(\*\) OVER\(\) AS total/i,'SELECT count(*) AS total').replace(/ ORDER BY[\s\S]+$/i,'');total=Number((await db.query(countSql,args.slice(0,-2))).rows[0].total);}return {...result,total};}
