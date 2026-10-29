// Real application renderer; no provider, database, credentials or form submission.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,copyFile,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {chromium,firefox,webkit} from '@playwright/test';
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(await stat(name).then(()=>true,()=>false),false,'Private environment refused');
const temp=await mkdtemp(join(tmpdir(),'onesa-owner-drone-'));await copyFile(resolve('../scripts/release/oracle_portal_browser.mjs'),join(temp,'oracle_portal_browser.mjs'));await symlink(resolve('node_modules'),join(temp,'node_modules'),'dir');
const {visitDroneProduct}=await import(pathToFileURL(join(temp,'oracle_portal_browser.mjs')).href);
let mutations=0;const backend=http.createServer((q,s)=>{if(!['GET','HEAD'].includes(q.method))mutations++;s.setHeader('Content-Type','application/json');s.writeHead(q.url.startsWith('/api/v1/admin')||q.url==='/api/v1/auth/me'?401:404).end('{}');});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p','3349'],{env:{...process.env,PUBLIC_RELEASE_ENABLED:'false',BACKEND_URL:`http://127.0.0.1:${backend.address().port}`,SITE_URL:'http://127.0.0.1:3349'},stdio:'ignore'});
try{
 let ready=false;for(let i=0;i<60;i++){if(await fetch('http://127.0.0.1:3349/en/products/onesa-drone').then(r=>r.ok,()=>false)){ready=true;break;}await delay(500);}assert.equal(ready,true);
 const observations=[],failures=[];
 for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
  let browser;try{browser=await type.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:900},colorScheme:'dark',reducedMotion:'reduce'});const page=await context.newPage();let films=0;page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('.mp4'))films++;});for(const locale of ['en','de'])for(const [width,mode]of [[390,'dark'],[1440,'light'],[320,'light']]){await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode});observations.push(await visitDroneProduct(page,{origin:'http://127.0.0.1:3349'},{engine,locale,width,mode,motionRequests:()=>films}));}}catch(error){failures.push({engine,reason:error.name});console.error(engine+': '+String(error.message).slice(0,180));}finally{await browser?.close();}
 }
 assert.equal(mutations,0);console.log(JSON.stringify({status:'LOCAL_SYNTHETIC_NOT_HOSTED',observations,failures,operational_mutations:0}));assert.deepEqual(failures,[],'Every required engine must pass');
}finally{server.kill('SIGTERM');backend.closeAllConnections();await new Promise(r=>backend.close(r));await rm(temp,{recursive:true,force:true});}
