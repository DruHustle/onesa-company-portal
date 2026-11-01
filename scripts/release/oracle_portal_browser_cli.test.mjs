// Exercise the actual CLI in a fresh process, not the import-only test route.
// Deliberately missing NVIDIA metadata must fail after observer import and
// before any browser launch or hosted request. No success receipt is expected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('direct NVIDIA CLI completes its import graph and rejects malformed input before browser work',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'portal-browser-cli-'));
 try{
  const request=path.join(directory,'request.json');
  fs.writeFileSync(request,JSON.stringify({
   qualification_profile:'frontend-nvidia-v1',environment:'staging',
   origin:'https://onesa-company-portal-git-staging-synthetic.vercel.app',
   provider_token_included:false,bypass:null,
   binding:{repository:'DruHustle/onesa-company-portal',component:'frontend'},
  }),{mode:0o600});
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./oracle_portal_browser.mjs',import.meta.url)),request],{
   timeout:10000,encoding:'utf8',maxBuffer:32768,
   env:{PATH:process.env.PATH,LANG:'C.UTF-8'},
  });
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  assert.equal(result.status,1,'A direct CLI import cycle must not exit 13 or hang');
  assert.match(result.stderr,/TypeError: Cannot read properties of undefined \(reading 'contract'\)/);
  assert.doesNotMatch(result.stderr,/unsettled top-level await|ERR_MODULE_NOT_FOUND|browserType\.launch/);
  assert.equal(result.stdout,'');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
