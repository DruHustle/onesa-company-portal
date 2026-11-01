// Real hosted public-renderer observations. This helper never writes a PASS
// receipt, starts a fixture server, fulfills/intercepts a response or contacts a
// business-write endpoint. Adverse graphics cases change only their own browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {assertExactOrigin,establishPreviewSession} from './oracle_portal_browser_session.mjs';
import {CONTRACT,pinnedCatalog,publicReferences,assertDeliveredAsset} from './oracle_portal_nvidia_contract.mjs';

const catalogPath=new URL('../../onesa-company-portal-frontend/public/models/nvidia/manifest.json',import.meta.url);
const licensePath=new URL('../../onesa-company-portal-frontend/public/licenses/three.txt',import.meta.url);
const tags=['wcag2a','wcag2aa','wcag21aa','wcag22aa'];
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function visit(page,origin,locale,index=false){
 const response=await page.goto(`${origin}/${locale}/products${index?'':'/onesa-drone'}`,{waitUntil:'domcontentloaded'});
 assertExactOrigin(page.url(),origin);assert.ok(response?.ok(),'NVIDIA document must succeed');
 const section=page.locator('#nvidia-environments');await expect(section).toHaveCount(1);await section.scrollIntoViewIfNeeded();
 return section;
}

async function loadedPreview(section,locale){
 const preview=section.getByAltText(locale==='de'?/Gerenderte Vorschau/:/Rendered preview/);
 await expect(preview).toBeVisible();await expect.poll(()=>preview.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);
 await preview.evaluate(node=>node.decode());return true;
}

async function readyCanvas(section){
 await expect(section).toHaveAttribute('data-state','ready',{timeout:30000});
 await expect(section.locator('canvas')).toHaveCount(1);
 const graphics=await section.locator('canvas').evaluate(canvas=>{
  const gl=canvas.getContext('webgl2');
  return {graphics_api:gl instanceof WebGL2RenderingContext?'WebGL2':null,context_lost:gl?.isContextLost()??true,width:gl?.drawingBufferWidth??0,height:gl?.drawingBufferHeight??0};
 });
 assert.equal(graphics.graphics_api,'WebGL2');assert.equal(graphics.context_lost,false);assert.ok(graphics.width>0&&graphics.height>0);
 return {render_state:await section.getAttribute('data-state'),canvas_count:await section.locator('canvas').count(),graphics_api:graphics.graphics_api,context_lost:graphics.context_lost};
}

export async function observeNvidia(browser,engine,request,directory){
 assert.ok(CONTRACT.engines.includes(engine));
 // Pin checks precede JSON parsing or hosted traffic. Paths are immutable image
 // inputs; neither request JSON nor environment variables select source files.
 assert.ok(fs.statSync(catalogPath).size<32768&&fs.statSync(licensePath).size<32768);
 const bytes=fs.readFileSync(catalogPath),license=fs.readFileSync(licensePath);
 const catalog=pinnedCatalog(bytes,license,request),references=publicReferences(catalog,bytes,license);
 const counts={operational_mutations:0,javascript_errors:0,accessibility_violations:0,speculative_prefetches:0};
 const views=[],fallbacks=[],assetDeliveries=[];
 async function context(options={}){
  const value=await browser.newContext({viewport:{width:320,height:950},colorScheme:'light',reducedMotion:'reduce',...options});
  await establishPreviewSession(value,request.origin,request.bypass);return value;
 }
 async function pageFor(value){
  const page=await value.newPage();page.setDefaultNavigationTimeout(30000);page.setDefaultTimeout(10000);
  page.on('pageerror',()=>counts.javascript_errors++);
  page.on('request',r=>{
   if(!['GET','HEAD'].includes(r.method()))counts.operational_mutations++;
   if(r.headers()['next-router-prefetch']==='1')counts.speculative_prefetches++;
  });
  return page;
 }
 const delivery=await context();
 try{
  for(const [path,expected]of references){
   const response=await delivery.request.get(request.origin+path,{maxRedirects:0,timeout:20000});
   try{
    assert.equal(response.status(),200,'Hosted NVIDIA public asset must succeed without redirect');
    const headers=response.headers(),length=headers['content-length'];
    if(length!==undefined){assert.ok(Number.isSafeInteger(Number(length))&&Number(length)>0&&Number(length)<=2_000_000);if(!headers['content-encoding']||headers['content-encoding']==='identity')assert.equal(Number(length),expected.byteLength);}
    const row=assertDeliveredAsset({origin:request.origin,path,status:response.status(),url:response.url(),redirects:0,method:'GET',body:await response.body()},expected);
    assetDeliveries.push({engine,...row});
   }finally{await response.dispose();}
  }
 }finally{await delivery.close();}

 for(const locale of CONTRACT.locales)for(const width of CONTRACT.widths)for(const mode of CONTRACT.modes){
  const value=await context({viewport:{width,height:950},colorScheme:mode});
  try{
   const page=await pageFor(value),received=new Map(),pending=[],failures=[];let modelRequests=0;
   page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('.glb'))modelRequests++;});
   page.on('response',response=>{
    const url=new URL(response.url());if(!url.pathname.endsWith('.glb'))return;
    const task=(async()=>{
     assertExactOrigin(response.url(),request.origin);assert.ok(references.has(url.pathname),'Uncatalogued model refused');
     const source=response.request();assert.equal(source.headers().authorization,undefined);
     const row=assertDeliveredAsset({origin:request.origin,path:url.pathname,status:response.status(),url:response.url(),redirects:source.redirectedFrom()?1:0,method:source.method(),body:await response.body()},references.get(url.pathname));
     received.set(url.pathname,row);
    })().catch(error=>{failures.push(error);});pending.push(task);
   });
   const section=await visit(page,request.origin,locale),choices=section.getByRole('group').getByRole('button'),assets=[];
   await expect(choices).toHaveCount(3);
   for(const [index,asset]of catalog.assets.entries()){
    await choices.nth(index).click();await expect(choices.nth(index)).toHaveAttribute('aria-pressed','true');
    const graphics=await readyCanvas(section);await frames(page);
    const path='/models/nvidia/'+asset.glb.path;
    await expect.poll(()=>received.has(path)||failures.length>0).toBe(true);assert.deepEqual(failures,[]);
    const slider=section.getByRole('slider');await slider.focus();await slider.press('ArrowRight');await expect(slider).toHaveValue('1');
    const keyboard=Number(await slider.inputValue());await section.getByRole('button',{name:locale==='de'?'Ansicht zurücksetzen':'Fit view',exact:true}).click();await expect(slider).toHaveValue('0');
    await expect(section.locator('figcaption a').filter({hasText:'NVIDIA SimReady'})).toHaveAttribute('href',asset.sourceUrl);
    await expect(section.getByRole('link',{name:'CC BY 4.0',exact:true})).toHaveAttribute('href','/models/nvidia/'+asset.licenseFile.path);
    assets.push({id:asset.id,...received.get(path),...graphics,keyboard_rotation:keyboard,fit_rotation:Number(await slider.inputValue())});
   }
   await Promise.all(pending);assert.deepEqual(failures,[]);assert.equal(received.size,3);
   await section.locator('summary').click();await expect(section.getByRole('link',{name:locale==='de'?'Renderer-Lizenz':'Renderer license',exact:true})).toHaveAttribute('href','/licenses/three.txt');
   const before=modelRequests;await page.emulateMedia({colorScheme:mode==='light'?'dark':'light'});await frames(page);await readyCanvas(section);
   await page.emulateMedia({colorScheme:mode});await frames(page);assert.equal(modelRequests,before,'Appearance changes must retain the model');
   assert.equal(await choices.locator('span').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const audit=await new AxeBuilder({page}).include('#nvidia-environments').withTags(tags).analyze();counts.accessibility_violations+=audit.violations.length;assert.deepEqual(audit.violations.map(v=>v.id),[]);
   await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});await frames(page);
   const overflow=await section.locator('p,h2').evaluateAll(nodes=>nodes.some(node=>{const box=node.getBoundingClientRect();return box.left<0||box.right>innerWidth+1||node.scrollWidth>node.clientWidth+1;}));
   assert.equal(overflow,false,'Enlarged text must reflow');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.evaluate(()=>{document.documentElement.style.fontSize='';});await frames(page);
   await section.screenshot({path:`${directory}/${engine}-${locale}-${width}-${mode}-nvidia.png`});
   views.push({engine,locale,width,mode,assets,theme_model_reload_count:modelRequests-before,accessibility_violations:audit.violations.length,horizontal_overflow:false,enlarged_text_overflow:overflow});
  }finally{await value.close();}
 }

 for(const locale of CONTRACT.locales){
  const row={engine,locale};
  const recovery=await context();
  try{
   const page=await pageFor(recovery),section=await visit(page,request.origin,locale);await readyCanvas(section);
   await section.locator('canvas').evaluate(canvas=>{const extension=canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');if(!extension)throw Error('Required context-loss observation unavailable');extension.loseContext();});
   await expect(section).toHaveAttribute('data-state','failed');row.context_loss_state=await section.getAttribute('data-state');await loadedPreview(section,locale);
   await section.getByRole('button',{name:locale==='de'?'Erneut versuchen':'Retry 3D view',exact:true}).click();await readyCanvas(section);row.context_recovery_state=await section.getAttribute('data-state');
   const index=await visit(page,request.origin,locale,true),choices=index.getByRole('group').getByRole('button');row.product_index_asset_ids=[];
   for(const [number,asset]of catalog.assets.entries()){await choices.nth(number).click();await expect(choices.nth(number)).toHaveAttribute('aria-pressed','true');await readyCanvas(index);row.product_index_asset_ids.push(asset.id);}
   row.product_index_state=await index.getAttribute('data-state');
  }finally{await recovery.close();}
  const noGraphics=await context();
  try{
   // This adverse browser capability is explicit; no served response is forged.
   await noGraphics.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return String(type).includes('webgl')?null:original.call(this,type,...args);};});
   const page=await pageFor(noGraphics),section=await visit(page,request.origin,locale);await expect(section).toHaveAttribute('data-state','unavailable');await expect(section.getByRole('status')).toBeVisible();
   row.no_graphics_state=await section.getAttribute('data-state');row.no_graphics_preview_loaded=await loadedPreview(section,locale);
  }finally{await noGraphics.close();}
  const noScript=await context({javaScriptEnabled:false});
  try{const page=await pageFor(noScript),section=await visit(page,request.origin,locale);row.no_script_preview_loaded=await loadedPreview(section,locale);}
  finally{await noScript.close();}
  fallbacks.push(row);
 }
 for(const count of Object.values(counts))assert.equal(count,0);
 return {views,fallbacks,asset_deliveries:assetDeliveries,counts};
}
