import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {stat,lstat,readFile,mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(await stat(name).then(()=>true,()=>false),false,'Isolated fixture requires a clean frontend checkout');
const catalog=JSON.parse(await readFile(new URL('../public/models/nvidia/manifest.json',import.meta.url),'utf8'));
const knownIds=['nvidia-transfer-conveyor','nvidia-mobile-cart','nvidia-storage-rack'];
const knownModels=new Map(catalog.assets.filter(asset=>knownIds.includes(asset.id)).map(asset=>['/models/nvidia/'+asset.glb.path,asset.id]));
const backend=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.writeHead(404).end('{}');});await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p','3348'],{env:{...process.env,PUBLIC_RELEASE_ENABLED:'false',BACKEND_URL:`http://127.0.0.1:${backend.address().port}`,SITE_URL:'http://127.0.0.1:3348'},stdio:'ignore'});
let browser,active;
async function publicInteractionDiagnostic(){
 if(!active)return;
 const record={schema_version:1,state:'DRONE_PRODUCT_INTERACTION_FAILED',locale:active.locale,width:active.width,mode:active.mode,phase:active.phase,browser_connected:browser?.isConnected()??false,page_closed:active.page.isClosed(),javascript_errors:Math.min(active.errors.length,1000000),crashes:Math.min(active.crashes,1000000),models:active.models,geometry:null};
 if(active.phase==='aircraft_details'&&!record.page_closed){
  let timer;
  try{record.geometry=await Promise.race([
   active.page.locator('main details').filter({has:active.page.locator('svg[role="img"]')}).locator('summary').evaluate(node=>{
    const bounded=value=>Number.isFinite(value)?Math.round(Math.max(-1e6,Math.min(1e6,value))*100)/100:null,box=node.getBoundingClientRect(),state=document.querySelector('#nvidia-environments')?.getAttribute('data-state');
    return {left:bounded(box.left),top:bounded(box.top),width:bounded(box.width),height:bounded(box.height),client_width:bounded(node.clientWidth),scroll_width:bounded(node.scrollWidth),details_open:node.parentElement.open===true,renderer_state:['loading','ready','failed','unavailable'].includes(state)?state:'other'};
   },undefined,{timeout:750}).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);}),
  ]);}finally{clearTimeout(timer);}
 }
 const bytes=JSON.stringify(record);assert.ok(Buffer.byteLength(bytes)<=8192);console.error(bytes);
 try{
  for(const relative of ['../','../test-results/','../test-results/public-diagnostics/']){const directory=fileURLToPath(new URL(relative,import.meta.url)).replace(/\/$/,'');let info;try{info=await lstat(directory);}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(directory);info=await lstat(directory);}assert.ok(info.isDirectory()&&!info.isSymbolicLink());}
  await writeFile(new URL('../test-results/public-diagnostics/drone-product-interaction.json',import.meta.url),bytes,{mode:0o600,flag:'wx'});
 }catch{console.error('{"state":"PUBLIC_INTERACTION_DIAGNOSTIC_UNAVAILABLE"}');}
}
try{
 for(let i=0;i<60;i++){if(await fetch('http://127.0.0.1:3348/en/products/onesa-drone').then(r=>r.ok,()=>false))break;await delay(500);}
 for(const locale of ['en','de']){
  const old=await fetch(`http://127.0.0.1:3348/${locale}/products/onesa-ai-drone`,{redirect:'manual'});
  assert.equal(old.status,308);assert.equal(new URL(old.headers.get('location'),'http://127.0.0.1:3348').pathname,`/${locale}/products/onesa-drone`);
 }
 browser=await chromium.launch();let views=0;
 for(const locale of ['en','de'])for(const colorScheme of ['light','dark'])for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:950},colorScheme,reducedMotion:'reduce'});const page=await context.newPage();const errors=[],motionRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',request=>{if(request.url().endsWith('.mp4'))motionRequests.push(request.url());});
  const observed={locale,width,mode:colorScheme,phase:'navigation',page,errors,crashes:0,models:[]},requests=new WeakMap();active=observed;
  page.on('crash',()=>observed.crashes++);
  page.on('request',request=>{const url=new URL(request.url()),id=url.origin==='http://127.0.0.1:3348'?knownModels.get(url.pathname):undefined;if(!id||observed.models.length>=12)return;const state={asset_id:id,terminal:'pending',status:null};observed.models.push(state);requests.set(request,state);});
  page.on('response',response=>{const state=requests.get(response.request());if(state)state.status=response.status();});
  page.on('requestfinished',request=>{const state=requests.get(request);if(state)state.terminal='finished';});
  page.on('requestfailed',request=>{const state=requests.get(request);if(state){state.terminal='failed';const code=request.failure()?.errorText;state.failure_code=['net::ERR_ABORTED','net::ERR_CONTENT_LENGTH_MISMATCH','NS_BINDING_ABORTED'].includes(code)?code:'other';}});
  await page.goto(`http://127.0.0.1:3348/${locale}/products/onesa-drone`);assert.equal(await page.locator('h1').textContent(),'Onesa Drone');assert.ok(await page.getByText('Intelligent Delivery Beyond Roads',{exact:true}).isVisible());
  observed.phase='images';
  for(const image of await page.locator('img[src*="/images/drone-"]').all()) {await image.scrollIntoViewIfNeeded();await image.evaluate(node=>node.decode());assert.ok(await image.evaluate(node=>node.naturalWidth>0));}
  observed.phase='film_before_play';
  const film=page.locator('video');await film.scrollIntoViewIfNeeded();assert.equal(await film.getAttribute('src'),null);assert.equal(await film.getAttribute('autoplay'),null);assert.deepEqual(motionRequests,[],'The concept film must not download before a play request, including with reduced motion');
  observed.phase='aircraft_details';
  await page.locator('main details').filter({has:page.locator('svg[role="img"]')}).locator('summary').click();const slider=page.locator('main details').filter({has:page.locator('svg[role="img"]')}).getByRole('slider');await slider.fill('-30');assert.equal(await slider.inputValue(),'-30');assert.ok(await page.locator(`a[href="/${locale}/contact?topic=drone"]`).first().isVisible());
  observed.phase='accessibility';
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);assert.deepEqual(errors,[]);
  observed.phase='product_index';await page.goto(`http://127.0.0.1:3348/${locale}/products`);assert.ok(await page.locator('#product-drone').isVisible());assert.ok(await page.locator(`a[href="/${locale}/products/onesa-drone"]`).first().isVisible());const preview=page.locator('#product-drone img');await preview.scrollIntoViewIfNeeded();await preview.evaluate(node=>node.decode());
  if(locale==='en'&&colorScheme==='light'&&width===1440){
   observed.phase='film_play';
   await page.goto('http://127.0.0.1:3348/en/products/onesa-drone');await page.getByRole('button',{name:/Play concept film/}).click();
   await page.waitForFunction(()=>{const film=document.querySelector('video');return film?.readyState>=2&&!film.paused;});
   assert.ok(motionRequests.length>0);assert.equal(await page.locator('video').evaluate(node=>node.controls),true);assert.equal(await page.locator('video').evaluate(node=>node.duration),12);await page.locator('video').evaluate(node=>node.pause());
   observed.phase='home_card';await page.goto('http://127.0.0.1:3348/en');assert.ok(await page.locator('#product-drone').isVisible());assert.ok(await page.locator('#product-drone a[href="/en/products/onesa-drone"]').isVisible());
   observed.phase='film_failure';
   await page.route('**/media/onesa-drone-concept.mp4',route=>route.abort());await page.goto('http://127.0.0.1:3348/en/products/onesa-drone');await page.getByRole('button',{name:/Play concept film/}).click();await page.getByRole('status').filter({hasText:'The film could not play'}).waitFor();
  }
  await context.close();views++;active=null;
 }
 const noJs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const staticPage=await noJs.newPage();await staticPage.goto('http://127.0.0.1:3348/en/products/onesa-drone');assert.ok(await staticPage.getByRole('heading',{name:'Onesa Drone',exact:true}).isVisible());assert.equal(await staticPage.locator('video').getAttribute('src'),null);assert.equal(await staticPage.locator('img[src*="/images/drone-"]').count(),2);await noJs.close();
 console.log(JSON.stringify({scope:'LOCAL_SYNTHETIC_NOT_HOSTED',productViews:views,languages:['en','de'],widths:[390,1440],appearance:['light','dark'],axe:'passed',interactiveConcept:'passed',existingEnquiryLink:'passed',responsiveImages:'passed',onDemandFilm:'passed',failedPlayback:'passed',noJavaScript:'passed'}));
}catch(error){try{await publicInteractionDiagnostic();}catch{console.error('{"state":"PUBLIC_INTERACTION_DIAGNOSTIC_UNAVAILABLE"}');}throw error;}finally{await browser?.close();server.kill('SIGTERM');backend.close();}
