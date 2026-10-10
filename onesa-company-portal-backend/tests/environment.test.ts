import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Production rejects a Render-generated 44-character encryption key and accepts a persistent 64-character key',()=>{
 const config=new URL('../src/config/env.ts',import.meta.url).href;
 const fixture={...process.env,NODE_ENV:'production',DATABASE_URL:'postgresql://fixture:fixture@localhost/onesa_test',PUBLIC_ORIGIN:'https://portal.example.invalid',COMPANY_ORIGIN:'https://company.example.invalid',PROXY_SHARED_KEY:'x'.repeat(64),RENDER:'true',S3_BUCKET:'synthetic-test-bucket',MAIL_PROVIDER:'smtp'};
 for(const [length,accepted] of [[44,false],[64,true]] as const){
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(config)})`],{env:{...fixture,SESSION_KEY:'x'.repeat(length)},encoding:'utf8'});
  assert.equal(result.status===0,accepted);
  if(!accepted)assert.match(result.stderr,/48-character encryption key/);
 }
});
