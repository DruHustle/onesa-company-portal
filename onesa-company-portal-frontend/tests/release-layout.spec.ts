import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const widths=[320,390,768,1024,1440];
test('release audit: responsive EN/DE pages, reduced motion and axe',async({page},info)=>{
 test.setTimeout(90000);
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const width of widths){
  await page.setViewportSize({width,height:900});
  for(const route of ['/en','/de','/en/contact','/de/technology','/admin']){
   const response=await page.goto(route);
   const policy=response?.headers()['content-security-policy']||'';
   expect(policy).toContain("'nonce-");expect(policy).toContain("frame-ancestors 'none'");
   expect(policy).not.toContain("'unsafe-eval'");
await expect(page.locator('main')).toBeVisible();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations;
   expect(violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
   await page.screenshot({path:info.outputPath(`view-${width}-${route.replaceAll('/','')}.png`),fullPage:true});
  }
 }
 await page.goto('/en');await page.keyboard.press(info.project.name==='webkit'?'Alt+Tab':'Tab');
 await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused();
});
