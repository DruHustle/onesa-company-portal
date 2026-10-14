import {test,expect,type Page} from '@playwright/test';

async function switchLanguage(page: Page, locale: 'en' | 'de') {
  const menu = page.locator('.mobile-toggle');
  if (await menu.isVisible() && !await menu.evaluate(element => element.closest('details')?.open)) {
    await menu.click();
  }
  await page.getByRole('link', {name: locale.toUpperCase(), exact: true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function appearance(page: Page) {
  return page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.documentElement).backgroundColor,
    text: getComputedStyle(document.body).color,
  }));
}

function expectedAppearance(mode: 'dark' | 'light') {
  return mode === 'dark'
    ? {scheme: mode, background: 'rgb(11, 21, 35)', text: 'rgb(229, 237, 246)'}
    : {scheme: mode, background: 'rgb(255, 255, 255)', text: 'rgb(16, 38, 62)'};
}

test('canonical homepage switches between EN and DE', async ({page}) => {
  await page.goto('/');
  await switchLanguage(page, 'de');
  await expect(page).toHaveURL(/\/de$/);
});

for (const mode of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`language switches preserve ${mode} system appearance at ${width}px`, async ({page}) => {
      // An opposing clock must not choose the site's appearance.
      await page.addInitScript(hour => { Date.prototype.getHours = () => hour; }, mode === 'dark' ? 12 : 23);
      await page.emulateMedia({colorScheme: mode, reducedMotion: 'reduce'});
      await page.setViewportSize({width, height: 900});
      for (const route of ['/', '/en/contact']) {
        await page.goto(route);
        await expect.poll(() => appearance(page)).toEqual(expectedAppearance(mode));
        const before = await appearance(page);
        for (const locale of ['de', 'en'] as const) {
          await switchLanguage(page, locale);
          const destination = route === '/' ? (locale === 'en' ? '/' : '/de') : `/${locale}/contact`;
          await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
          await expect.poll(() => appearance(page)).toEqual(before);
        }
      }
      const opposite = mode === 'dark' ? 'light' : 'dark';
      await page.emulateMedia({colorScheme: opposite});
      await expect.poll(() => appearance(page)).toEqual(expectedAppearance(opposite));
      const changed = await appearance(page);
      await switchLanguage(page, 'de');
      await expect.poll(() => appearance(page)).toEqual(changed);
    });
  }
}

test.describe('system appearance before hydration', () => {
  test.use({javaScriptEnabled: false});
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode} appearance renders without a theme script`, async ({page}) => {
      await page.emulateMedia({colorScheme: mode});
      for (const route of ['/', '/de']) {
        await page.goto(route);
        await expect(page.locator('main')).toBeVisible();
        await expect.poll(() => appearance(page)).toEqual(expectedAppearance(mode));
      }
    });
  }
  for (const mode of ['dark', 'light'] as const) {
    test(`mobile navigation and language switch work without JavaScript in ${mode}`, async ({page}) => {
      await page.setViewportSize({width:390,height:844});
      await page.emulateMedia({colorScheme:mode});
      await page.goto('/');
      await page.locator('.mobile-toggle').click();
      await expect(page.locator('.mobile-navigation')).toHaveAttribute('open','');
      await expect(page.locator('#mobile-main-nav').getByRole('link',{name:'Products',exact:true})).toBeVisible();
      await page.getByRole('link',{name:'DE',exact:true}).click();
      await expect(page.locator('html')).toHaveAttribute('lang','de');
      await expect.poll(() => appearance(page)).toEqual(expectedAppearance(mode));
      await page.locator('.mobile-toggle').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('link',{name:'EN',exact:true})).toBeVisible();
    });
  }
});

test('the first mobile menu tap works while client scripts are held and survives hydration',async({page}) => {
  await page.setViewportSize({width:390,height:844});
  const errors:string[] = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => { if(message.type() === 'error') errors.push(message.text()); });
  let releaseScripts!: () => void;
  const held = new Promise<void>(resolve => { releaseScripts = resolve; });
  await page.route('**/_next/static/**/*.js',async route => { await held; await route.continue(); });
  try {
    await page.goto('/',{waitUntil:'commit'});
    await page.locator('.mobile-toggle').click();
    await expect(page.locator('#mobile-main-nav').getByRole('link',{name:'Products',exact:true})).toBeVisible();
    await expect(page.locator('.mobile-navigation')).toHaveAttribute('open','');
    releaseScripts();
    await page.waitForLoadState('load');
    await expect.poll(() => page.locator('.mobile-navigation').evaluate(element => Object.keys(element).some(key => key.startsWith('__react')))).toBe(true);
    await expect(page.locator('.mobile-navigation')).toHaveAttribute('open','');
    await page.keyboard.press('Escape');
    await expect(page.locator('.mobile-navigation')).not.toHaveAttribute('open','');
    await expect(page.locator('.mobile-toggle')).toBeFocused();
    await expect(page.locator('#mobile-main-nav').getByRole('link',{name:'Products',exact:true})).toBeHidden();
    expect(errors).toEqual([]);
  } finally { releaseScripts(); }
});
