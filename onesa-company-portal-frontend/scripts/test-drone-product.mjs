import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const name of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(await stat(name).then(()=>true,()=>false),false,'Isolated fixture requires a clean frontend checkout');
const backend=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.writeHead(404).end('{}');});await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p','3348'],{env:{...process.env,PUBLIC_RELEASE_ENABLED:'false',BACKEND_URL:`http://127.0.0.1:${backend.address().port}`,SITE_URL:'http://127.0.0.1:3348'},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<60;i++){if(await fetch('http://127.0.0.1:3348/en/products/onesa-ai-drone').then(r=>r.ok,()=>false))break;await delay(500);}
 browser=await chromium.launch();let views=0;
 for(const locale of ['en','de'])for(const colorScheme of ['light','dark'])for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:950},colorScheme,reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:3348/${locale}/products/onesa-ai-drone`);assert.equal(await page.locator('h1').textContent(),'Onesa AI Drone');assert.ok(await page.getByText('Intelligent Delivery Beyond Roads',{exact:true}).isVisible());
  const slider=page.getByRole('slider');await slider.fill('-30');assert.equal(await slider.inputValue(),'-30');assert.ok(await page.locator(`a[href="/${locale}/contact?topic=drone"]`).first().isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);assert.deepEqual(errors,[]);
  await page.goto(`http://127.0.0.1:3348/${locale}/products`);assert.ok(await page.locator('#product-drone').isVisible());assert.ok(await page.locator(`a[href="/${locale}/products/onesa-ai-drone"]`).first().isVisible());
  await context.close();views++;
 }
 console.log(JSON.stringify({scope:'LOCAL_SYNTHETIC_NOT_HOSTED',productViews:views,languages:['en','de'],widths:[390,1440],appearance:['light','dark'],axe:'passed',interactiveConcept:'passed',existingEnquiryLink:'passed'}));
}finally{await browser?.close();server.kill('SIGTERM');backend.close();}
