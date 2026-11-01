import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir, readFile, stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium, firefox, webkit, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) assert.equal(await stat(file).then(() => true, () => false), false, 'isolated checkout required');
const api = http.createServer((_request, response) => response.writeHead(404, {'Content-Type': 'application/json'}).end('{}'));
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:3353';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', '3353'], {env: {...process.env, PUBLIC_RELEASE_ENABLED: 'false', BACKEND_URL: `http://127.0.0.1:${api.address().port}`, SITE_URL: origin}, stdio: 'ignore'});
const supplemental = process.env.LOCAL_NVIDIA_CHROMIUM_EXECUTABLE;
const engines = supplemental ? {chromium} : {chromium, firefox, webkit};
const firefoxHeaded = process.env.NVIDIA_FIREFOX_HEADED === 'true';
const evidence = process.env.NVIDIA_SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, {recursive: true});
const results = [];
async function applyTheme(page, colorScheme) {
  await page.emulateMedia({colorScheme});
  // Apply the media-query style change and its paint before sampling contrast.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function verifyProtectedModels(browser, engine) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  let denied = 0, authorized = 0, foreignRequests = 0, foreignWireRequests = 0, sameOriginRequests = 0, sameOriginWireRequests = 0, unexpected = 0, redirect = '', foreignOrigin;
  const foreign = http.createServer((_request, response) => {
    foreignWireRequests++;
    response.writeHead(403, {'cache-control': 'no-store'}).end('Synthetic foreign denial');
  });
  // Cookie attachment and redirect handling belong to the browser network stack,
  // after Playwright route interception. Observe real loopback HTTP instead.
  const gateway = http.createServer((request, response) => {
    const target = new URL(request.url ?? '/', origin);
    if (target.origin !== origin || !['GET', 'HEAD'].includes(request.method)) {
      unexpected++;
      response.writeHead(400).end('Unexpected fixture request'); return;
    }
    if (target.pathname === '/fixture-model-redirect.glb') {
      sameOriginWireRequests++;
      response.writeHead(403, {'cache-control': 'no-store'}).end('Synthetic same-origin redirect target'); return;
    }
    const model = target.pathname.startsWith('/models/nvidia/') && target.pathname.endsWith('.glb');
    if (model) {
      if (request.method !== 'GET' || request.headers.authorization !== undefined) {
        unexpected++;
        response.writeHead(400).end('Unexpected model request'); return;
      }
      if (request.headers.cookie !== '_vercel_jwt=synthetic-only') {
        denied++;
        response.writeHead(403, {'cache-control': 'no-store'}).end('Synthetic preview cookie required'); return;
      }
      authorized++;
      if (redirect) {
        const location = redirect === 'same-origin' ? '/fixture-model-redirect.glb' : `${foreignOrigin}/blocked.glb`;
        response.writeHead(307, {location, 'cache-control': 'no-store'}).end(); return;
      }
    }
    const upstream = http.request(target, {method: request.method, headers: {...request.headers, host: target.host}}, incoming => {
      response.writeHead(incoming.statusCode ?? 502, {...incoming.headers, ...(model ? {'cache-control': 'no-store'} : {})});
      incoming.pipe(response);
    });
    upstream.on('error', () => {if (!response.headersSent) response.writeHead(502); response.end();});
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  try {
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const protectedOrigin = `http://127.0.0.1:${gateway.address().port}`;
    const page = await context.newPage();
    page.on('request', request => {
      if (new URL(request.url()).origin === foreignOrigin) foreignRequests++;
      if (request.url() === `${protectedOrigin}/fixture-model-redirect.glb`) sameOriginRequests++;
    });
    await page.goto(`${protectedOrigin}/en/products/onesa-drone`);
    const section = page.locator('#nvidia-environments'); await section.scrollIntoViewIfNeeded();
    await expect(section).toHaveAttribute('data-state', 'failed', {timeout: 30000});
    assert.equal(denied, 1); assert.equal(authorized, 0);
    await context.addCookies([{name: '_vercel_jwt', value: 'synthetic-only', url: protectedOrigin, httpOnly: true, sameSite: 'Lax'}]);
    const cookie = (await context.cookies(protectedOrigin)).find(cookie => cookie.name === '_vercel_jwt');
    assert.equal(cookie?.value, 'synthetic-only'); assert.equal(cookie?.httpOnly, true);
    assert.equal(await page.evaluate(() => document.cookie.includes('_vercel_jwt')), false);
    await section.getByRole('button', {name: 'Retry 3D view'}).click();
    await expect(section, `cookie-gated actual 3D rendering: ${engine}`).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    const choices = section.getByRole('group').getByRole('button');
    for (const index of [1, 2]) {
      await choices.nth(index).click();
      await expect(section).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    }
    assert.equal(denied, 1); assert.equal(authorized, 3);
    redirect = 'same-origin'; await choices.nth(0).click();
    await expect(section).toHaveAttribute('data-state', 'failed', {timeout: 30000});
    assert.equal(authorized, 4); assert.equal(sameOriginRequests, 0, 'same-origin model redirects never reach their target');
    assert.equal(sameOriginWireRequests, 0);
    redirect = ''; await section.getByRole('button', {name: 'Retry 3D view'}).click();
    await expect(section).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    assert.equal(authorized, 5);
    redirect = 'foreign'; await choices.nth(1).click();
    await expect(section).toHaveAttribute('data-state', 'failed', {timeout: 30000});
    assert.equal(authorized, 6); assert.equal(foreignRequests, 0, 'model redirects never reach a foreign origin');
    assert.equal(foreignWireRequests, 0); assert.equal(unexpected, 0);
    redirect = ''; await section.getByRole('button', {name: 'Retry 3D view'}).click();
    await expect(section).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    assert.equal(authorized, 7);
    results.push({engine, unauthenticatedModelDenied: 'passed', cookieGatedAllThreeModels: 'passed', sameOriginModelRedirectRefused: 'passed', foreignModelRedirectRefused: 'passed', redirectRecovery: 'passed'});
  } finally {
    console.log(JSON.stringify({phase: 'cookie-gate-summary', engine, denied, authorized, foreignRequests, foreignWireRequests, sameOriginRequests, sameOriginWireRequests, unexpected}));
    await context.close();
    for (const server of [gateway, foreign]) {
      if (server.listening) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    }
  }
}
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('isolated frontend exited');
    if (await fetch(`${origin}/en/products/onesa-drone`).then(r => r.ok, () => false)) {ready = true; break;}
    await delay(500);
  }
  assert.ok(ready, 'production build starts');
  for (const [engine, launcher] of Object.entries(engines)) {
    const headless = engine !== 'firefox' || !firefoxHeaded;
    console.log(JSON.stringify({phase: 'start-engine', engine, headless}));
    browser = await launcher.launch(supplemental
      ? {executablePath: supplemental, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
      : {headless});
    await verifyProtectedModels(browser, engine);
    for (const locale of ['en', 'de']) for (const width of [320, 1440]) for (const colorScheme of ['light', 'dark']) {
      const scenario = `${engine}/${locale}/${width}/${colorScheme}`;
      console.log(JSON.stringify({phase: 'gallery-view', engine, locale, width, colorScheme}));
      const context = await browser.newContext({viewport: {width, height: 950}, colorScheme, reducedMotion: 'reduce'});
      const page = await context.newPage(); const errors = []; const requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {if (request.url().endsWith('.glb')) requests.push(request);});
      await page.goto(`${origin}/${locale}/products/onesa-drone`);
      const section = page.locator('#nvidia-environments'); await section.scrollIntoViewIfNeeded();
      await expect(section, `initial 3D rendering: ${scenario}`).toHaveAttribute('data-state', 'ready', {timeout: 30000});
      const choices = section.getByRole('group').getByRole('button');
      for (let i = 0; i < 3; i++) {
        await choices.nth(i).click(); await expect(choices.nth(i)).toHaveAttribute('aria-pressed', 'true');
        await expect(section, `model ${i + 1}: ${scenario}`).toHaveAttribute('data-state', 'ready', {timeout: 30000});
        assert.equal(await section.locator('canvas').count(), 1);
        const slider = section.getByRole('slider'); await slider.focus(); await slider.press('ArrowRight');
        assert.equal(await slider.inputValue(), '1');
        await section.getByRole('button', {name: locale === 'de' ? 'Ansicht zurücksetzen' : 'Fit view'}).click();
        assert.equal(await slider.inputValue(), '0');
        if (evidence && locale === 'en' && colorScheme === 'light') await section.screenshot({path: `${evidence}/${engine}-${width}-model-${i + 1}.png`});
      }
      await section.locator('summary').click();
      const rendererLicense = section.getByRole('link', {name: locale === 'de' ? 'Renderer-Lizenz' : 'Renderer license'});
      await expect(rendererLicense).toBeVisible();
      await expect(rendererLicense).toHaveAttribute('href', '/licenses/three.txt');
      if (locale === 'en' && width === 320 && colorScheme === 'light') {
        const licenseResponse = await context.request.get(`${origin}/licenses/three.txt`);
        assert.equal(licenseResponse.status(), 200);
        assert.equal(await licenseResponse.text(), await readFile('public/licenses/three.txt', 'utf8'));
      }
      const before = requests.length;
      await applyTheme(page, colorScheme === 'light' ? 'dark' : 'light');
      await expect(section).toHaveAttribute('data-state', 'ready'); assert.equal(requests.length, before, 'theme change does not reload asset');
      await applyTheme(page, colorScheme);
      assert.ok(requests.every(request => new URL(request.url()).origin === origin && request.method() === 'GET'));
      assert.ok(await choices.locator('span').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), 'all model names stay within their buttons');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      const accessibility = await new AxeBuilder({page}).include('#nvidia-environments').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(accessibility.violations.map(v => ({id: v.id, nodes: v.nodes.map(n => ({target: n.target, summary: n.failureSummary}))})), [], `gallery accessibility: ${engine}/${locale}/${width}/${colorScheme}`);
      assert.deepEqual(errors, []);
      if (evidence && locale === 'en') await section.screenshot({path: `${evidence}/${engine}-${width}-${colorScheme}-details.png`});
      results.push({engine, locale, width, colorScheme, allThreeAssets: 'passed', keyboard: 'passed', accessibility: 'passed'});
      await context.close();
    }
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    const page = await context.newPage();
    await page.route('**/*.glb', route => route.fulfill({status: 200, contentType: 'model/gltf-binary', body: 'broken'}));
    await page.goto(`${origin}/en/products/onesa-drone`);
    const section = page.locator('#nvidia-environments'); await section.scrollIntoViewIfNeeded();
    await expect(section).toHaveAttribute('data-state', 'failed', {timeout: 30000});
    await expect(section.getByAltText(/Rendered preview/)).toBeVisible();
    await expect(section.getByRole('status')).toBeVisible();
    if (evidence) await section.screenshot({path: `${evidence}/${engine}-download-fallback.png`});
    await page.unroute('**/*.glb'); await section.getByRole('button', {name: 'Retry 3D view'}).click();
    await expect(section).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    await section.locator('canvas').evaluate(canvas => {
      const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('required context-loss extension unavailable');
      extension.loseContext();
    });
    await expect(section).toHaveAttribute('data-state', 'failed');
    await section.getByRole('button', {name: 'Retry 3D view'}).click();
    await expect(section).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    await page.goto(`${origin}/en/products`); await page.locator('#nvidia-environments').scrollIntoViewIfNeeded();
    await expect(page.locator('#nvidia-environments')).toHaveAttribute('data-state', 'ready', {timeout: 30000});
    await context.close();
    const noGraphics = await browser.newContext({viewport: {width: 320, height: 844}});
    await noGraphics.addInitScript(() => {const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...args) {return String(type).includes('webgl') ? null : original.call(this, type, ...args);};});
    const fallback = await noGraphics.newPage(); await fallback.goto(`${origin}/de/products/onesa-drone`);
    await fallback.locator('#nvidia-environments').scrollIntoViewIfNeeded();
    await expect(fallback.locator('#nvidia-environments')).toHaveAttribute('data-state', 'unavailable');
    await expect(fallback.locator('#nvidia-environments').getByRole('status')).toBeVisible();
    await expect(fallback.getByAltText(/Gerenderte Vorschau/)).toBeVisible();
    if (evidence) await fallback.locator('#nvidia-environments').screenshot({path: `${evidence}/${engine}-no-webgl.png`});
    await noGraphics.close();
    const noScript = await browser.newContext({javaScriptEnabled: false, viewport: {width: 320, height: 844}});
    const staticPage = await noScript.newPage(); await staticPage.goto(`${origin}/en/products/onesa-drone`);
    await staticPage.locator('#nvidia-environments').scrollIntoViewIfNeeded();
    await expect(staticPage.getByAltText(/Rendered preview/)).toBeVisible(); await noScript.close();
    results.push({engine, corruptDownload: 'passed', retry: 'passed', graphicsContextLoss: 'passed', noWebGL: 'passed', noJavaScript: 'passed', productIndex: 'passed'});
    await browser.close(); browser = undefined;
  }
  console.log(JSON.stringify({scope: supplemental ? 'LOCAL_SUPPLEMENTAL_BROWSER_NOT_PINNED_RELEASE_EVIDENCE' : 'LOCAL_SYNTHETIC_NOT_HOSTED', results}, null, 2));
} finally {await browser?.close(); child.kill('SIGTERM'); api.close();}
