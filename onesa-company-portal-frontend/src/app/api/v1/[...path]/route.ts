import {NextRequest} from 'next/server';
import {surface,applicationOrigin} from '@/lib/domains';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
async function boundedBody(request: NextRequest, limit: number): Promise<ArrayBuffer | undefined> {
  if (["GET", "HEAD"].includes(request.method) || !request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new RangeError("Request too large");
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body.buffer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function proxy(request:NextRequest,{params}:{params:Promise<{path:string[]}>}){const {path}=await params;if(path.some(p=>!/^[a-zA-Z0-9_-]+$/.test(p)))return Response.json({error:{code:'PATH',message:'Invalid path',requestId:'proxy'}},{status:400});const hostOrigin=applicationOrigin(request.headers.get('host'),request.nextUrl.origin);const current=hostOrigin?surface(hostOrigin):'unknown';if(current==='unknown'||(current==='company'&&path[0]!=='public'))return Response.json({error:{code:'HOST',message:'Route unavailable on this hostname',requestId:'proxy'}},{status:403});const origin=current==='combined'?(process.env.PUBLIC_ORIGIN||'http://localhost:3300'):hostOrigin!;if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')&&request.headers.get('origin')!==origin)return Response.json({error:{code:'ORIGIN',message:'Untrusted origin',requestId:'proxy'}},{status:403});const headers=new Headers();for(const key of ['content-type','cookie','origin','x-csrf-token','sec-fetch-site']){const value=request.headers.get(key);if(value)headers.set(key,value);}if(process.env.PROXY_SHARED_KEY){headers.set('x-portal-proxy-key',process.env.PROXY_SHARED_KEY);const address=request.headers.get('x-forwarded-for')?.split(',')[0].trim()||'127.0.0.1';headers.set('x-portal-client-ip',address);}const limit=process.env.VERCEL==='1'?4*1024*1024:15*1024*1024;const declared=Number(request.headers.get('content-length')||0);if(declared>limit)return Response.json({error:{code:'FILE_SIZE',message:'Request too large',requestId:'proxy'}},{status:413});try{const body=await boundedBody(request,limit);if(body&&body.byteLength>limit)return Response.json({error:{code:'FILE_SIZE',message:'Request too large',requestId:'proxy'}},{status:413});const response=await fetch(`${process.env.BACKEND_URL||'http://127.0.0.1:8300'}/api/v1/${path.join('/')}${request.nextUrl.search}`,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.any([request.signal,AbortSignal.timeout(20000)]),cache:'no-store'});const output=new Headers();for(const key of ['content-type','content-disposition','x-request-id','retry-after','cache-control','x-content-type-options','x-file-size','x-file-sha256']){const value=response.headers.get(key);if(value)output.set(key,value);}for(const cookie of response.headers.getSetCookie())output.append('set-cookie',cookie);return new Response(response.body,{status:response.status,headers:output});}catch(error){if(error instanceof RangeError)return Response.json({error:{code:'FILE_SIZE',message:'Request too large',requestId:'proxy'}},{status:413});return Response.json({error:{code:'BACKEND_UNAVAILABLE',message:'Service temporarily unavailable. Please try again.',requestId:'proxy'}},{status:503});}}
export const GET=proxy;export const POST=proxy;export const PUT=proxy;export const PATCH=proxy;export const DELETE=proxy;
