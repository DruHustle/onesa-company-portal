import {test,expect} from '@playwright/test';

for(const locale of ['en','de'] as const)test(`${locale}: product interface examples load, explain their scope and follow the system appearance without shifting`,async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await page.goto(`/${locale}/products`);
 const images=page.getByRole('img',{name:locale==='en'?/The actual (Knowledge|operator) interface/:/Die tatsächliche (Knowledge|Operator)-Oberfläche/});
 await expect(images).toHaveCount(2);
 for(const image of await images.all()){
  await image.scrollIntoViewIfNeeded();await image.evaluate((node:HTMLImageElement)=>node.decode());
  const figure=image.locator('xpath=ancestor::figure[1]');
  await expect(figure).toContainText(locale==='en'?'rendered locally with synthetic data':'lokal mit synthetischen Daten gerendert');
  await expect(figure).toContainText(locale==='en'?'No live user data or AI-generated results':'Keine Live-Nutzerdaten oder KI-Ergebnisse');
  const before=await image.boundingBox();const light=await image.evaluate((node:HTMLImageElement)=>node.currentSrc);
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await expect.poll(()=>image.evaluate((node:HTMLImageElement)=>node.currentSrc)).not.toBe(light);
  await image.evaluate((node:HTMLImageElement)=>node.decode());
  const dark=await image.boundingBox();expect(dark?.width).toBe(before?.width);expect(dark?.height).toBe(before?.height);
  await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
