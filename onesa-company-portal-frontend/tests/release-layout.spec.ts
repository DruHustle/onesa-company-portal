import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const sections=['about','products','technology','industries','research','partnerships','careers','news','contact','impressum','privacy','cookies','accessibility'];
const widths=[320,390,768,1024,1440];
for(const [hour,mode] of [[20,'light'],[12,'dark']] as const) test(`release audit: responsive EN/DE ${mode} pages, reduced motion and axe`,async({page},info)=>{
 test.setTimeout(600000);
 await page.addInitScript(hour=>{Date.prototype.getHours=()=>hour;},hour); await page.emulateMedia({colorScheme:mode});
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const width of widths){
  await page.setViewportSize({width,height:900});
  const routes=width===320||width===1440?['/','/en','/de','/admin',...['en','de'].flatMap(locale=>sections.map(section=>`/${locale}/${section}`)), '/en/search','/de/search']:['/en','/de','/en/contact','/de/technology','/admin'];
  for(const route of routes){
   const response=await page.goto(route);
   const policy=response?.headers()['content-security-policy']||'';
   expect(policy).toContain("'nonce-");expect(policy).toContain("frame-ancestors 'none'");
   expect(policy).not.toContain("'unsafe-eval'");
expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe(mode);
   await expect(page.locator('.appearance-control')).toHaveCount(0);
await expect(page.locator('main')).toBeVisible();
   const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);expect(fits,`${mode} ${route} at ${width}px`).toBe(true);
   const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations;
   expect(violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
   await page.screenshot({path:info.outputPath(`view-${mode}-${width}-${route.replaceAll('/','')}.png`),fullPage:true});
  }
 }
 await page.goto('/en');await page.keyboard.press(info.project.name==='webkit'?'Alt+Tab':'Tab');
 await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused();
});
