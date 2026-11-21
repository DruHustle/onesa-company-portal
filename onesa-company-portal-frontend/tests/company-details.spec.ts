import {test,expect} from '@playwright/test';

test('Approved EN/DE company particulars and contact links remain visible on legal pages',async({page})=>{
 for(const locale of ['en','de']){
  for(const section of ['impressum','privacy','contact']){
   await page.goto(`/${locale}/${section}`);
   const main=page.locator('main');
   if(section==='contact'){
    await expect(main).not.toContainText('Steinhofweg 47, 69123 Heidelberg');
    await expect(main.locator('a[href="mailto:info@onesa.eu"]')).toHaveCount(0);
    await expect(main.locator('a[href="tel:+4915147416152"]')).toHaveCount(0);
    await expect(main.getByRole('button',{name:locale==='en'?'Send enquiry':'Anfrage senden'})).toBeVisible();
   }else{
    await expect(main).toContainText('Onesa UG (haftungsbeschränkt)');
    await expect(main).toContainText('Steinhofweg 47, 69123 Heidelberg');
    await expect(main.locator('a[href="mailto:info@onesa.eu"]').first()).toBeVisible();
    await expect(main.locator('a[href="tel:+4915147416152"]').first()).toBeVisible();
   }
   if(section==='impressum'){
    for(const value of ['Andrew Gotora','Amtsgericht Mannheim','HRB 757830'])await expect(main).toContainText(value);
    await expect(main).not.toContainText('Draft legal notice');
    await expect(main).not.toContainText('Entwurf des Impressums');
   }
   await expect(page.locator('footer')).toContainText('Onesa UG (haftungsbeschränkt)');
  }
 }
});
