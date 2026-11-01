import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROFILE,CONTRACT,digest,pinnedCatalog,publicReferences,assertDeliveredAsset,readDeliveredModelResponse} from './oracle_portal_nvidia_contract.mjs';

const bytes=fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/models/nvidia/manifest.json',import.meta.url));
const license=fs.readFileSync(new URL('../../onesa-company-portal-frontend/public/licenses/three.txt',import.meta.url));
const request={qualification_profile:PROFILE,nvidia:{contract:CONTRACT,catalog_sha256:digest(bytes),renderer_license_sha256:digest(license)}};

test('source-pinned exact three-asset identities and closure',()=>{
 const catalog=pinnedCatalog(bytes,license,request),files=publicReferences(catalog,bytes,license);
 assert.equal(files.size,14);assert.deepEqual(catalog.assets.map(a=>a.id),CONTRACT.asset_ids);
 for(const path of ['/models/nvidia/manifest.json','/licenses/three.txt'])assert.ok(files.has(path));
});
test('unselected profile, forged hash, mutated contract and oversize metadata fail',()=>{
 for(const altered of [
  {...request,qualification_profile:undefined},
  {...request,nvidia:{...request.nvidia,catalog_sha256:'0'.repeat(64)}},
  {...request,nvidia:{...request.nvidia,contract:{...CONTRACT,engines:['chromium']}}},
 ])assert.throws(()=>pinnedCatalog(bytes,license,altered));
 assert.throws(()=>pinnedCatalog(Buffer.alloc(32768),license,request));
 const changed=JSON.parse(bytes);changed.assets[1]=changed.assets[0];const data=Buffer.from(JSON.stringify(changed));
 assert.throws(()=>pinnedCatalog(data,license,{...request,nvidia:{...request.nvidia,catalog_sha256:digest(data)}}));
});
test('actual response bytes, same origin, exact path and redirect refusal are mandatory',()=>{
 const body=Buffer.from('disposable public fixture');
 const expected={sha256:digest(body),byteLength:body.length};
 const actual={origin:'https://onesa.eu',path:'/models/nvidia/fixture.glb',status:200,url:'https://onesa.eu/models/nvidia/fixture.glb',redirects:0,method:'GET',body};
 assert.equal(assertDeliveredAsset(actual,expected).sha256,expected.sha256);
 for(const patch of [{status:302},{url:'https://foreign.invalid/models/nvidia/fixture.glb'},{url:actual.url+'?token=forbidden'},{redirects:1},{method:'POST'},{body:Buffer.from('corrupt')},{body:Buffer.alloc(body.length)}]){
  assert.throws(()=>assertDeliveredAsset({...actual,...patch},expected));
 }
});

function modelResponse(patch={}){
 const body=Buffer.from('disposable original model bytes');
 const source={headers:()=>({}),failure:()=>null,redirectedFrom:()=>null,method:()=>'GET'};
 return {origin:'https://onesa.eu',path:'/models/nvidia/fixture.glb',expected:{sha256:digest(body),byteLength:body.length},response:{request:()=>source,finished:async()=>null,status:()=>200,url:()=>'https://onesa.eu/models/nvidia/fixture.glb',body:async()=>body,...patch},source};
}

test('original model evidence waits for transport completion and body before releasing the caller',async()=>{
 const finished=Promise.withResolvers(),body=Promise.withResolvers();let bodyReads=0,settled=false;
 const fixture=modelResponse({finished:()=>finished.promise,body:()=>{bodyReads++;return body.promise;}});
 const reading=readDeliveredModelResponse(fixture.response,fixture.origin,fixture.path,fixture.expected).then(value=>{settled=true;return value;});
 await Promise.resolve();assert.equal(bodyReads,0);assert.equal(settled,false);
 finished.resolve(null);await Promise.resolve();await Promise.resolve();assert.equal(bodyReads,1);assert.equal(settled,false);
 body.resolve(Buffer.from('disposable original model bytes'));
 assert.equal((await reading).sha256,fixture.expected.sha256);assert.equal(settled,true);
});

test('unfinished, failed, unreadable and corrupt original model responses cannot become evidence',async()=>{
 for(const failure of ['unfinished','transport','body','corrupt']){
  let bodyReads=0;const fixture=modelResponse();
  fixture.response.body=async()=>{bodyReads++;if(failure==='body')throw Error('Synthetic body unavailable');return Buffer.alloc(fixture.expected.byteLength);};
  if(failure==='unfinished')fixture.response.finished=async()=>Error('Synthetic incomplete response');
  if(failure==='transport')fixture.source.failure=()=>({errorText:'net::ERR_ABORTED'});
  await assert.rejects(readDeliveredModelResponse(fixture.response,fixture.origin,fixture.path,fixture.expected));
  assert.equal(bodyReads,['unfinished','transport'].includes(failure)?0:1);
 }
 const stalled=modelResponse({finished:()=>new Promise(()=>{})});
 await assert.rejects(readDeliveredModelResponse(stalled.response,stalled.origin,stalled.path,stalled.expected,{timeoutMs:20}),/evidence deadline exceeded/);
});
