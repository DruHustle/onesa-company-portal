import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROFILE,CONTRACT,digest,pinnedCatalog,publicReferences,assertDeliveredAsset} from './oracle_portal_nvidia_contract.mjs';

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
