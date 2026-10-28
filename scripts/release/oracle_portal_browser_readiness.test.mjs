// Actual browser regression: an open background connection must not substitute
// for the rendered contract, and a missing contract or failed document fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import {visitHome} from './oracle_portal_browser.mjs';

for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 test(`${name}: visible home remains testable with an open background request`,{timeout:20000},async()=>{
  const server=http.createServer((request,response)=>{
   if(request.url==='/held-open'){response.writeHead(200,{'Content-Type':'text/plain'});response.write('pending');return;}
   response.writeHead(200,{'Content-Type':'text/html'});
   response.end('<!doctype html><html lang="en"><body><h1 id="home-robot-title">Onesa AI Robot</h1><script>fetch("/held-open")</script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await type.launch({headless:true});
  try{
   const page=await browser.newPage(),pending=page.waitForRequest(r=>new URL(r.url()).pathname==='/held-open');
   await visitHome(page,`http://127.0.0.1:${server.address().port}`,'en');await pending;
   await assert.rejects(page.waitForLoadState('networkidle',{timeout:700}),e=>e.name==='TimeoutError');
   await expect(page.locator('#home-robot-title')).toBeVisible();
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 });
}

test('failed HTTP document and missing rendered contract remain failures',{timeout:20000},async()=>{
 const server=http.createServer((request,response)=>{
  response.writeHead(request.url==='/de'?503:200,{'Content-Type':'text/html'});
  response.end('<!doctype html><html><body><h1>Unexpected page</h1></body></html>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),origin=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(visitHome(page,origin,'de'),/successful response/);
  await assert.rejects(visitHome(page,origin,'en'),/toHaveText/);
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
