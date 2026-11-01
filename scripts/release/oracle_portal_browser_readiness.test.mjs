// Actual browser regression: an open background connection must not substitute
// for the rendered contract, and a missing contract or failed document fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import {visitHome} from './oracle_portal_browser.mjs';

// The outer deadline includes cold engine startup and teardown. Keep the
// rendered-contract assertions at five seconds and bound fixture requests
// separately, so startup cannot conceal a missing application contract.
const lifecycleTimeout=60000;
async function fixture(type,t,handler,check){
 const server=http.createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  t.diagnostic('launch');
  browser=await type.launch({headless:true,timeout:10000});
  const page=await browser.newPage();
  page.setDefaultNavigationTimeout(10000);page.setDefaultTimeout(5000);
  t.diagnostic('rendered-contract');
  await check(page,`http://127.0.0.1:${server.address().port}`);
 }finally{
  // Release the deliberately open response before closing WebKit. Cleanup also
  // runs if launch or navigation fails, without leaking a listening fixture.
  t.diagnostic('cleanup');
  const closed=new Promise(resolve=>server.close(resolve));
  server.closeAllConnections();await closed;
  if(browser)await browser.close();
 }
}

for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 test(`${name}: visible home remains testable with an open background request`,{timeout:lifecycleTimeout},async t=>{
  await fixture(type,t,(request,response)=>{
   if(request.url==='/held-open'){response.writeHead(200,{'Content-Type':'text/plain'});response.write('pending');return;}
   response.writeHead(200,{'Content-Type':'text/html'});
   response.end('<!doctype html><html lang="en"><body><h1 id="home-robot-title">Onesa Robot</h1><script>fetch("/held-open")</script></body></html>');
  },async(page,origin)=>{
   const pending=page.waitForRequest(r=>new URL(r.url()).pathname==='/held-open',{timeout:5000});
   // Attach the rejection handler immediately while visitHome is pending.
   await Promise.all([visitHome(page,origin,'en'),pending]);
   await assert.rejects(page.waitForLoadState('networkidle',{timeout:700}),e=>e.name==='TimeoutError');
   await expect(page.locator('#home-robot-title')).toBeVisible();
  });
 });
}

test('failed HTTP document and missing rendered contract remain failures',{timeout:lifecycleTimeout},async t=>{
 await fixture(chromium,t,(request,response)=>{
  response.writeHead(request.url==='/de'?503:200,{'Content-Type':'text/html'});
  response.end('<!doctype html><html><body><h1>Unexpected page</h1></body></html>');
 },async(page,origin)=>{
  await assert.rejects(visitHome(page,origin,'de'),/successful response/);
  await assert.rejects(visitHome(page,origin,'en'),/toHaveText/);
 });
});
