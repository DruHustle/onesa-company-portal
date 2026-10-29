// Immutable anonymous hosted observations for the existing owner-run bridge.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
export async function visitHome(page,origin,locale){
 assert.ok(['en','de'].includes(locale));
 const response=await page.goto(origin+(locale==='en'?'/':'/de'),{waitUntil:'domcontentloaded'});
 assert.ok(response?.ok(),'Home document must return a successful response');
 // Readiness is the actual rendered contract. Media/background connections can
 // outlive a usable page; network-idle is not an application readiness signal.
 await expect(page.locator('#home-robot-title')).toHaveText('Onesa AI Robot');
 await expect(page.locator('#home-robot-title')).toBeVisible();
}
export async function checkAnonymousBoundaries(request,client){
 const targets=request.environment==='production'
  ? [['https://onesa.eu',403],['https://portal.onesa.eu',401]]
  : [[request.origin,401]];
 for(const [origin,expected]of targets){
  for(const path of ['/api/v1/auth/me','/api/v1/admin/content','/api/v1/admin/governance/records']){
   assert.equal((await client.get(origin+path)).status(),expected);
  }
 }
}
// Copied from the tested Onesa Drone ff493035 origin policy. No runtime sibling import.
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
export async function visitDroneProduct(page,request,{engine,locale,width,mode,motionRequests}){
 const prefix=locale==='en'?'/en':'/de';const productPath=prefix+'/products/onesa-drone';
 const before=motionRequests();
 const response=await page.goto(request.origin+productPath,{waitUntil:'domcontentloaded'});
 assertExactOrigin(page.url(),request.origin);assert.ok(response?.ok(),'Drone product document unavailable');
 await expect(page.locator('#drone-title')).toHaveText('Onesa Drone');
 await expect(page.locator('#drone-title')).toBeVisible();
 await expect(page.locator('main')).toContainText(locale==='en'?'UNDER DEVELOPMENT · SIMULATION ONLY':'IN ENTWICKLUNG · NUR SIMULATION');
 await expect(page.locator('main')).toContainText(locale==='en'?'No operational delivery service, flight authorization or certification is offered.':'Keine betrieblichen Lieferdienste, Flugfreigaben oder Zertifizierung werden angeboten.');
 const platform=page.getByRole('link',{name:locale==='en'?'Explore the platform':'Plattform entdecken',exact:true});
 assert.equal(await platform.getAttribute('href'),'https://drone.onesa.eu');
 const images=page.locator('main img[src*="/images/drone-"]');assert.equal(await images.count(),2);
 for(const image of await images.all()){await image.scrollIntoViewIfNeeded();await image.evaluate(node=>node.decode());assert.ok(await image.evaluate(node=>node.naturalWidth>0));}
 const film=page.locator('main video');assert.equal(await film.getAttribute('src'),null);assert.equal(await film.getAttribute('autoplay'),null);assert.equal(motionRequests(),before,'Film downloaded without a play request');
 await page.locator('main details summary').click();const slider=page.getByRole('slider');const angle=Number(await slider.inputValue());await slider.focus();await slider.press('ArrowRight');await expect(slider).toHaveValue(String(angle+1));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();assert.deepEqual(audit.violations.map(v=>v.id),[]);
 if(locale==='en'&&width===1440){await page.getByRole('button',{name:/Play concept film/}).click();await page.waitForFunction(()=>{const video=document.querySelector('main video');return video?.readyState>=2&&!video.paused;});assert.equal(await film.evaluate(v=>v.duration),12);await film.evaluate(v=>v.pause());}
 const legacy=await page.request.get(request.origin+prefix+'/products/onesa-ai-drone',{maxRedirects:0});assert.equal(legacy.status(),308);const target=new URL(legacy.headers().location,request.origin);assertExactOrigin(target.href,request.origin);assert.ok([productPath,...(locale==='en'?['/products/onesa-drone']:[])].includes(target.pathname));
 const enquiry=page.locator('main a[href="'+prefix+'/contact?topic=drone"]').first();await Promise.all([page.waitForURL(url=>url.origin===request.origin&&[prefix+'/contact',...(locale==='en'?['/contact']:[])].includes(url.pathname)&&url.searchParams.get('topic')==='drone',{waitUntil:'domcontentloaded'}),enquiry.click()]);assertExactOrigin(page.url(),request.origin);const contact=new URL(page.url());assert.ok([prefix+'/contact',...(locale==='en'?['/contact']:[])].includes(contact.pathname));assert.equal(contact.searchParams.get('topic'),'drone');
 await expect(page.locator('form select[name="topic"]')).toHaveValue('drone');await expect(page.locator('form select[name="category"]')).toHaveValue('enterprise');
 return {engine,locale,width,mode,surface:'drone',product_page:'PASS',interactive_concept:'PASS',existing_enquiry_link:'PASS',simulation_only:'PASS',on_demand_media:'PASS',platform_link:'PASS',horizontal_overflow:false};
}
async function observeUI(request,directory,engines,status){
 assert.equal(request.binding.repository,'DruHustle/onesa-company-portal');
 assert.equal(request.binding.component,'frontend');
 assert.equal(request.provider_token_included,false);
 assert.ok(['staging','production'].includes(request.environment));
 const scope=request.publication_scope??'existing-copy';assert.ok(['existing-copy','drone-product'].includes(scope));
 let errors=0,mutations=0,violations=0,speculativePrefetches=0;const views=[];
 for(const [name,type]of Object.entries(engines)){
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:390,height:900},colorScheme:'dark',reducedMotion:'reduce'});
   await establishPreviewSession(context,request.origin,request.bypass);
   const page=await context.newPage();let motionRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('.mp4'))motionRequests++;});
   page.on('pageerror',()=>errors++);
   page.on('request',r=>{const u=new URL(r.url());if(u.origin===request.origin&&r.headers()['next-router-prefetch']==='1')speculativePrefetches++;if(u.origin===request.origin&&!['GET','HEAD'].includes(r.method()))mutations++;});
   for(const locale of ['en','de'])for(const [width,mode]of [[390,'dark'],[1440,'light'],[320,'light']]){
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode});
    await visitHome(page,request.origin,locale);
    const section=page.locator('section').filter({has:page.locator('#home-robot-title')});
    await expect(section).toContainText('P-101');
    await expect(section).toContainText(locale==='en'?'synthetic':'synthetischen');
    const link=section.getByRole('link',{name:locale==='en'?'Explore robotics':'Robotik entdecken'});
    const destination=new URL(await link.getAttribute('href'),request.origin);assert.equal(destination.origin,request.origin);assert.ok([`/${locale}/products`,...(locale==='en'?['/products']:[])].includes(destination.pathname));assert.equal(destination.hash,'#product-robot');
    await Promise.all([
     page.waitForURL(url=>url.origin===destination.origin&&url.pathname===destination.pathname&&url.hash===destination.hash,{waitUntil:'domcontentloaded'}),
     link.click(),
    ]);
    await expect(page.locator('#product-robot')).toBeVisible();
    await expect(page.locator('article').filter({has:page.locator('#product-robot')})).toContainText('P-101');
    const root=page.locator('html');await expect(root).toBeVisible();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();violations+=audit.violations.length;
    if(audit.violations.length)fs.writeFileSync(`${directory}/${name}-${locale}-${width}-axe.json`,JSON.stringify(audit.violations),{flag:'wx',mode:0o600});
    assert.equal(audit.violations.length,0);
    await page.screenshot({path:`${directory}/${name}-${locale}-${width}-${mode}.png`,fullPage:width===390});
    views.push({engine:name,locale,width,mode,surface:'robot',robot_copy:'PASS',product_navigation:'PASS',horizontal_overflow:false});
   }
   if(scope==='drone-product')for(const locale of ['en','de'])for(const [width,mode]of [[390,'dark'],[1440,'light'],[320,'light']]){await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode});views.push(await visitDroneProduct(page,request,{engine:name,locale,width,mode,motionRequests:()=>motionRequests}));}
   const contact=await page.goto(request.origin+'/en/contact?topic=robot',{waitUntil:'domcontentloaded'});assert.ok(contact?.ok(),'Contact document must return a successful response');
   await expect(page.getByRole('heading',{level:1})).toBeVisible();
   // Inspect only: this probe submits no enquiry, sign-in, publication or file.
   await checkAnonymousBoundaries(request,page.request);
   await context.close();
  }finally{await browser.close();}
 }
 assert.equal(errors,0);assert.equal(mutations,0);assert.equal(violations,0);assert.equal(speculativePrefetches,0);
 const receipt={status,publication_scope:scope,binding:request.binding,environment:request.environment,engines:Object.keys(engines),views,speculative_prefetches:speculativePrefetches,operational_mutations:mutations,javascript_errors:errors,accessibility_violations:violations,observed_at:new Date().toISOString(),scope:scope==='drone-product'?'drone-public-product-and-unchanged-private-boundaries-no-owner-session-claim':'public-copy-and-unchanged-private-boundaries-no-owner-session-claim'};
 fs.writeFileSync(directory+'/browser-receipt.json',JSON.stringify(receipt),{flag:'wx',mode:0o600});return receipt;
}
export async function checkUI(request,directory,engines={chromium,firefox,webkit}){
 assert.match(request.origin,request.environment==='production'?/^https:\/\/onesa\.eu$/:/^https:\/\/onesa-company-portal-git-staging-[a-z0-9-]+\.vercel\.app$/);
 return observeUI(request,directory,engines,'PASS');
}
// Explicit local fixture entry; its receipt is deliberately ineligible for hosted qualification.
export async function checkSyntheticLocalUI(request,directory,engines={chromium,firefox,webkit}){
 assert.match(request.origin,/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/);
 assert.equal(request.environment,'staging');assert.equal(request.bypass,null);
 return observeUI(request,directory,engines,'LOCAL_SYNTHETIC_NOT_HOSTED');
}
if(process.argv[1]&&import.meta.url===new URL('file:'+process.argv[1]).href){const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));await checkUI(request,'/private/output');}
