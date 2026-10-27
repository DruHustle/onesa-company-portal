// Immutable anonymous hosted observations for the existing owner-run bridge.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,firefox,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function observeUI(request,directory,engines,status){
 assert.equal(request.binding.repository,'DruHustle/onesa-company-portal');
 assert.equal(request.binding.component,'frontend');
 assert.equal(request.provider_token_included,false);
 assert.ok(['staging','production'].includes(request.environment));
 let errors=0,mutations=0,violations=0,speculativePrefetches=0;const views=[];
 for(const [name,type]of Object.entries(engines)){
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:390,height:900},colorScheme:'dark',reducedMotion:'reduce',extraHTTPHeaders:request.bypass?{'x-vercel-protection-bypass':request.bypass}:{}});
   const page=await context.newPage();
   page.on('pageerror',()=>errors++);
   page.on('request',r=>{const u=new URL(r.url());if(u.origin===request.origin&&r.headers()['next-router-prefetch']==='1')speculativePrefetches++;if(u.origin===request.origin&&!['GET','HEAD'].includes(r.method()))mutations++;});
   for(const locale of ['en','de'])for(const [width,mode]of [[390,'dark'],[1440,'light'],[320,'light']]){
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:mode});
    const home=locale==='en'?'/':'/de';await page.goto(request.origin+home);await page.waitForLoadState('networkidle');
    await expect(page.locator('#home-robot-title')).toHaveText('Onesa AI Robot');
    const section=page.locator('section').filter({has:page.locator('#home-robot-title')});
    await expect(section).toContainText('P-101');
    await expect(section).toContainText(locale==='en'?'synthetic':'synthetischen');
    const link=section.getByRole('link',{name:locale==='en'?'Explore robotics':'Robotik entdecken'});
    const destination=new URL(await link.getAttribute('href'),request.origin);assert.ok([`/${locale}/products`,...(locale==='en'?['/products']:[])].includes(destination.pathname));assert.equal(destination.hash,'#product-robot');
    await link.click();await expect(page.locator('#product-robot')).toBeVisible();await page.waitForLoadState('networkidle');
    await expect(page.locator('article').filter({has:page.locator('#product-robot')})).toContainText('P-101');
    const root=page.locator('html');await expect(root).toBeVisible();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();violations+=audit.violations.length;
    if(audit.violations.length)fs.writeFileSync(`${directory}/${name}-${locale}-${width}-axe.json`,JSON.stringify(audit.violations),{flag:'wx',mode:0o600});
    assert.equal(audit.violations.length,0);
    await page.screenshot({path:`${directory}/${name}-${locale}-${width}-${mode}.png`,fullPage:width===390});
    views.push({engine:name,locale,width,mode,robot_copy:'PASS',product_navigation:'PASS',horizontal_overflow:false});
   }
   await page.goto(request.origin+'/en/contact?topic=robot');await page.waitForLoadState('networkidle');
   await expect(page.getByRole('heading',{level:1})).toBeVisible();
   // Inspect only: this probe submits no enquiry, sign-in, publication or file.
   for(const path of ['/api/v1/auth/me','/api/v1/admin/content','/api/v1/admin/governance/records'])assert.equal((await page.request.get(request.origin+path)).status(),401);
   await context.close();
  }finally{await browser.close();}
 }
 assert.equal(errors,0);assert.equal(mutations,0);assert.equal(violations,0);assert.equal(speculativePrefetches,0);
 const receipt={status,binding:request.binding,environment:request.environment,engines:Object.keys(engines),views,speculative_prefetches:speculativePrefetches,operational_mutations:mutations,javascript_errors:errors,accessibility_violations:violations,observed_at:new Date().toISOString(),scope:'public-copy-and-unchanged-private-boundaries-no-owner-session-claim'};
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
