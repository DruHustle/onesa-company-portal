import {test,expect} from '@playwright/test';
for(const locale of ['en','de'] as const)test(`${locale}: synthetic investigation is distinct from live industrial integration`,async({page})=>{
 for(const colorScheme of ['light','dark'] as const)for(const viewport of [{width:320,height:568},{width:390,height:844},{width:1440,height:1000}]){
  await page.setViewportSize(viewport);await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
  await page.goto(`/${locale}/products`);
  const industrial=page.locator('#industrial-ai');
  await expect(industrial).toContainText(locale==='en'?'isolated, protected demo':'isolierten, geschützten Demo');
  await expect(industrial).toContainText(locale==='en'?'no live factory connection or machine control':'keine Live-Fabrikanbindung oder Maschinensteuerung');
  await expect(industrial.getByRole('link',{name:locale==='en'?/Discuss a pilot scope/:/Pilotumfang besprechen/})).toHaveAttribute('href',`/${locale}/contact?topic=industrial`);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/'+locale);
  await expect(page.locator('#home-title')).toContainText('Onesa.');
  await expect(page.locator('#products')).toContainText(locale==='en'?'isolated synthetic demonstration':'isolierte synthetische Demonstration');
  await expect(page.locator('main video')).toHaveCount(0);
 }
});
