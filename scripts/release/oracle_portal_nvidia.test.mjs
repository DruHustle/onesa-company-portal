// Exercise the actual observer against an isolated production build. These
// loopback observations are LOCAL_SYNTHETIC_NOT_HOSTED and confer no authority.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {chromium,firefox,webkit} from '@playwright/test';
import {observeNvidia} from './oracle_portal_nvidia.mjs';
import {checkUI} from './oracle_portal_browser.mjs';
import {PROFILE,CONTRACT,digest,retainPublicTextDiagnostics} from './oracle_portal_nvidia_contract.mjs';

const root=process.env.ONESA_SOURCE_ROOT;
assert.ok(root&&path.isAbsolute(root),'Explicit isolated source checkout required');
const cwd=path.join(root,'onesa-company-portal-frontend');
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(fs.existsSync(path.join(cwd,name)),false);
let backend,server,origin,directory;
before(async()=>{
 backend=http.createServer((_request,response)=>response.writeHead(404,{'Content-Type':'application/json'}).end('{}'));
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 origin=`http://127.0.0.1:${port}`;
 directory=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||'/tmp','portal-nvidia-observer-'));
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)],{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PUBLIC_RELEASE_ENABLED:'false',SITE_URL:origin,BACKEND_URL:`http://127.0.0.1:${backend.address().port}`},stdio:'ignore'});
 for(let attempt=0;attempt<60;attempt++){
  if(await fetch(origin+'/en/products/onesa-drone').then(response=>response.ok,()=>false))return;
  assert.equal(server.exitCode,null,'Isolated production frontend must remain running');await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error('Isolated production build did not become ready');
});
after(async()=>{
 // Only fixed, validated public failure JSON/PNG files enter the existing
 // verification artifact. Browser receipts/session files stay in the temp root.
 if(directory){try{const retained=retainPublicTextDiagnostics(directory,path.join(cwd,'test-results','public-diagnostics'));console.log(JSON.stringify({scope:'OPTIONAL_PUBLIC_FAILURE_DIAGNOSTICS',retained}));}catch{console.error(JSON.stringify({scope:'OPTIONAL_PUBLIC_FAILURE_DIAGNOSTICS',retention:'refused'}));}}
 if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
 if(backend){backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
});
function request(){
 return {qualification_profile:PROFILE,environment:'staging',origin,bypass:null,provider_token_included:false,
  binding:{repository:'DruHustle/onesa-company-portal',component:'frontend'},
  nvidia:{contract:CONTRACT,catalog_sha256:digest(fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/models/nvidia/manifest.json',import.meta.url))),renderer_license_sha256:digest(fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/licenses/three.txt',import.meta.url)))}};
}

test('the hosted receipt entry refuses the actual loopback fixture before browser work',async()=>{
 await assert.rejects(checkUI(request(),directory),assert.AssertionError);
 assert.equal(fs.existsSync(path.join(directory,'browser-receipt.json')),false);
});
test('only canonical catalog model GET and HEAD responses allow private revalidation',async()=>{
 const catalog=JSON.parse(fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/models/nvidia/manifest.json',import.meta.url)));
 const paths=catalog.assets.map(asset=>'/models/nvidia/'+asset.glb.path);
 for(const asset of catalog.assets)for(const method of ['GET','HEAD']){
  const response=await fetch(origin+'/models/nvidia/'+asset.glb.path,{method,redirect:'manual'});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-cache');
  assert.match(response.headers.get('content-security-policy'),/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  const body=Buffer.from(await response.arrayBuffer());
  assert.equal(body.length,method==='HEAD'?0:asset.glb.byteLength);
  if(method==='GET')assert.equal(digest(body),asset.glb.sha256);
 }
 for(const path of [paths[0]+'?variant=synthetic',paths[0].replace('nvidia-transfer','%6evidia-transfer'),paths[0]+'/',paths[0].replace('.glb','.GLB'),'/models/nvidia/unknown/reference.glb','/models/nvidia/manifest.json','/licenses/three.txt','/en/products/onesa-drone','/admin','/engineering/sign-in/synthetic','/docs','/api/v1/auth/me','/api/v1/admin/content']){
  const response=await fetch(origin+path,{redirect:'manual'}),policy=response.headers.get('cache-control')??'';
  assert.notEqual(policy,'private, no-cache',path);assert.doesNotMatch(policy,/(?:^|,)\s*(?:public|s-maxage\s*=)/i,path);
  if(path===paths[0]+'/'){assert.equal(response.status,308);assert.equal(response.headers.get('location'),paths[0]);}
  else if(!path.startsWith('/api/'))assert.match(policy,/(?:^|,)\s*no-store(?:,|$)/i,path);
  await response.body?.cancel();
 }
 const method=await fetch(origin+paths[0],{method:'POST',redirect:'manual'});
 assert.notEqual(method.headers.get('cache-control'),'private, no-cache');assert.match(method.headers.get('cache-control')??'',/(?:^|,)\s*no-store(?:,|$)/i);await method.body?.cancel();
});
for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
 test(`${engine}: LOCAL_SYNTHETIC_NOT_HOSTED full NVIDIA observer`,{timeout:240000},async t=>{
  const browser=await type.launch({headless:engine!=='firefox'});
  try{
   const observed=await observeNvidia(browser,engine,request(),directory);
   assert.equal(observed.views.length,8);assert.equal(observed.fallbacks.length,2);assert.equal(observed.asset_deliveries.length,14);
   for(const row of observed.views)assert.deepEqual(row.assets.map(asset=>asset.id),CONTRACT.asset_ids);
   for(const row of observed.fallbacks)assert.deepEqual(row.product_index_asset_ids,CONTRACT.asset_ids);
   assert.deepEqual(observed.counts,{operational_mutations:0,javascript_errors:0,accessibility_violations:0,speculative_prefetches:0});
   assert.equal(fs.existsSync(path.join(directory,'browser-receipt.json')),false);
   t.diagnostic(`LOCAL_SYNTHETIC_NOT_HOSTED: ${engine} ${browser.version()}, 8 views, 2 recovery/preview cases`);
  }finally{await browser.close();}
 });
}
