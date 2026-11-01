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
import {PROFILE,CONTRACT,digest} from './oracle_portal_nvidia_contract.mjs';

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
