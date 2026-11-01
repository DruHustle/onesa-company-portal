// Shared origin/session assertions have no CLI entry point or renderer import.
// Keeping this dependency neutral also preserves direct CLI top-level-await
// completion when the browser runner dynamically loads the NVIDIA observer.
import assert from 'node:assert/strict';

export function assertExactOrigin(url,origin){assert.equal(new URL(url).origin,origin,'Foreign origin refused');}
export async function establishPreviewSession(context,origin,secret){
 if(!secret)return;
 const response=await context.request.get(origin,{headers:{'x-vercel-protection-bypass':secret,'x-vercel-set-bypass-cookie':'true'},maxRedirects:0});
 assert.ok([200,302,303,307,308].includes(response.status()),'Preview access refused');
 const location=response.headers().location;if(location)assertExactOrigin(new URL(location,origin).href,origin);
 const cookie=(await context.cookies()).find(c=>c.name==='_vercel_jwt'&&c.secure);
 await context.clearCookies();assert.ok(cookie,'Preview session not established');
 await context.addCookies([{name:cookie.name,value:cookie.value,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
}
