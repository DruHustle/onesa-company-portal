import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Optional scanner sockets accept an omitted or blank value and reject nonabsolute paths',()=>{
 const config=new URL('../src/config/env.ts',import.meta.url).href;
 const fixture={NODE_ENV:'test',DATABASE_URL:'postgresql://fixture:fixture@localhost/onesa_test',SESSION_KEY:'x'.repeat(64)};
 for(const [socket,accepted] of [['',true],['/run/onesa-scanner/clamd.sock',true],['relative/clamd.sock',false],['/run/socket\ninvalid',false]] as const){
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(config)})`],{env:{...fixture,CLAMAV_SOCKET:socket},encoding:'utf8'});
  assert.equal(result.status===0,accepted);
 }
});

test('Production rejects a Render-generated 44-character encryption key and accepts a persistent 64-character key',()=>{
 const config=new URL('../src/config/env.ts',import.meta.url).href;
 const fixture={...process.env,NODE_ENV:'production',DATABASE_URL:'postgresql://fixture:fixture@localhost/onesa_test',PUBLIC_ORIGIN:'https://portal.example.invalid',COMPANY_ORIGIN:'https://company.example.invalid',PROXY_SHARED_KEY:'x'.repeat(64),RENDER:'true',S3_BUCKET:'synthetic-test-bucket',MAIL_PROVIDER:'smtp'};
 for(const [length,accepted] of [[44,false],[64,true]] as const){
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(config)})`],{env:{...fixture,SESSION_KEY:'x'.repeat(length)},encoding:'utf8'});
  assert.equal(result.status===0,accepted);
  if(!accepted)assert.match(result.stderr,/48-character encryption key/);
 }
});

test('Neon AWS storage aliases work, explicit S3 settings win, and a bucket is still mandatory on Render',()=>{
 const config=new URL('../src/config/env.ts',import.meta.url).href;
 const fixture={NODE_ENV:'production',DATABASE_URL:'postgresql://fixture:fixture@localhost/onesa_test',PUBLIC_ORIGIN:'https://portal.example.invalid',PROXY_SHARED_KEY:'x'.repeat(64),SESSION_KEY:'x'.repeat(64),RENDER:'true',S3_BUCKET:'synthetic-test-bucket',AWS_ENDPOINT_URL_S3:'https://storage.example.invalid',AWS_REGION:'eu-central-1',MAIL_PROVIDER:'smtp'};
 const run=(extra:Record<string,string>)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`const {env}=await import(${JSON.stringify(config)});console.log(JSON.stringify([env.S3_BUCKET,env.S3_ENDPOINT,env.S3_REGION]));`],{env:{...fixture,...extra},encoding:'utf8'});
 const alias=run({});assert.equal(alias.status,0,alias.stderr);assert.deepEqual(JSON.parse(alias.stdout),['synthetic-test-bucket','https://storage.example.invalid','eu-central-1']);
 const explicit=run({S3_ENDPOINT:'https://explicit.example.invalid',S3_REGION:'eu-west-1'});assert.equal(explicit.status,0,explicit.stderr);assert.deepEqual(JSON.parse(explicit.stdout),['synthetic-test-bucket','https://explicit.example.invalid','eu-west-1']);
 const missing=run({S3_BUCKET:''});assert.notEqual(missing.status,0);assert.match(missing.stderr,/shared durable S3 storage/);
});
