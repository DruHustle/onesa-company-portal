import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.DATABASE_URL='postgresql://unit:unit@127.0.0.1:1/unit';
process.env.SESSION_KEY='scanner-test-only-session-key-1234567890';
process.env.NODE_ENV='test';
const {env}=await import('../src/config/env.js');
const {scan}=await import('../src/services/storage.js');

test('INSTREAM requires one complete clean record and never accepts an OK substring',async()=>{
 for(const [response,expected] of [
  ['stream: OK\0','clean'],
  ['stream: Eicar-Signature FOUND\0','rejected'],
  ['stream: stream: OK FOUND\0','rejected'],
  ['stream: OK\0stream: Malware FOUND\0','quarantine'],
  ['stream: OK','quarantine'],
  ['prefix stream: OK\0','quarantine'],
  ['INSTREAM size limit exceeded. ERROR\0','quarantine'],
 ] as const){
  const server=createServer(socket=>socket.once('data',()=>socket.end(response)));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  env.CLAMAV_HOST='127.0.0.1';env.CLAMAV_PORT=address.port;
  try{assert.equal(await scan(Buffer.from('synthetic scan content')),expected);}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});

test('Oversized scanner responses fail without exposing their content',async()=>{
 const marker='synthetic-private-scanner-message';
 const server=createServer(socket=>socket.once('data',()=>socket.end(marker.repeat(200))));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 env.CLAMAV_HOST='127.0.0.1';env.CLAMAV_PORT=address.port;
 try{await assert.rejects(scan(Buffer.from('synthetic content')),error=>error instanceof Error&&!error.message.includes(marker));}
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Trickling scanner traffic cannot extend the total deadline',{timeout:18000},async()=>{
 const server=createServer(socket=>{
  const timer=setInterval(()=>socket.write('x'),100);
  socket.on('data',()=>{});
  socket.once('close',()=>clearInterval(timer));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 env.CLAMAV_HOST='127.0.0.1';env.CLAMAV_PORT=address.port;
 const began=performance.now();
 try{await assert.rejects(scan(Buffer.from('synthetic content')),/Scan timed out/);assert.ok(performance.now()-began<17000);}
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('Oracle worker scans over its private Unix socket and preserves framing',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'onesa-scan-socket-'));
 const path=join(folder,'clamd.sock');
 const server=createServer(socket=>socket.once('data',data=>{assert.equal(data.subarray(0,10).toString(),'zINSTREAM\0');socket.end('stream: OK\0');}));
 await new Promise<void>(resolve=>server.listen(path,resolve));
 const previous=env.CLAMAV_SOCKET;env.CLAMAV_SOCKET=path;
 try{
  assert.equal(await scan(Buffer.from('synthetic private socket content')),'quarantine');
  await writeFile(join(folder,'scanner-ready'),String(Math.floor(Date.now()/1000)-180));
  assert.equal(await scan(Buffer.from('synthetic private socket content')),'quarantine');
  await writeFile(join(folder,'scanner-ready'),String(Math.floor(Date.now()/1000)));
  assert.equal(await scan(Buffer.from('synthetic private socket content')),'clean');
 }
 finally{env.CLAMAV_SOCKET=previous;await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(folder,{recursive:true});}
});
