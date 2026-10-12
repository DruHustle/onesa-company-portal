import {test,expect} from '@playwright/test';
test('appearance follows local boundaries and preserves manual choices',async({page})=>{
 await page.clock.install({time:new Date('2026-10-12T06:59:00+02:00')});
 await page.goto('/');
 for(const [time,mode] of [['06:59','dark'],['07:00','light'],['18:59','light'],['19:00','dark']]){
  await page.clock.setSystemTime(new Date(`2026-10-12T${time}:00+02:00`));
  await page.evaluate('window.OnesaAppearance.refresh()');
  await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
 }
 const selector=page.locator('.appearance-control select');
 await selector.selectOption('light');await page.reload();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await expect(selector).toHaveValue('light');
 await selector.selectOption('auto');
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});
test('appearance works when preference storage is unavailable',async({page})=>{
 await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('Storage unavailable');};Storage.prototype.setItem=()=>{throw new Error('Storage unavailable');};});
 await page.goto('/');await page.locator('.appearance-control select').selectOption('dark');
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.locator('.appearance-control select').selectOption('light');
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});

test('canonical homepage switches between EN and DE',async({page})=>{await page.goto('/');await page.getByRole('button',{name:'Menu',exact:true}).isVisible().then(async visible=>{if(visible)await page.getByRole('button',{name:'Menu',exact:true}).click();});await page.getByRole('link',{name:'DE',exact:true}).click();await expect(page).toHaveURL(/\/de$/);await expect(page.locator('html')).toHaveAttribute('lang','de');});
