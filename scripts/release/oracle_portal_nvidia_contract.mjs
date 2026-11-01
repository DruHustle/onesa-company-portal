// Assertions and bounded original-response collection shared by the hosted
// observer and disposable tests. No request creation, receipt writer, browser
// substitute, environment override or success callback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const PROFILE = 'frontend-nvidia-v1';
export const CONTRACT = {
 version:1,engines:['chromium','firefox','webkit'],locales:['en','de'],
 widths:[320,1440],modes:['light','dark'],
 asset_ids:['nvidia-transfer-conveyor','nvidia-mobile-cart','nvidia-storage-rack'],
 public_renderer_only:true,business_workflow_acceptance:false,
};
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function pinnedCatalog(bytes,license,request){
 assert.equal(request.qualification_profile,PROFILE);
 assert.deepEqual(request.nvidia.contract,CONTRACT);
 assert.ok(bytes.length>0&&bytes.length<32768);assert.ok(license.length>0&&license.length<32768);
 assert.equal(digest(bytes),request.nvidia.catalog_sha256);
 assert.equal(digest(license),request.nvidia.renderer_license_sha256);
 const catalog=JSON.parse(bytes);
 assert.equal(catalog.schemaVersion,1);assert.equal(catalog.catalogId,'onesa-nvidia-simready-reference-v1');
 assert.deepEqual(catalog.assets.map(asset=>asset.id),CONTRACT.asset_ids);
 for(const asset of catalog.assets){
  assert.equal(asset.author,'NVIDIA');assert.equal(asset.license,'CC-BY-4.0');assert.equal(asset.visualOnly,true);
  assert.equal(asset.unit,'m');assert.equal(asset.upAxis,'Y');
  assert.equal(asset.sourceRevision,'4763fbfaa4f8e97658e68b57d01b4c86659e08b5');
  assert.equal(asset.sourceUrl,`https://huggingface.co/datasets/nvidia/simready-assets/tree/${asset.sourceRevision}/${asset.sourceAssetId}`);
  for(const key of ['glb','thumbnail','licenseFile','sourceFile']){
   const ref=asset[key];assert.match(ref.path,new RegExp(`^${asset.id}/[A-Za-z0-9_-][A-Za-z0-9_.-]*$`));
   assert.match(ref.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(ref.byteLength)&&ref.byteLength>0&&ref.byteLength<=2_000_000);
  }
 }
 return catalog;
}

export function publicReferences(catalog,bytes,license){
 const files=new Map([
  ['/models/nvidia/manifest.json',{sha256:digest(bytes),byteLength:bytes.length}],
  ['/licenses/three.txt',{sha256:digest(license),byteLength:license.length}],
 ]);
 for(const asset of catalog.assets)for(const key of ['glb','thumbnail','licenseFile','sourceFile']){
  const ref=asset[key],path='/models/nvidia/'+ref.path;
  assert.ok(!files.has(path),'Unique public asset path required');files.set(path,ref);
 }
 return files;
}

export function assertDeliveredAsset({origin,path,status,url,redirects,method,body},expected){
 assert.equal(new URL(url).href,origin+path,'Exact same-origin asset required');
 assert.equal(method,'GET');assert.equal(status,200);assert.equal(redirects,0);
 assert.equal(body.length,expected.byteLength,'Exact bounded public asset length required');
 assert.equal(digest(body),expected.sha256,'Exact public asset digest required');
 return {path,status,redirects,sha256:digest(body),byte_length:body.length};
}

export async function readDeliveredModelResponse(response,origin,path,expected,{timeoutMs=20000}={}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=20000);
 let deadline;
 try{
  return await Promise.race([
   (async()=>{
    const source=response.request();
    assert.equal(source.headers().authorization,undefined);
    assert.equal(await response.finished(),null,'Original model response must finish');
    assert.equal(source.failure(),null,'Original model transport must succeed');
    return assertDeliveredAsset({origin,path,status:response.status(),url:response.url(),redirects:source.redirectedFrom()?1:0,method:source.method(),body:await response.body()},expected);
   })(),
   new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Original model evidence deadline exceeded')),timeoutMs);}),
  ]);
 }finally{clearTimeout(deadline);}
}
