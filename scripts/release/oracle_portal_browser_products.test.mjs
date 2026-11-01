// Exercise the same product observer against the actual production build with
// an isolated, empty public backend. No provider or application credentials.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium,firefox,webkit} from '@playwright/test';
import {visitHome,verifyRobotInspectionNotice,visitDronePresentation,checkDroneRoutes} from './oracle_portal_browser.mjs';
import {listenFixture,closeFixtureServer,spawnFixture,waitForFixtureFrontend,withFixtureResource} from './oracle_portal_test_lifecycle.mjs';

const root=process.env.ONESA_SOURCE_ROOT;
assert.ok(root&&path.isAbsolute(root),'Explicit source checkout required');
const cwd=path.join(root,'onesa-company-portal-frontend');
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(fs.existsSync(path.join(cwd,name)),false,'No application credentials in test checkout');
let backend,server,origin;
before(async t=>{
 backend=http.createServer((_request,response)=>response.writeHead(404,{'Content-Type':'application/json'}).end('{}'));
 await listenFixture(backend);
 const reservation=http.createServer();const port=await listenFixture(reservation);await closeFixtureServer(reservation);
 origin=`http://127.0.0.1:${port}`;
 server=spawnFixture(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)],{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PUBLIC_RELEASE_ENABLED:'false',SITE_URL:origin,BACKEND_URL:`http://127.0.0.1:${backend.address().port}`},stdio:'ignore'});
 await waitForFixtureFrontend(server,origin,{signal:t.signal});
});
after(async()=>{
 try{await server?.stop();}finally{await closeFixtureServer(backend);}
});

for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 test(`${name}: product media and routes in both themes/languages and three widths`,{timeout:240000},async t=>{
  await withFixtureResource(t,()=>type.launch({headless:true}),async browser=>{
   let views=0;
   for(const locale of ['en','de'])for(const colorScheme of ['light','dark'])for(const width of [320,390,1440]){
    const context=await browser.newContext({viewport:{width,height:900},colorScheme,reducedMotion:'reduce'});
    try{
     const page=await context.newPage();const errors=[],mutations=[];page.on('pageerror',error=>errors.push(error.name));page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))mutations.push(request.method());});
     await visitHome(page,origin,locale);
     await verifyRobotInspectionNotice(page.locator('section').filter({has:page.locator('#home-robot-title')}),locale);
     const observed=await visitDronePresentation(page,origin,locale);assert.equal(observed.keyboard_playback,'PASS');await checkDroneRoutes(page,origin,locale);
     assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);views++;
    }finally{await context.close();}
   }
   assert.equal(views,12);
  });
 });
}

test('a changed synthetic-inspection claim cannot pass the hosted notice check',{timeout:30000},async t=>{
 await withFixtureResource(t,()=>chromium.launch(),async browser=>{
  const page=await browser.newPage();await visitHome(page,origin,'en');
  const section=page.locator('section').filter({has:page.locator('#home-robot-title')});
  await verifyRobotInspectionNotice(section,'en');
  await section.locator('p').filter({hasText:'Supervised synthetic Pump P-101 inspection'}).evaluate(node=>{node.textContent=node.textContent.replace('synthetic','real-data');});
  await assert.rejects(verifyRobotInspectionNotice(section,'en'),/toContainText/);
 });
});

test('failed documents and a foreign legacy redirect cannot qualify',{timeout:30000},async t=>{
 await withFixtureResource(t,()=>chromium.launch(),async browser=>{
  const page=await browser.newPage();
  await page.route('**/products/onesa-drone',route=>route.fulfill({status:503,body:'Unavailable'}));
  await assert.rejects(visitDronePresentation(page,origin,'en'),/successful response/);
  // APIRequestContext intentionally observes a genuine HTTP response rather
  // than Playwright page interception. A second local server supplies the
  // wrong redirect, with no request sent to its foreign destination.
  const foreign=http.createServer((_request,response)=>response.writeHead(308,{location:'https://foreign.invalid/en/products/onesa-drone'}).end());
  await listenFixture(foreign);
  try{await assert.rejects(checkDroneRoutes(page,`http://127.0.0.1:${foreign.address().port}`,'en'),assert.AssertionError);}
  finally{await closeFixtureServer(foreign);}
 });
});
