import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {PROFILE,CONTRACT,digest,pinnedCatalog,publicReferences,assertDeliveredAsset,readDeliveredModelResponse,TEXT_DIAGNOSTIC_LIMITS,boundedPublicDiagnostic,boundedPublicTextClip,publicTextImage,validatePublicTextRecord,writePublicTextDiagnostics,retainPublicTextDiagnostics} from './oracle_portal_nvidia_contract.mjs';

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

function pngChunk(type,body){const result=Buffer.alloc(body.length+12);result.writeUInt32BE(body.length);result.write(type,4,'ascii');body.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
function syntheticPng(width=2,height=2,{data,metadata=[]}={}){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),...metadata,pngChunk('IDAT',data??deflateSync(Buffer.alloc((width*4+1)*height))),pngChunk('IEND',Buffer.alloc(0))]);
}
function textRecord(image=null){return {schema_version:1,state:'NVIDIA_TEXT_REFLOW_FAILED',engine:'chromium',locale:'de',width:320,mode:'light',targets:[{area:'portfolio',index:2,tag:'h2',box:{left:24,top:24,right:296,bottom:92,width:272,height:68},client_width:272,scroll_width:272,client_height:68,scroll_height:70,font_size_px:64,line_height_px:67.84,overflow_x:'visible',overflow_y:'visible',reasons:['own_scroll_y'],clipping_ancestor:null}],image};}
function diagnosticFixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'public-diagnostic-test-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source'),destination=path.join(root,'artifact');fs.mkdirSync(source);return {root,source,destination};}

test('public diagnostic crop and deadline remain strictly bounded',async()=>{
 assert.deepEqual(boundedPublicTextClip({x:20,y:30,width:1200,height:900},{width:1440,height:950}),{x:20,y:30,width:480,height:320});
 assert.deepEqual(boundedPublicTextClip({x:-20,y:-30,width:40,height:50},{width:320,height:950}),{x:0,y:0,width:20,height:20});
 for(const box of [{x:400,y:0,width:10,height:10},{x:0,y:0,width:-1,height:10},{x:NaN,y:0,width:10,height:10},{x:0,y:0,width:Infinity,height:10}])assert.throws(()=>boundedPublicTextClip(box,{width:320,height:950}));
 await assert.rejects(boundedPublicDiagnostic(()=>new Promise(()=>{}),20),/diagnostic deadline/);
 for(const timeout of [0,2001,Infinity])await assert.rejects(boundedPublicDiagnostic(async()=>null,timeout));
 const original=Error('synthetic optional capture failure');await assert.rejects(boundedPublicDiagnostic(async()=>{throw original;}),error=>error===original);
});
test('only bounded decoded PNG pixels without arbitrary metadata are retained',()=>{
 const valid=syntheticPng();assert.deepEqual(publicTextImage(valid),{sha256:digest(valid),byte_length:valid.length,width:2,height:2});
 const crc=Buffer.from(valid);crc[crc.length-1]^=1;
 for(const invalid of [Buffer.alloc(TEXT_DIAGNOSTIC_LIMITS.pngBytes+1),valid.subarray(0,-1),Buffer.concat([valid,Buffer.from('extra')]),crc,syntheticPng(481,1),syntheticPng(1,321),syntheticPng(1,1,{data:Buffer.from([0])}),syntheticPng(1,1,{data:deflateSync(Buffer.alloc(10000))}),syntheticPng(1,1,{metadata:[pngChunk('tEXt',Buffer.from('synthetic private metadata'))]})])assert.throws(()=>publicTextImage(invalid));
});
test('failure metadata refuses extra content, traversal and excessive records or geometry',()=>{
 assert.ok(validatePublicTextRecord(textRecord(),'chromium').length<16384);
 const variants=[value=>{value.cookie='synthetic';},value=>{value.engine='../chromium';},value=>{value.targets=Array(9).fill(value.targets[0]);},value=>{value.targets[0].box.width=Infinity;},value=>{value.targets[0].reasons=['arbitrary page error'];},value=>{value.targets[0].font_size_px=-1;},value=>{value.image={...publicTextImage(syntheticPng()),name:'../receipt.json'};}];
 for(const mutate of variants){const value=textRecord();mutate(value);assert.throws(()=>validatePublicTextRecord(value,'chromium'));}
});
test('retention copies only explicit public names and preserves exact verified bytes',t=>{
 const fixture=diagnosticFixture(t),png=syntheticPng(),record=textRecord(publicTextImage(png));writePublicTextDiagnostics(fixture.source,record,png);
 fs.writeFileSync(path.join(fixture.source,'browser-receipt.json'),'synthetic receipt excluded');fs.writeFileSync(path.join(fixture.source,'session.json'),'synthetic session excluded');fs.mkdirSync(path.join(fixture.source,'private-state'));fs.writeFileSync(path.join(fixture.source,'private-state','cookies.json'),'synthetic cookies excluded');
 assert.deepEqual(retainPublicTextDiagnostics(fixture.source,fixture.destination),['nvidia-text-reflow-chromium.png','nvidia-text-reflow-chromium.json']);
 assert.deepEqual(fs.readdirSync(fixture.destination).sort(),['nvidia-text-reflow-chromium.json','nvidia-text-reflow-chromium.png']);
 assert.deepEqual(fs.readFileSync(path.join(fixture.destination,'nvidia-text-reflow-chromium.png')),png);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.destination,'nvidia-text-reflow-chromium.json'))),record);
 assert.throws(()=>retainPublicTextDiagnostics(fixture.source+'/../source',path.join(fixture.root,'other')));
});
test('retention refuses symlinks, non-regular files, missing pairs and malformed or oversized evidence',t=>{
 for(const mode of ['json-link','image-directory','oversize','malformed','extra-field','image-mismatch','missing-image','orphan-image','source-link','destination-link']){
  const fixture=diagnosticFixture(t),png=syntheticPng(),record=textRecord(publicTextImage(png));writePublicTextDiagnostics(fixture.source,record,png);
  const json=path.join(fixture.source,'nvidia-text-reflow-chromium.json'),image=path.join(fixture.source,'nvidia-text-reflow-chromium.png');let source=fixture.source,destination=fixture.destination;
  if(mode==='json-link'){const target=path.join(fixture.root,'outside.json');fs.renameSync(json,target);fs.symlinkSync(target,json);}
  if(mode==='image-directory'){fs.unlinkSync(image);fs.mkdirSync(image);}
  if(mode==='oversize')fs.writeFileSync(json,Buffer.alloc(TEXT_DIAGNOSTIC_LIMITS.jsonBytes+1));
  if(mode==='malformed')fs.writeFileSync(json,'{');
  if(mode==='extra-field')fs.writeFileSync(json,JSON.stringify({...record,url:'https://synthetic.invalid/private'}));
  if(mode==='image-mismatch')fs.writeFileSync(json,JSON.stringify({...record,image:{...record.image,sha256:'0'.repeat(64)}}));
  if(mode==='missing-image')fs.unlinkSync(image);
  if(mode==='orphan-image')fs.unlinkSync(json);
  if(mode==='source-link'){source=path.join(fixture.root,'linked-source');fs.symlinkSync(fixture.source,source);}
  if(mode==='destination-link'){const target=path.join(fixture.root,'outside-directory');fs.mkdirSync(target);fs.symlinkSync(target,destination);}
  assert.throws(()=>retainPublicTextDiagnostics(source,destination),undefined,mode);
 }
});
