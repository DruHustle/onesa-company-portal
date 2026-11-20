import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {chromium, firefox, webkit} from '@playwright/test';
const compiled=ts.transpileModule(await readFile('src/lib/hero-motion.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const fixture={desktop:'/images/hero-motion-desktop.webm',mobile:'/images/hero-motion-mobile.mp4',durationSeconds:4,desktopBytes:1000,mobileBytes:500,desktopSha256:'a'.repeat(64),mobileSha256:'b'.repeat(64),rightsRecord:'synthetic-test-only'};
const selected=(process.env.ONESA_HERO_TEST_ENGINES??'chromium,firefox,webkit').split(',');
assert.ok(selected.length&&selected.every(name=>['chromium','firefox','webkit'].includes(name)));
let cases=0;
for(const [name,engine]of Object.entries({chromium,firefox,webkit})){
 if(!selected.includes(name))continue;
 let owned;const options={};
 if(name==='firefox'&&process.platform==='darwin'){owned=await mkdtemp(path.join(os.tmpdir(),'onesa-hero-firefox-'));for(const part of ['Library','Library/Application Support','Library/Caches'])await mkdir(path.join(owned,part),{recursive:true,mode:0o700});options.env={PATH:process.env.PATH,LANG:'en_US.UTF-8',TMPDIR:os.tmpdir(),CFFIXED_USER_HOME:owned}}
 const browser=await engine.launch(options);
 try{
  for(const mode of ['reduced','save-data','slow','invalid','rejected','playing-stop','mobile','stalled']){
   const page=await browser.newPage({viewport:{width:mode==='mobile'?390:1440,height:844},reducedMotion:mode==='reduced'?'reduce':'no-preference'});
   await page.route('https://hero-fixture.invalid/**',route=>route.request().resourceType()==='document'?route.fulfill({contentType:'text/html',body:'<main><h1>Company heading</h1><div id="hero"><picture><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture></div></main>'}):route.abort());
   await page.goto('https://hero-fixture.invalid/');
   const output=await page.evaluate(async({compiled,fixture,mode})=>{
    const module={exports:{}};new Function('exports','module',compiled)(module.exports,module);
    const connection=new EventTarget();Object.assign(connection,mode==='save-data'?{saveData:true}:mode==='slow'?{effectiveType:'2g'}:{effectiveType:'4g'});
    Object.defineProperty(navigator,'connection',{value:connection,configurable:true});
    const assigned=[];const original=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
    Object.defineProperty(HTMLMediaElement.prototype,'src',{configurable:true,get(){return original.get.call(this)},set(value){assigned.push(value);original.set.call(this,value)}});
    HTMLMediaElement.prototype.load=function(){};HTMLMediaElement.prototype.pause=function(){};
    HTMLMediaElement.prototype.play=function(){if(mode==='rejected')return Promise.reject(new Error('Synthetic autoplay refusal'));if(mode!=='stalled')this.dispatchEvent(new Event('playing'));return Promise.resolve()};
    const img=document.querySelector('img');if(!img.complete)await new Promise(resolve=>img.addEventListener('load',resolve,{once:true}));
    const cleanup=module.exports.startHeroMotion(document.querySelector('#hero'),mode==='invalid'?{...fixture,desktop:'https://unapproved.invalid/video.mp4'}:fixture);
    await new Promise(resolve=>setTimeout(resolve,mode==='stalled'?5200:20));
    const before={assigned:[...assigned],video:!!document.querySelector('video'),playing:document.querySelector('video')?.dataset.playing,poster:!!document.querySelector('picture img'),heading:document.querySelector('h1').textContent};
    if(mode==='playing-stop'){connection.saveData=true;connection.dispatchEvent(new Event('change'))}
    const stoppedOnConstraint=mode!=='playing-stop'||!document.querySelector('video');
    cleanup();return {...before,stoppedOnConstraint,removedAfterCleanup:!document.querySelector('video')};
   },{compiled,fixture,mode});
   assert.equal(output.poster,true);assert.equal(output.heading,'Company heading');assert.equal(output.removedAfterCleanup,true);assert.equal(output.stoppedOnConstraint,true);
   if(['reduced','save-data','slow','invalid'].includes(mode)){assert.deepEqual(output.assigned,[]);assert.equal(output.video,false)}
   if(['rejected','stalled'].includes(mode)){assert.equal(output.assigned.length,1);assert.equal(output.video,false)}
   if(['playing-stop','mobile'].includes(mode)){assert.equal(output.playing,'true');assert.equal(output.assigned.length,1)}
   if(mode==='mobile')assert.equal(output.assigned[0],fixture.mobile);
   if(mode==='playing-stop')assert.equal(output.assigned[0],fixture.desktop);
   cases++;console.log(JSON.stringify({engine:name,case:mode,status:'PASS'}));await page.close();
  }
 }finally{await browser.close();if(owned)console.log(JSON.stringify({engine:name,owned_synthetic_browser_data_retained:true,reason:'macOS application-data cleanup requires separate handling'}))}
}
console.log(JSON.stringify({status:'PASS',cases,synthetic_DOM_controls:true,real_video_codec_or_performance_acceptance:false,application_or_provider_requests:0}));
