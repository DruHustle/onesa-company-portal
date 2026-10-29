import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {request} from '@playwright/test';
import {assertExactOrigin,establishPreviewSession} from './oracle_portal_browser.mjs';
test('preview credential cannot follow an actual foreign redirect',async()=>{
 let foreign=0;const end=http.createServer((_q,s)=>{foreign++;s.end('foreign');});await new Promise(r=>end.listen(0,'127.0.0.1',r));
 const start=http.createServer((q,s)=>{assert.equal(q.headers['x-vercel-protection-bypass'],'synthetic-only');s.writeHead(302,{location:`http://127.0.0.1:${end.address().port}/`});s.end();});await new Promise(r=>start.listen(0,'127.0.0.1',r));
 const api=await request.newContext();
 try{await assert.rejects(establishPreviewSession({request:api},`http://127.0.0.1:${start.address().port}`,'synthetic-only'),/Foreign origin/);assert.equal(foreign,0);}
 finally{await api.dispose();await Promise.all([new Promise(r=>start.close(r)),new Promise(r=>end.close(r))]);}
});
test('provider cookie is host-scoped and unneeded access makes no request',async()=>{
 let installed,cleared=false;const origin='https://approved.vercel.app';
 const context={request:{get:async(url,args)=>{assert.equal(url,origin);assert.equal(args.maxRedirects,0);return {status:()=>307,headers:()=>({location:'/'})};}},cookies:async()=>[{name:'_vercel_jwt',value:'synthetic',secure:true,domain:'.vercel.app'}],clearCookies:async()=>{cleared=true;},addCookies:async values=>{installed=values;}};
 await establishPreviewSession(context,origin,'synthetic-only');assert.equal(cleared,true);assert.deepEqual(installed,[{name:'_vercel_jwt',value:'synthetic',url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
 await establishPreviewSession({},origin,null);
 for(const url of ['https://vercel.com/login','https://approved.vercel.app.attacker.test','http://approved.vercel.app','https://approved.vercel.app:444'])assert.throws(()=>assertExactOrigin(url,origin),/Foreign origin/);
});
