import assert from 'node:assert/strict';
import http from 'node:http';
import {after,before,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {publicFetch} from '../src/lib/api/public-fetch.ts';

// A real loopback transport and synthetic JSON, independent of Next or providers.
let origin:string;
const requests:{path:string;cancelled:boolean}[]=[];
const backend=http.createServer(async(request,response)=>{
  const entry={path:request.url!,cancelled:false};requests.push(entry);
  response.on('close',()=>{if(!response.writableFinished)entry.cancelled=true;});
  response.setHeader('Content-Type','application/json');
  if(request.url==='/slow-body'){response.writeHead(200);response.write(' ');}
  if(request.url==='/slow-headers'||request.url==='/slow-body')await delay(2200);
  if(response.destroyed)return;
  if(!response.headersSent)response.writeHead(request.url==='/missing'?404:200);
  response.end(JSON.stringify({fixture:'synthetic'}));
});
before(async()=>{
  await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${(backend.address() as {port:number}).port}`;
});
after(async()=>{backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));});
for(const path of ['/slow-headers','/slow-body'])test(`public deadline cancels ${path}`,async()=>{
  const request=new Request(origin+path);
  const start=performance.now();
  await assert.rejects(()=>publicFetch(request),/deadline|abort/i);
  const elapsed=performance.now()-start;
  assert.ok(elapsed<2000,`The complete response exceeded the1500ms deadline: ${elapsed}ms`);
  for(let attempt=0;attempt<20&&!requests.at(-1)?.cancelled;attempt++)await delay(10);
  assert.equal(requests.at(-1)?.cancelled,true,'Expiry closes the actual upstream transport');
  console.log(`${path}: rejected and cancelled in ${Math.round(elapsed)}ms`);
});
test('healthy reads recover and a genuine404 remains404',async()=>{
  const healthy=await publicFetch(new Request(origin+'/healthy'));
  assert.equal(healthy.status,200);assert.deepEqual(await healthy.json(),{fixture:'synthetic'});
  const missing=await publicFetch(new Request(origin+'/missing'));
  assert.equal(missing.status,404);assert.deepEqual(await missing.json(),{fixture:'synthetic'});
});
