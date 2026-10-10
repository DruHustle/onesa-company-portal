// Durable, ownership-bound chunks preserve the existing 10 MiB capability through a bounded BFF.
const chunkBytes=512*1024;
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
function base64(bytes:Uint8Array){let raw='';for(let offset=0;offset<bytes.length;offset+=8192)raw+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(raw);}
export async function transportFetch(request:Request):Promise<Response>{
 const pathname=new URL(request.url).pathname;
 const scope=pathname==='/api/v1/public/applications'?'public':pathname==='/api/v1/admin/files'?'admin':null;
 if(request.method!=='POST'||!scope)return fetch(new Request(request,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)]),cache:'no-store'}));
 const bytes=new Uint8Array(await request.clone().arrayBuffer());
 if(bytes.length<=1024*1024)return fetch(new Request(request,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)]),cache:'no-store'}));
 const prefix=new URL(`/api/v1/${scope}/transfers`,request.url).toString();
 const headers=new Headers(request.headers);headers.delete('content-length');headers.set('content-type','application/json');
 async function send(url:string,body:unknown,signal=request.signal){const response=await fetch(url,{method:'POST',headers,credentials:'same-origin',cache:'no-store',body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(25000)])});if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(value.error?.message||'Upload failed');}return response.json();}
 let receipt:{id:string;ticket:string}|undefined;
 try{
  receipt=await send(prefix,{size:bytes.length,sha256:hex(await crypto.subtle.digest('SHA-256',bytes))});
  for(let offset=0,sequence=0;offset<bytes.length;offset+=chunkBytes,sequence++)await send(`${prefix}/${receipt!.id}/chunks`,{ticket:receipt!.ticket,sequence,base64:base64(bytes.subarray(offset,offset+chunkBytes))});
  const result=await send(`${prefix}/${receipt!.id}/complete`,{ticket:receipt!.ticket});
  return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 }catch(error){if(receipt)await send(`${prefix}/${receipt.id}/cancel`,{ticket:receipt.ticket},AbortSignal.timeout(3000)).catch(()=>{});throw error;}
}

export async function privateDocument(id:string,signal?:AbortSignal):Promise<Blob>{return documentTransfer(id,'admin',signal);}
export async function publicDocument(id:string,signal?:AbortSignal):Promise<Blob>{return documentTransfer(id,'public',signal);}
async function documentTransfer(id:string,scope:'admin'|'public',signal?:AbortSignal):Promise<Blob>{
 const chunks:BlobPart[]=[];let expectedSize=0,expectedHash='';
 for(let index=0;;index++){
  const response=await fetch(`/api/v1/${scope}/files/${encodeURIComponent(id)}/chunks/${index}`,{credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
  if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(value.error?.message||'Document unavailable');}
  const size=Number(response.headers.get('x-file-size')),hash=response.headers.get('x-file-sha256')||'';
  if(index===0){expectedSize=size;expectedHash=hash;}
  if(!Number.isInteger(size)||size<1||size>10485760||size!==expectedSize||hash!==expectedHash||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Document integrity metadata is invalid');
  const bytes=await response.arrayBuffer();if(bytes.byteLength!==Math.min(1048576,size-index*1048576))throw new Error('Document transfer was interrupted');chunks.push(bytes);
  if((index+1)*1048576>=size)break;
 }
 const result=new Blob(chunks);if(hex(await crypto.subtle.digest('SHA-256',await result.arrayBuffer()))!==expectedHash)throw new Error('Document integrity check failed');return result;
}
