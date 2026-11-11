import {test, expect} from '@playwright/test';
import {mobileApps} from '../src/config/mobile-apps';

for (const locale of ['en', 'de'] as const) {
  test(`${locale}: reach each mobile product and its available installers from the footer`, async ({page}) => {
    const german = locale === 'de';
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(`/${locale}`);
    await page.getByRole('contentinfo').getByRole('link', {name: german ? 'Mobile Apps' : 'Mobile apps'}).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/products#mobile-apps$`));
    const directory = page.getByRole('region', {name: german ? 'Mobile Apps' : 'Mobile apps', exact: true});
    await expect(directory.getByRole('listitem')).toHaveCount(mobileApps.length);
    for (const app of mobileApps) {
      const row = directory.getByRole('listitem').filter({has: page.getByRole('heading', {name: app.name, exact: true})});
      await expect(row.getByRole('link', {name: app.name, exact: true})).toHaveAttribute('href', app.website);
      for (const [key, label] of [['ios', 'iOS'], ['android', 'Android']] as const) {
        const release = app[key];
        const badge = row.locator('strong').filter({hasText: new RegExp(`^${label}$`)}).locator('../..');
        if (release) {
          await expect(badge).toHaveAttribute('href', release.url);
          await expect(badge).toContainText(release.channel);
        } else {
          await expect(badge).toContainText(german ? 'Noch nicht verfügbar' : 'Not yet available');
          expect(await badge.evaluate(node => node.tagName)).toBe('SPAN');
        }
      }
    }
    await expect(directory.getByText(german ? 'Ein Produkt von Onesa Mobile' : 'An Onesa Mobile product')).toBeVisible();
    await page.setViewportSize({width: 320, height: 710});
    await expect.poll(() => directory.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
}
