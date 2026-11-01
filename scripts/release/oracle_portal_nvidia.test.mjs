// Exercise the actual observer against an isolated production build. These
// loopback observations are LOCAL_SYNTHETIC_NOT_HOSTED and confer no authority.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import {measureProductTextReflow,previewHasDecodedPixels,observeNvidia} from './oracle_portal_nvidia.mjs';
import {checkUI} from './oracle_portal_browser.mjs';
import {PROFILE,CONTRACT,digest,retainPublicTextDiagnostics} from './oracle_portal_nvidia_contract.mjs';
import {listenFixture,closeFixtureServer,spawnFixture,fetchFixture,waitForFixtureFrontend,withFixtureResource} from './oracle_portal_test_lifecycle.mjs';

const root=process.env.ONESA_SOURCE_ROOT;
assert.ok(root&&path.isAbsolute(root),'Explicit isolated source checkout required');
const cwd=path.join(root,'onesa-company-portal-frontend');
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(fs.existsSync(path.join(cwd,name)),false);
let backend,server,origin,directory;
before(async t=>{
 backend=http.createServer((_request,response)=>response.writeHead(404,{'Content-Type':'application/json'}).end('{}'));
 await listenFixture(backend);
 const reservation=http.createServer();const port=await listenFixture(reservation);await closeFixtureServer(reservation);
 origin=`http://127.0.0.1:${port}`;
 directory=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||'/tmp','portal-nvidia-observer-'));
 server=spawnFixture(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)],{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PUBLIC_RELEASE_ENABLED:'false',SITE_URL:origin,BACKEND_URL:`http://127.0.0.1:${backend.address().port}`},stdio:'ignore'});
 await waitForFixtureFrontend(server,origin,{signal:t.signal});
});
after(async()=>{
 // Only fixed, validated public failure JSON/PNG files enter the existing
 // verification artifact. Browser receipts/session files stay in the temp root.
 if(directory){try{const retained=retainPublicTextDiagnostics(directory,path.join(cwd,'test-results','public-diagnostics'));console.log(JSON.stringify({scope:'OPTIONAL_PUBLIC_FAILURE_DIAGNOSTICS',retained}));}catch{console.error(JSON.stringify({scope:'OPTIONAL_PUBLIC_FAILURE_DIAGNOSTICS',retention:'refused'}));}}
 try{await server?.stop();}finally{await closeFixtureServer(backend);}
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
  const response=await fetchFixture(origin+'/models/nvidia/'+asset.glb.path,{method,redirect:'manual'});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-cache');
  assert.match(response.headers.get('content-security-policy'),/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  const body=Buffer.from(await response.arrayBuffer());
  assert.equal(body.length,method==='HEAD'?0:asset.glb.byteLength);
  if(method==='GET')assert.equal(digest(body),asset.glb.sha256);
 }
 for(const path of [paths[0]+'?variant=synthetic',paths[0].replace('nvidia-transfer','%6evidia-transfer'),paths[0]+'/',paths[0].replace('.glb','.GLB'),'/models/nvidia/unknown/reference.glb','/models/nvidia/manifest.json','/licenses/three.txt','/en/products/onesa-drone','/admin','/engineering/sign-in/synthetic','/docs','/api/v1/auth/me','/api/v1/admin/content']){
  const response=await fetchFixture(origin+path,{redirect:'manual'}),policy=response.headers.get('cache-control')??'';
  assert.notEqual(policy,'private, no-cache',path);assert.doesNotMatch(policy,/(?:^|,)\s*(?:public|s-maxage\s*=)/i,path);
  if(path===paths[0]+'/'){assert.equal(response.status,308);assert.equal(response.headers.get('location'),paths[0]);}
  else if(!path.startsWith('/api/'))assert.match(policy,/(?:^|,)\s*no-store(?:,|$)/i,path);
  await response.body?.cancel();
 }
 const method=await fetchFixture(origin+paths[0],{method:'POST',redirect:'manual'});
 assert.notEqual(method.headers.get('cache-control'),'private, no-cache');assert.match(method.headers.get('cache-control')??'',/(?:^|,)\s*no-store(?:,|$)/i);await method.body?.cancel();
});
async function verifyActualTextOverflowGuards(browser,t){
 const retainedBefore=fs.readdirSync(directory).sort();
 await withFixtureResource(t,()=>browser.newContext({viewport:{width:320,height:950},reducedMotion:'reduce'}),async context=>{
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
 });
}

async function verifyActualPreviewPixelGuards(browser,t){
 const catalog=JSON.parse(fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/models/nvidia/manifest.json',import.meta.url)));
 const thumbnail=catalog.assets[0].thumbnail,preview=fs.readFileSync(path.join(cwd,'public','models','nvidia',thumbnail.path));
 assert.equal(preview.length,thumbnail.byteLength);assert.equal(digest(preview),thumbnail.sha256);
 // A complete 1x1 RGBA PNG whose only pixel is transparent.
 const transparent=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
 const document='<!doctype html><script>document.documentElement.dataset.fixtureScriptRan="yes"</script>'+['valid','malformed','truncated','unloaded','transparent'].map(id=>`<img id="${id}" src="/${id}.png" width="32" height="32" alt="${id}">`).join('');
 let unloadedRequests=0;
 const fixture=http.createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');
  if(request.url==='/'){response.writeHead(200,{'Content-Type':'text/html'}).end(document);return;}
  if(request.url==='/unloaded.png'){unloadedRequests++;response.writeHead(200,{'Content-Type':'image/png'});response.flushHeaders();return;}
  const body=request.url==='/valid.png'?preview:request.url==='/malformed.png'?Buffer.from('not a PNG'):request.url==='/truncated.png'?preview.subarray(0,33):request.url==='/transparent.png'?transparent:null;
  if(body)response.writeHead(200,{'Content-Type':'image/png','Content-Length':String(body.length)}).end(body);
  else response.writeHead(404).end();
 });
 t.after(()=>closeFixtureServer(fixture));
 const port=await listenFixture(fixture);
 for(const javaScriptEnabled of [true,false]){
  await withFixtureResource(t,()=>browser.newContext({javaScriptEnabled}),async context=>{
   const page=await context.newPage();await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'domcontentloaded'});
   await expect(page.locator('#valid')).toBeVisible();
   await expect.poll(()=>page.locator('#valid').evaluate(previewHasDecodedPixels)).toBe(true);
   await expect.poll(()=>page.evaluate(()=>['malformed','truncated','transparent'].every(id=>document.getElementById(id).complete))).toBe(true);
   const state=await page.evaluate(()=>({scriptRan:document.documentElement.dataset.fixtureScriptRan??null,canvases:document.querySelectorAll('canvas').length,
    images:Object.fromEntries([...document.images].map(node=>[node.id,{complete:node.complete,width:node.naturalWidth,height:node.naturalHeight}]))}));
   assert.equal(state.scriptRan,javaScriptEnabled?'yes':null);assert.equal(state.canvases,0);
   assert.ok(state.images.valid.complete&&state.images.valid.width>0&&state.images.valid.height>0);
   assert.deepEqual(state.images.malformed,{complete:true,width:0,height:0});
   assert.equal(state.images.truncated.complete,true);
   assert.deepEqual(state.images.unloaded,{complete:false,width:0,height:0});
   assert.deepEqual(state.images.transparent,{complete:true,width:1,height:1});
   for(const id of ['malformed','truncated','unloaded','transparent'])assert.equal(await page.locator('#'+id).evaluate(previewHasDecodedPixels),false,id);
   assert.equal(await page.evaluate(()=>document.querySelectorAll('canvas').length),0,'Pixel observation must not alter the page');
  });
 }
 assert.equal(unloadedRequests,2,'Both scripting modes requested the actually held image response');
}

// One failure-only, bounded record for the observed native Firefox timeout.
// These wrappers call the actual owned API immediately and return its original
// promise/result. No arguments, URLs, page content, responses or errors are logged.
function observeFirefoxFixtureProgress(t,browser){
 const pending=new Map(),recent=[],restores=[];let sequence=0,active=true,limited=false;
 const wrap=(target,name,label,created)=>{
  if(!active||restores.length>=128){limited=true;return;}
  const original=target[name],descriptor=Object.getOwnPropertyDescriptor(target,name);
  if(typeof original!=='function'){limited=true;return;}
  const wrapped=function(...args){
   const phase=label==='page.evaluate'&&typeof args[0]==='function'&&
    (Function.prototype.toString.call(args[0]).match(/requestAnimationFrame/g)||[]).length===2?'page.paint-two-frames':label;
   const id=++sequence,tracked=pending.size<16;
   if(tracked)pending.set(id,{operation:id,phase});else limited=true;
   const complete=(outcome,value)=>{
    if(!active)return;
    pending.delete(id);recent.push({operation:id,phase,outcome});if(recent.length>8)recent.shift();
    if(outcome==='resolved'&&created){try{created(value);}catch{limited=true;}}
   };
   let result;
   try{result=Reflect.apply(original,this,args);}catch(error){complete('rejected');throw error;}
   if(result&&typeof result.then==='function'){
    // Observe settlement without replacing the promise or its rejection reason.
    void result.then(value=>complete('resolved',value),()=>complete('rejected')).catch(()=>{limited=true;});
   }else complete('resolved',result);
   return result;
  };
  target[name]=wrapped;
  restores.push(()=>{if(target[name]===wrapped){if(descriptor)Object.defineProperty(target,name,descriptor);else delete target[name];}});
 };
 const page=value=>{
  for(const name of ['goto','evaluate','emulateMedia','waitForFunction'])wrap(value,name,`page.${name}`);
 };
 const context=value=>{
  wrap(value,'newPage','context.newPage',page);
  wrap(value,'close','context.close');
  wrap(value.request,'get','public-asset.get');
 };
 wrap(browser,'newContext','browser.newContext',context);
 wrap(browser,'close','browser.close');
 const abort=()=>{
  if(!active)return;
  console.error(JSON.stringify({state:'NVIDIA_FIXTURE_ABORT_PROGRESS',scope:'LOCAL_SYNTHETIC_NOT_HOSTED',engine:'firefox',
   connected:browser.isConnected(),pending:[...pending.values()],recent,instrumentation_limited:limited}));
 };
 t.signal.addEventListener('abort',abort,{once:true});
 return()=>{
  active=false;t.signal.removeEventListener('abort',abort);
  for(const restore of restores.reverse())restore();
 };
}

for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
 test(`${engine}: LOCAL_SYNTHETIC_NOT_HOSTED full NVIDIA observer`,{timeout:240000},async t=>{
  await withFixtureResource(t,()=>type.launch({headless:engine!=='firefox'}),async browser=>{
   await t.test('actual DOM visible-font, own-overflow, ancestor-clipping and horizontal guards',{timeout:10000},async child=>verifyActualTextOverflowGuards(browser,child));
   await t.test('actual decoded preview pixels with scripts enabled and disabled reject malformed, truncated, unloaded and transparent images',{timeout:10000},async child=>verifyActualPreviewPixelGuards(browser,child));
   const stopProgress=engine==='firefox'?observeFirefoxFixtureProgress(t,browser):()=>{};
   try{
    const observed=await observeNvidia(browser,engine,request(),directory);
    assert.equal(observed.views.length,8);assert.equal(observed.fallbacks.length,2);assert.equal(observed.asset_deliveries.length,14);
    for(const row of observed.views)assert.deepEqual(row.assets.map(asset=>asset.id),CONTRACT.asset_ids);
    for(const row of observed.fallbacks)assert.deepEqual(row.product_index_asset_ids,CONTRACT.asset_ids);
    assert.deepEqual(observed.counts,{operational_mutations:0,javascript_errors:0,accessibility_violations:0,speculative_prefetches:0});
    assert.equal(fs.existsSync(path.join(directory,'browser-receipt.json')),false);
    t.diagnostic(`LOCAL_SYNTHETIC_NOT_HOSTED: ${engine} ${browser.version()}, 8 views, 2 recovery/preview cases`);
   }finally{stopProgress();}
  });
 });
}
