// Immutable anonymous hosted observations for the existing owner-run bridge.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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
export async function visitHome(page,origin,locale){
 assert.ok(['en','de'].includes(locale));
 const response=await page.goto(origin+(locale==='en'?'/':'/de'),{waitUntil:'domcontentloaded'});
 assertExactOrigin(page.url(),origin);assert.ok(response?.ok(),'Home document must return a successful response');
 // Readiness is the actual rendered contract. Media/background connections can
 // outlive a usable page; network-idle is not an application readiness signal.
 await expect(page.locator('#home-robot-title')).toHaveText('Onesa AI Robot');
 await expect(page.locator('#home-robot-title')).toBeVisible();
}
export async function verifyRobotInspectionNotice(section,locale){
 assert.ok(['en','de'].includes(locale));
 await expect(section).toContainText('P-101');
 await expect(section).toContainText(locale==='en'?'Supervised synthetic Pump P-101 inspection':'überwachte synthetische Inspektion der Pumpe P-101');
 await expect(section).toContainText(locale==='en'?'next development candidate and awaits separate release verification':'nächste Entwicklungskandidat und benötigt eine eigene Freigabe');
 await expect(section).toContainText(locale==='en'?'physical control require their own integration and qualification':'physische Steuerung benötigen eine eigene Integration und Qualifikation');
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
export async function visitDronePresentation(page,origin,locale){
 assert.ok(['en','de'].includes(locale));
 const requested=[];
 const track=request=>{const url=new URL(request.url());if(url.origin===origin&&url.pathname==='/media/onesa-drone-concept.mp4')requested.push(url.pathname);};
 page.on('request',track);
 try{
  const response=await page.goto(`${origin}/${locale}/products/onesa-drone`,{waitUntil:'domcontentloaded'});
  assertExactOrigin(page.url(),origin);assert.ok(response?.ok(),'Drone document must return a successful response');
  assert.equal(await page.getByRole('link',{name:locale==='en'?'Explore the platform':'Plattform entdecken',exact:true}).getAttribute('href'),'https://drone.onesa.eu');
  await expect(page.locator('#drone-title')).toHaveText('Onesa Drone');
  await expect(page.locator('#drone-title')).toBeVisible();
  await expect(page.locator('main')).toContainText(locale==='en'?'simulation only':'ausschließlich für Simulation');
  for(const image of await page.locator('img[src*="/images/drone-"]').all()){
   await image.scrollIntoViewIfNeeded();
   await expect.poll(()=>image.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);
   await image.evaluate(node=>node.decode());assert.ok(await image.evaluate(node=>node.naturalWidth>0));
  }
  assert.equal(await page.locator('img[src*="/images/drone-"]').count(),2);
  const video=page.locator('video');await video.scrollIntoViewIfNeeded();
  assert.equal(await video.getAttribute('src'),null);assert.equal(await video.getAttribute('autoplay'),null);assert.equal(await video.getAttribute('preload'),'none');assert.deepEqual(requested,[],'Film must remain unloaded before explicit play');
  const play=page.getByRole('button',{name:locale==='en'?/Play concept film/:/Konzeptfilm abspielen/});
  await play.focus();await expect(play).toBeFocused();await play.press('Enter');
  await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=2&&!video.paused;},null,{timeout:10000});
  assert.ok(requested.length>0);assert.equal(await video.evaluate(node=>node.controls),true);assert.equal(await video.evaluate(node=>node.duration),12);await video.evaluate(node=>node.pause());
  await page.locator('main details summary').click();const slider=page.getByRole('slider');const angle=Number(await slider.inputValue());await slider.focus();await slider.press('ArrowRight');await expect(slider).toHaveValue(String(angle+1));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();assert.deepEqual(audit.violations.map(row=>row.id),[]);
  await expect(page.locator(`a[href="/${locale}/contact?topic=drone"]`).first()).toBeVisible();
  return {presentation:'PASS',interactive_concept:'PASS',platform_link:'PASS',deferred_media:'PASS',keyboard_playback:'PASS',accessibility_violations:audit.violations.length,horizontal_overflow:false};
 }catch(error){
  // Public fixed-field transport/render state only. Never page HTML, text,
  // headers, cookies, credentials or arbitrary request/response bodies.
  const state=await page.evaluate(()=>{
   const video=document.querySelector('video');
   return {images:[...document.querySelectorAll('img[src*="/images/drone-"]')].map(node=>({complete:node.complete,width:node.naturalWidth})),video:video?{ready:video.readyState,network:video.networkState,error_code:video.error?.code??null,paused:video.paused,controls:video.controls,mp4_support:video.canPlayType('video/mp4; codecs="avc1.42E01E"')}:null};
  }).catch(()=>({observation_unavailable:true}));
  console.error(JSON.stringify({state:'PUBLIC_PRODUCT_OBSERVATION_FAILED',requested_media:requested.length,render:state}));throw error;
 }finally{page.off('request',track);}
}
export async function checkDroneRoutes(page,origin,locale){
 const legacy=await page.request.get(`${origin}/${locale}/products/onesa-ai-drone`,{maxRedirects:0});assert.equal(legacy.status(),308);
 assert.equal(new URL(legacy.headers().location,origin).href,`${origin}/${locale}/products/onesa-drone`);
 const contact=await page.goto(`${origin}/${locale}/contact?topic=drone`,{waitUntil:'domcontentloaded'});assertExactOrigin(page.url(),origin);assert.ok(contact?.ok());
 await expect(page.locator('select[name="topic"]')).toHaveValue('drone');
}
async function observeUI(request,directory,engines,status){
 assert.equal(request.binding.repository,'DruHustle/onesa-company-portal');
 assert.equal(request.binding.component,'frontend');
 assert.equal(request.provider_token_included,false);
 assert.ok(['staging','production'].includes(request.environment));
 let errors=0,mutations=0,violations=0,speculativePrefetches=0;const views=[],droneViews=[];
 for(const [name,type]of Object.entries(engines)){
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:390,height:900},colorScheme:'dark',reducedMotion:'reduce'});
   await establishPreviewSession(context,request.origin,request.bypass);
   const page=await context.newPage();
   page.on('pageerror',()=>errors++);
   page.on('request',r=>{const u=new URL(r.url());if(u.origin===request.origin&&r.headers()['next-router-prefetch']==='1')speculativePrefetches++;if(u.origin===request.origin&&!['GET','HEAD'].includes(r.method()))mutations++;});
   for(const locale of ['en','de'])for(const [width,mode]of [[390,'dark'],[1440,'light'],[320,'light']]){
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode});
    await visitHome(page,request.origin,locale);
    const section=page.locator('section').filter({has:page.locator('#home-robot-title')});
    await verifyRobotInspectionNotice(section,locale);
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
    views.push({engine:name,locale,width,mode,robot_copy:'PASS',product_navigation:'PASS',horizontal_overflow:false});
    const drone=await visitDronePresentation(page,request.origin,locale);
    await page.screenshot({path:`${directory}/${name}-${locale}-${width}-${mode}-drone.png`,fullPage:width===390});
    droneViews.push({engine:name,locale,width,mode,...drone});
   }
   for(const locale of ['en','de'])await checkDroneRoutes(page,request.origin,locale);
   const contact=await page.goto(request.origin+'/en/contact?topic=robot',{waitUntil:'domcontentloaded'});assert.ok(contact?.ok(),'Contact document must return a successful response');
   await expect(page.getByRole('heading',{level:1})).toBeVisible();
   // Inspect only: this probe submits no enquiry, sign-in, publication or file.
   await checkAnonymousBoundaries(request,page.request);
   await context.close();
  }finally{await browser.close();}
 }
 assert.equal(errors,0);assert.equal(mutations,0);assert.equal(violations,0);assert.equal(speculativePrefetches,0);
 const receipt={status,binding:request.binding,environment:request.environment,engines:Object.keys(engines),views,drone_views:droneViews,speculative_prefetches:speculativePrefetches,operational_mutations:mutations,javascript_errors:errors,accessibility_violations:violations,observed_at:new Date().toISOString(),scope:'public-product-presentation-and-unchanged-private-boundaries-no-owner-session-claim'};
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
