// Shared origin/session assertions have no CLI entry point or renderer import.
// Keeping this dependency neutral also preserves direct CLI top-level-await
// completion when the browser runner dynamically loads the NVIDIA observer.
import assert from 'node:assert/strict';

export function assertFrontendSourceBinding(binding){
 assert.equal(binding.component,'frontend');
 if(binding.repository==='DruHustle/onesa-company-portal')return;
 assert.equal(binding.repository,'DruHustle/onesa-ug');assert.equal(binding.schema_version,2);
 assert.equal(binding.repository_id,1444746154);assert.equal(binding.product,'portal');
 assert.equal(binding.source_path,'onesa-company-portal');assert.equal(binding.branch,'main');
 assert.equal(binding.target_environment,'production');
 for(const key of ['candidate_commit','source_tree','product_source_tree'])assert.match(binding[key],/^[a-f0-9]{40}$/);
 assert.match(binding.source_sha256,/^[a-f0-9]{64}$/);
}

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
