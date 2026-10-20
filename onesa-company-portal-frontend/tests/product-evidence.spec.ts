import {test,expect,type Locator} from '@playwright/test';

async function loadedVariant(image:Locator,variant:'light'|'dark'){
 // A media change can invalidate an earlier decode promise, particularly for
 // Firefox lazy pictures. Assert the selected request has completed first.
 await expect.poll(()=>image.evaluate((node:HTMLImageElement,selectedVariant:string)=>({
  loaded:node.complete&&node.naturalWidth>0,
  selected:node.currentSrc.endsWith(`-${selectedVariant}.png`),
 }),variant)).toEqual({loaded:true,selected:true});
 await image.evaluate((node:HTMLImageElement)=>node.decode());
}

for(const locale of ['en','de'] as const)test(`${locale}: product interface examples load, explain their scope and follow the system appearance without shifting`,async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await page.goto(`/${locale}/products`);
 const images=page.getByRole('img',{name:locale==='en'?/The actual (Knowledge|operator) interface/:/Die tatsächliche (Knowledge|Operator)-Oberfläche/});
 await expect(images).toHaveCount(2);
 for(const image of await images.all()){
  await image.scrollIntoViewIfNeeded();await loadedVariant(image,'light');
  const figure=image.locator('xpath=ancestor::figure[1]');
  await expect(figure).toContainText(locale==='en'?'rendered locally with synthetic data':'lokal mit synthetischen Daten gerendert');
  await expect(figure).toContainText(locale==='en'?'No live user data or AI-generated results':'Keine Live-Nutzerdaten oder KI-Ergebnisse');
  const before=await image.boundingBox();const light=await image.evaluate((node:HTMLImageElement)=>node.currentSrc);
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await expect.poll(()=>image.evaluate((node:HTMLImageElement)=>node.currentSrc)).not.toBe(light);
  await loadedVariant(image,'dark');
  const dark=await image.boundingBox();expect(dark?.width).toBe(before?.width);expect(dark?.height).toBe(before?.height);
  await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
  await loadedVariant(image,'light');
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for(const locale of ['en','de'] as const)test(`${locale}: application and industrial paragraphs stay readable at 320px with enlarged text`,async({page})=>{
 await page.setViewportSize({width:320,height:844});
 await page.goto(`/${locale}/products`);
 await page.evaluate(async()=>{
  document.documentElement.style.setProperty('font-size','200%','important');
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 });
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
 const overflow=await page.evaluate(()=>[...document.querySelectorAll('#platform-applications p,#industrial-ai p')].flatMap(paragraph=>{
  const range=document.createRange();range.selectNodeContents(paragraph);
  return [...range.getClientRects()].filter(rect=>rect.width>0&&(rect.left< -1||rect.right>innerWidth+1)).map(rect=>({left:rect.left,right:rect.right}));
 }));
 expect(overflow).toEqual([]);
});
