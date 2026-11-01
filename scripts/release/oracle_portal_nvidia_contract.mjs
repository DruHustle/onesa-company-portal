// Assertions and bounded original-response collection shared by the hosted
// observer and disposable tests. No request creation, receipt writer, browser
// substitute, environment override or success callback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {crc32,inflateSync} from 'node:zlib';

export const PROFILE = 'frontend-nvidia-v1';
export const CONTRACT = {
 version:1,engines:['chromium','firefox','webkit'],locales:['en','de'],
 widths:[320,1440],modes:['light','dark'],
 asset_ids:['nvidia-transfer-conveyor','nvidia-mobile-cart','nvidia-storage-rack'],
 public_renderer_only:true,business_workflow_acceptance:false,
};
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Optional public failure evidence. These files never constitute a receipt.
export const TEXT_DIAGNOSTIC_LIMITS=Object.freeze({targets:8,width:480,height:320,jsonBytes:16384,pngBytes:524288,deadlineMs:2000});
export async function boundedPublicDiagnostic(read,timeoutMs=TEXT_DIAGNOSTIC_LIMITS.deadlineMs){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=TEXT_DIAGNOSTIC_LIMITS.deadlineMs);let timer;
 try{return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Public diagnostic deadline exceeded')),timeoutMs);})]);}finally{clearTimeout(timer);}
}
const textAreas=['portfolio','software','film'];
const textTags=['div','p','h2','button','span'];
const overflowModes=['visible','hidden','clip','auto','scroll','other'];
const textReasons=['empty_or_hidden','viewport_x','own_scroll_x','own_scroll_y','ancestor_clip_x','ancestor_clip_y'];
const exactKeys=(value,keys)=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),keys.toSorted());};
const dimension=value=>assert.ok(Number.isFinite(value)&&Math.abs(value)<=1e6);
function validateBox(box){exactKeys(box,['left','top','right','bottom','width','height']);Object.values(box).forEach(dimension);assert.ok(box.width>=0&&box.height>=0);}
export function boundedPublicTextClip(box,viewport){
 for(const value of [box?.x,box?.y,box?.width,box?.height,viewport?.width,viewport?.height])dimension(value);
 assert.ok(box.width>0&&box.height>0&&viewport.width>0&&viewport.height>0);
 const x=Math.ceil(Math.max(0,box.x)),y=Math.ceil(Math.max(0,box.y));
 const width=Math.floor(Math.min(box.x+box.width,viewport.width,x+TEXT_DIAGNOSTIC_LIMITS.width)-x);
 const height=Math.floor(Math.min(box.y+box.height,viewport.height,y+TEXT_DIAGNOSTIC_LIMITS.height)-y);
 assert.ok(width>0&&height>0,'Visible public text crop required');return {x,y,width,height};
}
export function publicTextImage(bytes){
 assert.ok(Buffer.isBuffer(bytes)&&bytes.length>=45&&bytes.length<=TEXT_DIAGNOSTIC_LIMITS.pngBytes);
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 let offset=8,width,height,channels,ended=false,chunks=0;const compressed=[];
 while(offset<bytes.length){
  assert.ok(++chunks<=128&&offset+12<=bytes.length);const size=bytes.readUInt32BE(offset),end=offset+12+size;
  assert.ok(end<=bytes.length);const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
  assert.equal(crc32(bytes.subarray(offset+4,end-4)),bytes.readUInt32BE(end-4),'PNG checksum required');
  if(type==='IHDR'){
   assert.equal(offset,8);assert.equal(size,13);width=data.readUInt32BE(0);height=data.readUInt32BE(4);
   assert.ok(width>0&&width<=TEXT_DIAGNOSTIC_LIMITS.width&&height>0&&height<=TEXT_DIAGNOSTIC_LIMITS.height);
   assert.equal(data[8],8);assert.ok([2,6].includes(data[9]));channels=data[9]===6?4:3;
   assert.deepEqual([...data.subarray(10)],[0,0,0]);
  }else{
   assert.ok(width&&height,'PNG header must be first');
   if(type==='IDAT')compressed.push(data);
   else if(type==='IEND'){assert.equal(size,0);assert.equal(end,bytes.length);ended=true;}
   else{const sizes={sRGB:1,gAMA:4,cHRM:32,pHYs:9};assert.ok(Object.hasOwn(sizes,type),'PNG metadata is not retained');assert.equal(size,sizes[type]);}
  }
  offset=end;
 }
 assert.ok(ended&&compressed.length);const stride=width*channels+1,packed=Buffer.concat(compressed);
 const result=inflateSync(packed,{maxOutputLength:stride*height,info:true});assert.equal(result.buffer.length,stride*height);assert.equal(result.engine.bytesWritten,packed.length);
 for(let row=0;row<height;row++)assert.ok(result.buffer[row*stride]<=4);
 return {sha256:digest(bytes),byte_length:bytes.length,width,height};
}
export function validatePublicTextRecord(record,engine){
 assert.ok(CONTRACT.engines.includes(engine));
 exactKeys(record,['schema_version','state','engine','locale','width','mode','targets','image']);
 assert.equal(record.schema_version,1);assert.equal(record.state,'NVIDIA_TEXT_REFLOW_FAILED');assert.equal(record.engine,engine);
 assert.ok(CONTRACT.locales.includes(record.locale)&&CONTRACT.widths.includes(record.width)&&CONTRACT.modes.includes(record.mode));
 assert.ok(Array.isArray(record.targets)&&record.targets.length>0&&record.targets.length<=TEXT_DIAGNOSTIC_LIMITS.targets);
 for(const target of record.targets){
  exactKeys(target,['area','index','tag','box','client_width','scroll_width','client_height','scroll_height','font_size_px','line_height_px','overflow_x','overflow_y','reasons','clipping_ancestor']);
  assert.ok(textAreas.includes(target.area)&&textTags.includes(target.tag)&&Number.isSafeInteger(target.index)&&target.index>=0&&target.index<32);validateBox(target.box);
  for(const key of ['client_width','scroll_width','client_height','scroll_height','font_size_px']){dimension(target[key]);assert.ok(target[key]>=0);}
  if(target.line_height_px!==null){dimension(target.line_height_px);assert.ok(target.line_height_px>=0);}
  assert.ok(overflowModes.includes(target.overflow_x)&&overflowModes.includes(target.overflow_y));
  assert.ok(Array.isArray(target.reasons)&&target.reasons.length>0&&target.reasons.length<=textReasons.length&&new Set(target.reasons).size===target.reasons.length&&target.reasons.every(reason=>textReasons.includes(reason)));
  const ancestor=target.clipping_ancestor;if(ancestor!==null){exactKeys(ancestor,['tag','depth','box','overflow_x','overflow_y']);assert.match(ancestor.tag,/^[a-z][a-z0-9-]{0,23}$/);assert.ok(Number.isSafeInteger(ancestor.depth)&&ancestor.depth>0&&ancestor.depth<=64);validateBox(ancestor.box);assert.ok(overflowModes.includes(ancestor.overflow_x)&&overflowModes.includes(ancestor.overflow_y));}
 }
 if(record.image!==null){exactKeys(record.image,['sha256','byte_length','width','height']);assert.match(record.image.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(record.image.byte_length)&&record.image.byte_length>0&&record.image.byte_length<=TEXT_DIAGNOSTIC_LIMITS.pngBytes);assert.ok(Number.isSafeInteger(record.image.width)&&record.image.width>0&&record.image.width<=TEXT_DIAGNOSTIC_LIMITS.width&&Number.isSafeInteger(record.image.height)&&record.image.height>0&&record.image.height<=TEXT_DIAGNOSTIC_LIMITS.height);}
 const bytes=Buffer.from(JSON.stringify(record));assert.ok(bytes.length<=TEXT_DIAGNOSTIC_LIMITS.jsonBytes);return bytes;
}
function publicDirectory(directory,create=false){
 assert.ok(typeof directory==='string'&&path.isAbsolute(directory)&&path.normalize(directory)===directory,'Canonical absolute diagnostic directory required');
 let current=path.parse(directory).root;
 for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(error){if(!create||error.code!=='ENOENT')throw error;fs.mkdirSync(current,{mode:0o700});stat=fs.lstatSync(current);}
  assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Diagnostic directories must be regular directories');
 }
}
function readPublicFile(file,maximum){
 let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=maximum,'Bounded regular diagnostic file required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const opened=fs.fstatSync(fd);assert.ok(opened.isFile()&&opened.ino===stat.ino&&opened.dev===stat.dev&&opened.size===stat.size);const bytes=Buffer.alloc(stat.size+1);let count=0,read;while(count<bytes.length&&(read=fs.readSync(fd,bytes,count,bytes.length-count,null))>0)count+=read;assert.equal(count,stat.size);return bytes.subarray(0,count);}finally{fs.closeSync(fd);}
}
function writePublicFile(file,bytes){fs.writeFileSync(file,bytes,{mode:0o600,flag:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW});}
export function writePublicTextDiagnostics(directory,record,png=null){
 publicDirectory(directory);const bytes=validatePublicTextRecord(record,record.engine),base=`nvidia-text-reflow-${record.engine}`;
 if(png!==null)assert.deepEqual(publicTextImage(png),record.image);else assert.equal(record.image,null);
 if(png!==null)writePublicFile(path.join(directory,base+'.png'),png);writePublicFile(path.join(directory,base+'.json'),bytes);
}
export function retainPublicTextDiagnostics(source,destination){
 publicDirectory(source);const files=[];
 for(const engine of CONTRACT.engines){
  const base=`nvidia-text-reflow-${engine}`,bytes=readPublicFile(path.join(source,base+'.json'),TEXT_DIAGNOSTIC_LIMITS.jsonBytes),png=readPublicFile(path.join(source,base+'.png'),TEXT_DIAGNOSTIC_LIMITS.pngBytes);
  if(bytes===null){assert.equal(png,null,'Orphan diagnostic image refused');continue;}
  const record=JSON.parse(bytes);validatePublicTextRecord(record,engine);
  if(record.image===null)assert.equal(png,null);else{assert.ok(png);assert.deepEqual(publicTextImage(png),record.image);files.push([base+'.png',png]);}
  files.push([base+'.json',bytes]);
 }
 if(files.length){publicDirectory(destination,true);for(const [name,bytes]of files)writePublicFile(path.join(destination,name),bytes);}
 return files.map(([name])=>name);
}

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
