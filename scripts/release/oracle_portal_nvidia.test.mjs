// Exercise the actual observer against an isolated production build. These
// loopback observations are LOCAL_SYNTHETIC_NOT_HOSTED and confer no authority.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {chromium,firefox,webkit} from '@playwright/test';
import {measureProductTextReflow,observeNvidia} from './oracle_portal_nvidia.mjs';
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
async function verifyActualTextOverflowGuards(browser){
 const retainedBefore=fs.readdirSync(directory).sort();
 const context=await browser.newContext({viewport:{width:320,height:950},reducedMotion:'reduce'});
 try{
  const page=await context.newPage();
  // Actual engine layout in a separate synthetic document. These adverse cases
  // call only the shared measurement, never the hosted observer or its receipts.
  await page.setContent('<!doctype html><html><head><style>html{font-size:32px}body{margin:0}#wrapper{margin:24px;width:272px}#copy{margin:0;font:700 64px/1.06 Arial,Helvetica,sans-serif}</style></head><body><div id="wrapper"><h2 id="copy">Ag</h2></div></body></html>');
  const measure=()=>page.evaluate(measureProductTextReflow,{groups:[['portfolio','#copy']],maximum:8});
  const geometry=()=>page.evaluate(()=>{
   const node=document.querySelector('#copy'),parent=node.parentElement,box=node.getBoundingClientRect(),wrapper=parent.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect();
   return {own_y:getComputedStyle(node).overflowY,parent_y:getComputedStyle(parent).overflowY,font:parseFloat(getComputedStyle(node).fontSize),client_width:node.clientWidth,scroll_width:node.scrollWidth,client_height:node.clientHeight,scroll_height:node.scrollHeight,top:box.top,bottom:box.bottom,right:box.right,parent_top:wrapper.top,parent_bottom:wrapper.bottom,text_top:text.top,text_bottom:text.bottom};
  });
  const accepted=async()=>{const result=await measure();assert.deepEqual(result.rows,[{area:'portfolio',count:1,overflow:false}]);assert.deepEqual(result.targets,[]);};
  const rejected=async reason=>{const result=await measure();assert.deepEqual(result.rows,[{area:'portfolio',count:1,overflow:true}]);assert.equal(result.targets.length,1);assert.deepEqual(result.targets[0].reasons,[reason]);return result.targets[0];};

  let actual=await geometry();assert.equal(actual.font,64);assert.equal(actual.own_y,'visible');await accepted();
  await page.locator('#copy').evaluate(node=>{node.style.height='24px';});
  actual=await geometry();assert.equal(actual.own_y,'visible');assert.ok(actual.scroll_height>actual.client_height+1,'The visible font actually extends outside its short block');await accepted();
  for(const mode of ['hidden','clip','auto','scroll']){
   await page.locator('#copy').evaluate((node,value)=>{node.style.overflow=value;},mode);
   actual=await geometry();assert.equal(actual.own_y,mode);assert.ok(actual.scroll_height>actual.client_height+1,`Actual own ${mode} vertical overflow required`);
   const target=await rejected('own_scroll_y');assert.equal(target.overflow_y,mode);
  }
  await page.locator('#copy').evaluate(node=>{node.style.overflow='visible';});
  for(const mode of ['hidden','clip']){
   await page.evaluate(value=>{const node=document.querySelector('#copy');node.style.height='96px';node.parentElement.style.height='24px';node.parentElement.style.overflow=value;},mode);
   actual=await geometry();assert.equal(actual.own_y,'visible');assert.equal(actual.parent_y,mode);assert.ok(actual.bottom>actual.parent_bottom+1,'The actual block exceeds its clipping ancestor');
   assert.equal((await rejected('ancestor_clip_y')).clipping_ancestor.overflow_y,mode);
   await page.locator('#copy').evaluate(node=>{node.style.height='24px';});
   actual=await geometry();assert.ok(actual.top>=actual.parent_top-1&&actual.bottom<=actual.parent_bottom+1,'The actual block fits its clipping ancestor');assert.ok(actual.text_bottom>actual.parent_bottom+1,'Actual text still extends beyond the clipping ancestor');
   assert.equal((await rejected('ancestor_clip_y')).clipping_ancestor.overflow_y,mode);
  }
  await page.evaluate(()=>{const node=document.querySelector('#copy');node.parentElement.style.height='auto';node.parentElement.style.overflow='visible';node.style.height='auto';node.style.width='24px';node.style.whiteSpace='nowrap';});
  actual=await geometry();assert.ok(actual.scroll_width>actual.client_width+1,'Actual horizontal text overflow required');await rejected('own_scroll_x');
  await page.locator('#copy').evaluate(node=>{node.style.width='400px';node.style.whiteSpace='normal';});
  actual=await geometry();assert.ok(actual.right>321,'Actual viewport overflow required');await rejected('viewport_x');
  assert.deepEqual(fs.readdirSync(directory).sort(),retainedBefore,'Adverse measurements do not write failure artifacts or receipts');
 }finally{await context.close();}
}

for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
 test(`${engine}: LOCAL_SYNTHETIC_NOT_HOSTED full NVIDIA observer`,{timeout:240000},async t=>{
  const browser=await type.launch({headless:engine!=='firefox'});
  try{
   await t.test('actual DOM visible-font, own-overflow, ancestor-clipping and horizontal guards',{timeout:10000},async()=>verifyActualTextOverflowGuards(browser));
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
