import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access, stat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium, webkit} from '@playwright/test';

// Actual production renderer; anonymous synthetic loopback fixtures, no database.
await access('.next/BUILD_ID');
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  assert.equal(await stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), false, `Use an isolated checkout without ${file}`);
}
const measureOnly = process.argv.includes('--measure');
const requests = [];
let copyDelay = 0, feedDelay = 0, detailDelay = 0, companyDelay = 0;
let earlyHeaders = false;
let copyStatus = 200, feedStatus = 200, detailStatus = 200, approved = true;
function fixture(kind, locale, slug = `synthetic-${kind}`) {
  return {id: `${kind}-${locale}`, kind, locale, slug,
    title: `Synthetic ${locale} ${kind}`, summary: 'Synthetic approved rendering fixture',
    body: `Synthetic ${locale} principal content.`, updated_at: '2026-10-14T00:00:00Z',
    metadata: {category: 'synthetic', seoTitle: `Synthetic ${locale} SEO`}};
}
const backend = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const entry = {method:request.method,path: url.pathname, kind: url.searchParams.get('kind'), at: performance.now(), cancelled: false};
  requests.push(entry);
  response.on('close', () => { if (!response.writableFinished) entry.cancelled = true; });
  response.setHeader('Content-Type', 'application/json');
  let wait = 0, status = 200, body;
  if (url.pathname === '/api/v1/public/company') {
    wait = companyDelay; body = {release_ready: approved};
  } else if (url.pathname === '/api/v1/public/content') {
    wait = feedDelay; status = feedStatus;
    const kind = url.searchParams.get('kind') || 'product', locale = url.searchParams.get('locale');
    body = {total: 1, items: [fixture(kind, locale)]};
  } else {
    const match = /^\/api\/v1\/public\/content\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const [,kind,locale,slug] = match;
      wait = kind === 'page' ? copyDelay : detailDelay;
      status = kind === 'page' ? copyStatus : slug === 'absent' ? 404 : detailStatus;
      body = fixture(kind, locale, slug);
    } else { status = 404; body = {}; }
  }
  if(earlyHeaders){response.writeHead(status);response.write(' ');}
  await delay(wait);
  if (response.destroyed) return;
  if(!response.headersSent)response.writeHead(status);
  response.end(JSON.stringify(status === 200 ? body : {error: {message: 'Synthetic dependency unavailable'}}));
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;
function probe(origin, path) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let html = '', headingAt, principalAt, productsAt;
    const request = http.get(new URL(path, origin), response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        html += chunk;
        if (headingAt === undefined && /<h1[ >]/.test(html)) headingAt = performance.now() - start;
        if (productsAt === undefined && html.includes('<h2 id="product-ai">Onesa AI Platform</h2>') && html.includes('<h2 id="product-robot">Onesa AI Robot</h2>') && html.includes('href="https://docs.onesa.eu/docs/public/ai-platform"') && html.includes('href="https://docs.onesa.eu/docs/public/robot"')) productsAt = performance.now()-start;
        if (principalAt === undefined && /Synthetic (en|de) (product|article|research|job)/.test(html)) principalAt = performance.now() - start;
      });
      response.on('end', () => resolve({html, headingAt, principalAt, productsAt, total: performance.now()-start,
        status: response.statusCode, headers: response.headers}));
      response.on('error', reject);
    });
    request.setTimeout(7000, () => request.destroy(new Error('Isolated request exceeded seven seconds')));
    request.on('error', reject);
  });
}
function security(page) {
  assert.match(page.headers['cache-control'], /private.*no-store/);
  const nonce = /'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
  assert.ok(nonce);
  for (const script of page.html.matchAll(/<script\b([^>]*)>/g)) {
    if (!script[1].includes('type="application/ld+json"')) assert.ok(script[1].includes(`nonce="${nonce}"`));
  }
  assert.ok(!page.html.includes('Synthetic private record'));
}
async function startFrontend() {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','-p',String(port)], {
    env: {PATH:process.env.PATH,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',SITE_URL:'https://onesa.eu',
      BACKEND_URL:backendUrl,PUBLIC_RELEASE_ENABLED:'true'}, stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const setupStarted=performance.now();
  while(performance.now()-setupStarted<60000) {
    if (child.exitCode !== null) throw new Error(`Isolated renderer exited: ${logs}`);
    if (logs.includes('Ready in')) {
      console.log(`Renderer setup readiness: ${Math.round(performance.now()-setupStarted)}ms (separate60s setup budget)`);
      return {child,origin:`http://127.0.0.1:${port}`};
    }
    await delay(100);
  }
  child.kill('SIGTERM'); throw new Error(`Isolated renderer did not start within60s: ${logs}`);
}
function report(label, page) {
  console.log(`${label}: heading ${Math.round(page.headingAt || 0)} ms, principal ${Math.round(page.principalAt || 0)} ms, complete ${Math.round(page.total)} ms, HTTP${page.status}`);
}
function productOverview(page) {
  assert.match(page.html,/<h2 id="product-ai">Onesa AI Platform<\/h2>/);
  assert.match(page.html,/<h2 id="product-robot">Onesa AI Robot<\/h2>/);
  for(const path of ['ai-platform','robot']) assert.ok(page.html.includes(`href="https://docs.onesa.eu/docs/public/${path}"`),'Each product links to its exact public documentation');
  assert.ok(page.productsAt<800,`Product information must arrive before optional CMS reads: ${page.productsAt}ms`);
  assert.doesNotMatch(page.html,/Content service is temporarily unavailable|Der Inhaltsdienst ist vorübergehend nicht verfügbar|Product entries are awaiting editorial approval|Produkteinträge warten auf redaktionelle Freigabe/,'Product information remains available during CMS failure');
}
let frontend;
try {
  frontend = await startFrontend();
  await probe(frontend.origin,'/en/about');
  for (const locale of ['en','de']) {
    copyDelay = 2200; requests.length=0;
    const staticPage = await probe(frontend.origin,`/${locale}/contact`); security(staticPage); report(`slow optional copy ${locale}/contact`,staticPage);
    if (!measureOnly) {
      assert.ok(staticPage.headingAt < 800, 'Optional CMS copy/SEO must not hold the section shell');
      assert.ok(staticPage.total < 2000, 'Optional copy is bounded');
      assert.match(staticPage.html, new RegExp(`/${locale}/contact`));
      assert.ok(requests.some(request => request.cancelled),'Timed out transport is cancelled');
      assert.equal(requests.filter(request => request.path.endsWith(`/page/${locale}/contact`)).length,1,'Body and SEO share only this render');
    }
    feedDelay = 2200; requests.length=0;
    const listing = await probe(frontend.origin,`/${locale}/products`); security(listing); report(`slow feed and copy ${locale}/products`,listing);
    if (!measureOnly) {
      assert.ok(listing.headingAt < 800); assert.ok(listing.total < 2000,'Reads run concurrently');
      productOverview(listing);
      assert.ok(!listing.html.includes(`Synthetic ${locale} product`));
      const copyRequest=requests.find(request => request.path.endsWith(`/page/${locale}/products`));
      const feedRequest=requests.find(request => request.path.endsWith('/content'));
      assert.ok(Math.abs(copyRequest.at-feedRequest.at)<350);
    }
    copyDelay=0; feedDelay=2200;
    const article=await probe(frontend.origin,`/${locale}/news/synthetic-article`); security(article); report(`slow related ${locale}/news/detail`,article);
    if (!measureOnly) {
      assert.ok(article.principalAt<800,'Related articles must not hold principal article');
      assert.ok(article.total<2000); assert.equal(article.status,200);
      assert.match(article.html,new RegExp(`Synthetic ${locale} principal content`));
    }
    feedDelay=0; copyDelay=0;
  }
  if (!measureOnly) {
    for (const locale of ['en','de']) for (const section of ['products','news','research','careers']) {
      const page=await probe(frontend.origin,`/${locale}/${section}/synthetic-detail`); security(page);
      assert.equal(page.status,200); assert.match(page.html,new RegExp(`Synthetic ${locale} principal content`));
      const missing=await probe(frontend.origin,`/${locale}/${section}/absent`);
      assert.equal(missing.status,404); assert.match(missing.html,/name="robots" content="noindex/);
    }
    for (const status of [503,200]) {
      detailStatus=status; detailDelay=status===200?2200:0; requests.length=0;
      const failed=await probe(frontend.origin,'/en/products/synthetic-detail'); security(failed);
      assert.equal(failed.status,200,'Transient backend faults are not missing content');
      assert.match(failed.html,/temporarily unavailable/); assert.match(failed.html,/name="robots" content="noindex/);
      assert.ok(!failed.html.includes('Synthetic en principal content')); assert.ok(failed.total<2000);
      assert.equal(requests.filter(request => request.path.endsWith('/product/en/synthetic-detail')).length,1);
    }
    earlyHeaders=true;copyDelay=2200;detailDelay=2200;
    const stalledCopy=await probe(frontend.origin,'/en/contact');
    assert.ok(stalledCopy.headingAt<800&&stalledCopy.total<2000,'Headers cannot evade the optional body deadline');
    const stalledDetail=await probe(frontend.origin,'/de/products/synthetic-detail');
    assert.equal(stalledDetail.status,200);assert.match(stalledDetail.html,/vorübergehend nicht verfügbar/);
    assert.match(stalledDetail.html,/name="robots" content="noindex/);assert.ok(stalledDetail.total<2000);
    assert.ok(!stalledDetail.html.includes('Synthetic de principal content'));
    console.log('PASS slow response bodies are bounded and required content fails closed');
    earlyHeaders=false;copyDelay=0;detailStatus=200;detailDelay=0;
    const recovery=await probe(frontend.origin,'/en/products/synthetic-detail');
    assert.match(recovery.html,/Synthetic en principal content/); assert.equal(recovery.status,200);
    detailStatus=404;
    const unpublished=await probe(frontend.origin,'/en/products/synthetic-detail');
    assert.equal(unpublished.status,404);assert.ok(!unpublished.html.includes('Synthetic en principal content'));
    detailStatus=200;
    const managedRecovery=await probe(frontend.origin,'/de/contact');
    assert.match(managedRecovery.html,/<title>Synthetic de SEO/);assert.match(managedRecovery.html,/Synthetic de principal content/);
    approved=false;
    const denied=await probe(frontend.origin,'/en/products/synthetic-detail');
    assert.match(denied.html,/awaiting release approval/); assert.ok(!denied.html.includes('Synthetic en principal content'));
    assert.match(denied.html,/name="robots" content="noindex/);
    const deniedProducts=await probe(frontend.origin,'/de/products');
    assert.ok(!deniedProducts.html.includes('<h2 id="product-ai">'),'Publication denial also hides the static product information');
    assert.match(deniedProducts.html,/name="robots" content="noindex/);
    approved=true; companyDelay=2200;
    const approvalTimeout=await probe(frontend.origin,'/de/products');
    assert.ok(!approvalTimeout.html.includes('<h2 id="product-ai">'),'Slow required approval hides the static product information');
    assert.ok(!approvalTimeout.html.includes('Synthetic de product')); assert.match(approvalTimeout.html,/name="robots" content="noindex/);
    companyDelay=0;
    for (const path of ['/xx/contact','/en/unknown','/en/unknown/absent']) assert.equal((await probe(frontend.origin,path)).status,404);
    copyStatus=503;feedStatus=503;
    for(const locale of ['en','de']){
      const optionalFailure=await probe(frontend.origin,`/${locale}/products`);
      assert.equal(optionalFailure.status,200);productOverview(optionalFailure);
      assert.ok(!optionalFailure.html.includes(`Synthetic ${locale} product`),'Failed CMS content is never exposed');
    }
    copyStatus=200;feedStatus=200;
  }
  for (const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch();
    try {
      for (const locale of ['en','de']) for (const width of [390,1440]) {
        const context=await browser.newContext({viewport:{width,height:900},colorScheme:'dark',reducedMotion:'reduce'});
        const external=[];
        await context.route('**/*',route=>{
          if(new URL(route.request().url()).origin!==frontend.origin){external.push(route.request().url());return route.abort();}
          return route.continue();
        });
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${frontend.origin}/${locale}/contact`);
        await page.waitForFunction(()=>Object.keys(document.querySelector('.contact-form')).some(key=>key.startsWith('__react')));
        await page.locator('input[name="name"]').fill('Synthetic unsent draft');
        copyDelay=2200;feedDelay=2200;
        const navigation=page.locator(width===390?'#mobile-main-nav':'#main-nav');
        if(width===390) await page.locator('.mobile-toggle').click();
        const start=performance.now();
        await navigation.getByRole('link',{name:locale==='en'?'Products':'Produkte',exact:true}).click();
        await page.waitForURL(`**/${locale}/products`);
        await page.getByRole('heading',{level:1}).waitFor({state:'visible'});
        if(!measureOnly){
          for(const name of ['Onesa AI Platform','Onesa AI Robot'])await page.getByRole('heading',{name,exact:true}).waitFor({state:'visible'});
          for(const path of ['ai-platform','robot'])assert.equal(await page.locator(`a[href="https://docs.onesa.eu/docs/public/${path}"]`).count(),1);
        }
        const elapsed=performance.now()-start;
        console.log(`${name} ${locale} ${width}px slow products navigation: ${Math.round(elapsed)} ms`);
        if(!measureOnly) assert.ok(elapsed<900,'Click reaches the section shell before optional backend deadline');
        copyDelay=0;feedDelay=0;
        await page.goBack();
        assert.equal(new URL(page.url()).pathname,`/${locale}/contact`,'Browser Back returns to the original locale and route');
        assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');
        await context.close(); copyDelay=0;feedDelay=0;
        assert.deepEqual(errors,[]);assert.deepEqual(external,[],'Browser fixtures never access hosted services');
      }
    } finally { await browser.close(); }
  }
  assert.ok(requests.every(request=>request.method==='GET'&&request.path.startsWith('/api/v1/public/')),'Public rendering cannot request private routes');
  console.log(measureOnly?'Baseline measured':'PASS isolated public loading, approval,404,recovery,locale,appearance and Browser Back');
} finally {
  if(frontend?.child.exitCode===null){frontend.child.kill('SIGTERM');await once(frontend.child,'exit');}
  backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));
}
