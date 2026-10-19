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

test('system appearance keeps action contrast throughout preference changes',async({page})=>{
  await page.setViewportSize({width:320,height:900});
  await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
  await page.goto('/en/contact');
  const name=page.getByLabel('Your name',{exact:true});
  await name.fill('Synthetic appearance draft');
  const action=page.locator('.contact-form button[type="submit"], .contact-form button.button');
  await expect(action).toHaveCount(1);
  for(const colorScheme of ['dark','light'] as const){
    await page.emulateMedia({colorScheme});
    const samples=await action.evaluate(async element=>{
      const luminance=(color:string)=>color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>{
        value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
      }).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const ratios=[];
      for(let frame=0;frame<12;frame++){
        const style=getComputedStyle(element),foreground=luminance(style.color),background=luminance(style.backgroundColor);
        ratios.push((Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05));
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      }
      return ratios;
    });
    expect(Math.min(...samples),'Action text must retain 4.5:1 contrast throughout system preference changes').toBeGreaterThanOrEqual(4.5);
    await expect(name).toHaveValue('Synthetic appearance draft');
  }
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

for (const locale of ['en','de'] as const) for (const width of [390,1440]) {
  test(`slow navigation shows ${locale} feedback and can be interrupted at ${width}px`,async({page}) => {
    await page.setViewportSize({width,height:900});
    const errors:string[] = [];
    page.on('pageerror',error => errors.push(error.message));
    let releaseResponse!: () => void;
    const held = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.route(`**/${locale}/products?*`,async route => { await held; await route.continue(); });
    try {
      await page.goto(`/${locale}`);
      const mobile = page.locator('.mobile-navigation');
      const menu = page.getByRole('button',{name:locale === 'de' ? 'Menü' : 'Menu',exact:true});
      const navigation = page.getByRole('navigation',{name:locale === 'de' ? 'Hauptnavigation' : 'Main navigation'});
      if (width === 390) await menu.click();
      await navigation.getByRole('link',{name:locale === 'de' ? 'Produkte' : 'Products',exact:true}).click();
      const feedback = page.locator('.navigation-status');
      await expect(feedback).toHaveAttribute('role','status');
      await expect(feedback).toHaveText(locale === 'de' ? 'Seite wird geladen…' : 'Loading page…');
      await expect(feedback).toBeVisible();
      await expect(page.getByRole('heading',{level:1})).toBeVisible();
      if (width === 390) {
        await expect(mobile).not.toHaveAttribute('open','');
        await menu.click();
      }
      await navigation.getByRole('link',{name:locale === 'de' ? 'Kontakt' : 'Contact',exact:true}).click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/contact$`));
      await expect(page.locator('.navigation-status')).toHaveCount(0);
      releaseResponse();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { releaseResponse(); }
  });
}

test('an unknown published detail keeps HTTP404 and noindex',async({page}) => {
  const response = await page.goto('/en/products/absent-synthetic-detail');
  expect(response?.status()).toBe(404);
  await expect(page.locator('main')).toBeVisible();
  const directives = await page.locator('meta[name="robots"]').evaluateAll(elements => elements.map(element => element.getAttribute('content') || ''));
  expect(directives.length).toBeGreaterThan(0);
  expect(directives.every(content => content.includes('noindex'))).toBe(true);
});


test.describe('clear homepage composition',()=>{
 for(const locale of ['en','de'])for(const mode of ['light','dark'] as const){
  test(`${locale} hero has one visible next action in ${mode}`,async({page})=>{
   await page.emulateMedia({colorScheme:mode,reducedMotion:'reduce'});
   for(const viewport of [{width:320,height:568},{width:390,height:844},{width:430,height:932},{width:844,height:390},{width:768,height:1024},{width:1440,height:1000}]){
    await page.setViewportSize(viewport);await page.goto('/'+locale);
    const hero=page.locator('.home-page .hero');await expect(hero.getByRole('heading',{level:1})).toHaveText('Onesa AI Platform');
    const introduction=hero.locator('.hero-intro');await expect(introduction).toBeVisible();
    const next=hero.getByRole('link',{name:locale==='en'?'Explore the platform':'Plattform entdecken'});await expect(next).toBeVisible();await expect(next).toHaveAttribute('href',`/${locale}/products#product-ai`);await expect(hero.getByRole('link')).toHaveCount(1);
    const nextBox=await next.boundingBox();expect(nextBox).not.toBeNull();if(viewport.height>=568||viewport.width===844)expect(nextBox!.y+nextBox!.height,'The complete primary action fits before scrolling').toBeLessThanOrEqual(viewport.height);
    const artwork=hero.locator('picture img');await expect(artwork).toBeVisible();await expect(artwork).toHaveAttribute('fetchpriority','high');expect(await artwork.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
    await expect(page.locator('#products figure')).toHaveCount(1);await expect(page.locator('#products figcaption')).toBeVisible();
    if(viewport.width===320){await page.evaluate(async()=>{document.documentElement.style.setProperty('font-size','200%','important');await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});await expect(page.locator('html')).toHaveCSS('font-size','32px');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(next).toBeVisible();}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(viewport.width<=760){const rows=page.locator('#capabilities .capability');await expect(rows).toHaveCount(4);const boxes=await rows.evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,bottom:r.bottom};}));for(let i=1;i<boxes.length;i++){expect(Math.abs(boxes[i].x-boxes[0].x)).toBeLessThan(1);expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i-1].bottom-1);}}
   }
  });
  test(`${locale} mobile menu keeps its anchor and returns keyboard focus in ${mode}`,async({page},info)=>{
   await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:mode});await page.goto('/'+locale);
   const toggle=page.locator('.mobile-toggle'),header=page.locator('.site-header'),before=await header.boundingBox();await toggle.focus();await page.keyboard.press('Enter');await expect(page.locator('#mobile-main-nav')).toBeVisible();const after=await header.boundingBox();expect(after!.height).toBeCloseTo(before!.height,0);await page.keyboard.press(info.project.name==='webkit'?'Alt+Tab':'Tab');await expect(page.locator('#mobile-main-nav a').first()).toBeFocused();await page.keyboard.press('Escape');await expect(toggle).toBeFocused();await expect(page.locator('#mobile-main-nav')).toBeHidden();
  });
 }
});

for (const locale of ['en', 'de'] as const) {
  for (const width of [390, 1440]) {
    test(`homepage capabilities open distinct useful topics in ${locale} at ${width}px`, async ({page}) => {
      await page.setViewportSize({width, height:900});
      await page.goto(`/${locale}`);
      const links = page.locator('#capabilities a.capability');
      await expect(links).toHaveCount(4);
      const destinations = await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      expect(new Set(destinations).size).toBe(4);
      const explanations = new Set<string>();
      for (let index=0; index<4; index++) {
        const link = links.nth(index);
        const title = await link.locator('h3').innerText();
        await link.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/${locale}/technology#.+$`));
        const heading = page.getByRole('heading', {name:title, exact:true});
        await expect(heading).toBeInViewport();
        const article = page.getByRole('article', {name:title, exact:true});
        await expect(article.locator('p')).toHaveCount(2);
        const explanation = await article.innerText();
        expect(explanation.length).toBeGreaterThan(150);
        explanations.add(explanation);
        // A bookmarked topic must also open correctly without prior client navigation.
        await page.reload();
        await expect(heading).toBeInViewport();
        await page.goto(`/${locale}`);
      }
      expect(explanations.size).toBe(4);
    });
  }
}

test('bookmarked topic survives late browser restoration', async ({page}) => {
  await page.setViewportSize({width:390,height:900});
  await page.goto('/en/technology#software-development');
  const heading=page.getByRole('heading',{name:'Software development',exact:true});
  await expect(heading).toBeFocused();
  // Model the observed WebKit ordering: hydration focus, pageshow, history restore.
  await page.evaluate(() => {
    requestAnimationFrame(() => {
      window.scrollTo(0,0);
      document.documentElement.dataset.syntheticRestorationComplete='true';
    });
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false}));
  });
  await expect(page.locator('html')).toHaveAttribute('data-synthetic-restoration-complete','true');
  await expect(heading).toBeInViewport();
  await expect.poll(() => heading.evaluate(node => Math.abs(node.getBoundingClientRect().y-parseFloat(getComputedStyle(node).scrollMarginBlockStart)))).toBeLessThan(2);
  // A cached Back navigation must keep the reader's own position.
  await page.evaluate(() => {
    window.scrollTo(0,0);
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
});


test('secondary company pages reflow at doubled text size in both locales', async ({page}) => {
 for(const locale of ['en','de'])for(const section of ['about','technology'])for(const colorScheme of ['light','dark'] as const)for(const viewport of [{width:320,height:568},{width:844,height:390}]) {
  await page.setViewportSize(viewport);await page.emulateMedia({colorScheme,reducedMotion:'reduce'});await page.goto(`/${locale}/${section}`);
  await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await page.evaluate(()=>document.documentElement.style.setProperty('font-size','200%','important'));
  await expect(page.locator('html')).toHaveCSS('font-size','32px');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
