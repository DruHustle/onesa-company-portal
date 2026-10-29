// Exercise the same product observer against the actual production build with
// an isolated, empty public backend. No provider or application credentials.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {chromium,firefox,webkit} from '@playwright/test';
import {visitDronePresentation,checkDroneRoutes} from './oracle_portal_browser.mjs';

const root=process.env.ONESA_SOURCE_ROOT;
assert.ok(root&&path.isAbsolute(root),'Explicit source checkout required');
const cwd=path.join(root,'onesa-company-portal-frontend');
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(fs.existsSync(path.join(cwd,name)),false,'No application credentials in test checkout');
let backend,server,origin;
before(async()=>{
 backend=http.createServer((_request,response)=>response.writeHead(404,{'Content-Type':'application/json'}).end('{}'));
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 origin=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)],{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PUBLIC_RELEASE_ENABLED:'false',SITE_URL:origin,BACKEND_URL:`http://127.0.0.1:${backend.address().port}`},stdio:'ignore'});
 for(let attempt=0;attempt<60;attempt++){
  if(await fetch(origin+'/en/products/onesa-drone').then(response=>response.ok,()=>false))return;
  assert.equal(server.exitCode,null,'Production fixture must remain running');await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error('Isolated production build did not become ready');
});
after(async()=>{
 if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
 if(backend){backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
});

for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 test(`${name}: product media and routes in both themes/languages and three widths`,{timeout:240000},async()=>{
  const browser=await type.launch({headless:true});let views=0;
  try{
   for(const locale of ['en','de'])for(const colorScheme of ['light','dark'])for(const width of [320,390,1440]){
    const context=await browser.newContext({viewport:{width,height:900},colorScheme,reducedMotion:'reduce'});
    try{
     const page=await context.newPage();const errors=[],mutations=[];page.on('pageerror',error=>errors.push(error.name));page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))mutations.push(request.method());});
     const observed=await visitDronePresentation(page,origin,locale);assert.equal(observed.keyboard_playback,'PASS');await checkDroneRoutes(page,origin,locale);
     assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);views++;
    }finally{await context.close();}
   }
   assert.equal(views,12);
  }finally{await browser.close();}
 });
}

test('failed documents and a foreign legacy redirect cannot qualify',{timeout:30000},async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('**/products/onesa-drone',route=>route.fulfill({status:503,body:'Unavailable'}));
  await assert.rejects(visitDronePresentation(page,origin,'en'),/successful response/);
  // APIRequestContext intentionally observes a genuine HTTP response rather
  // than Playwright page interception. A second local server supplies the
  // wrong redirect, with no request sent to its foreign destination.
  const foreign=http.createServer((_request,response)=>response.writeHead(308,{location:'https://foreign.invalid/en/products/onesa-drone'}).end());
  await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(checkDroneRoutes(page,`http://127.0.0.1:${foreign.address().port}`,'en'),assert.AssertionError);}
  finally{foreign.closeAllConnections();await new Promise(resolve=>foreign.close(resolve));}
 }finally{await browser.close();}
});
