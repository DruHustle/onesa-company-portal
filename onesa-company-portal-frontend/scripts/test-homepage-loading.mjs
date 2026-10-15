import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access, stat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

// Exercise the real production renderer with synthetic loopback services only.
await access('.next/BUILD_ID');
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const present = await stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.ok(!present, `The isolated renderer requires a clean checkout without ${file}`);
}
const requests = [];
let contentDelay = 0;
let companyDelay = 0;
let approved = false;
let prelaunch = false;
const backend = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  requests.push({path: url.pathname, kind: url.searchParams.get('kind'), at: performance.now()});
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/v1/public/company') {
    const ready = approved;
    await delay(companyDelay);
    if (!response.destroyed) response.end(JSON.stringify({release_ready: ready, publication_enabled: ready || prelaunch, publication_stage: prelaunch ? 'prelaunch' : 'launch'}));
  } else if (url.pathname === '/api/v1/public/content') {
    await delay(contentDelay);
    if (response.destroyed) return;
    const kind = url.searchParams.get('kind');
    const locale = url.searchParams.get('locale');
    response.end(JSON.stringify({total: 1, items: [{
      id: kind, kind, locale, slug: kind === 'page' ? 'homepage' : 'synthetic-news',
      title: kind === 'page' ? 'Synthetic homepage introduction' : 'Synthetic published news',
      summary: 'Synthetic rendering fixture', body: 'Synthetic approved content.',
      updated_at: '2026-10-14T00:00:00Z', metadata: {},
    }]}));
  } else {
    response.writeHead(404).end('{}');
  }
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;

function probe(origin, path) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let html = '';
    let heroAt;
    const request = http.get(new URL(path, origin), response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        html += chunk;
        if (heroAt === undefined && /<h1>.*?(Engineering what|Wir entwickeln)/s.test(html)) {
          heroAt = performance.now() - started;
        }
      });
      response.on('end', () => resolve({html, heroAt, total: performance.now() - started,
        status: response.statusCode, headers: response.headers}));
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Isolated page request exceeded five seconds')));
    request.on('error', reject);
  });
}

function checkSecurity(page) {
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.html, /class="product-section section"|ai-engine-illustration/, 'AI Platform presentation belongs under Products, not Home');
  assert.match(page.headers['cache-control'], /private.*no-store/);
  const nonce = /'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
  assert.ok(nonce, 'Every response retains its CSP nonce');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const script of page.html.matchAll(/<script\b([^>]*)>/g)) {
    if (script[1].includes('type="application/ld+json"')) continue;
    assert.ok(script[1].includes(`nonce="${nonce}"`), 'Streamed scripts use the response nonce');
  }
}

async function startFrontend(publicRelease) {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', String(port)], {
    env: {PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      SITE_URL: 'https://onesa.eu', BACKEND_URL: backendUrl, PUBLIC_RELEASE_ENABLED: String(publicRelease)},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Synthetic frontend exited: ${logs}`);
      if (logs.includes('Ready in')) return {child, origin};
      await delay(100);
    }
    throw new Error(`Synthetic frontend failed to start: ${logs}`);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

async function stopFrontend(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

let frontend;
try {
  frontend = await startFrontend(false);
  await probe(frontend.origin, '/'); // Warm the renderer before asserting timing.
  for (const route of ['/', '/en', '/de']) {
    requests.length = 0;
    contentDelay = 2200;
    const page = await probe(frontend.origin, route);
    checkSecurity(page);
    assert.ok(page.heroAt < 1000, `${route}: hero streamed in ${page.heroAt} ms`);
    assert.ok(page.total < 2100, `${route}: bounded response completed in ${page.total} ms`);
    assert.match(page.html, /name="robots" content="noindex, nofollow"/);
    assert.match(page.html, route === '/de' ? /Nachrichtendienst ist vorübergehend/ : /news service is temporarily unavailable/);
    assert.ok(!page.html.includes('Synthetic published news'));
    assert.equal(requests.filter(request => request.path.endsWith('/company')).length, 0);
    const content = requests.filter(request => request.path.endsWith('/content'));
    assert.deepEqual(content.map(request => request.kind).sort(), ['article', 'page']);
    assert.ok(Math.abs(content[0].at - content[1].at) < 250, 'Optional reads start concurrently');
    console.log(`PASS preview ${route}: hero ${Math.round(page.heroAt)} ms, response ${Math.round(page.total)} ms`);
  }
  contentDelay = 100;
  const recovered = await probe(frontend.origin, '/');
  checkSecurity(recovered);
  assert.match(recovered.html, /Synthetic homepage introduction/);
  assert.match(recovered.html, /Synthetic published news/);
  console.log('PASS approved CMS content returns after backend recovery');
  await stopFrontend(frontend.child);
  frontend = await startFrontend(true);
  await probe(frontend.origin, '/');
  // An operational approval endpoint is not a dependency of an already-published website.
  // The synthetic content endpoint represents editorially published public content.
  for (const status of [false, true]) for (const delayMs of [0, 2200]) {
    approved = status; companyDelay = delayMs; requests.length = 0;
    const page = await probe(frontend.origin, '/');
    checkSecurity(page);
    assert.ok(page.heroAt < 1000, 'Approved public shell remains responsive');
    assert.match(page.html, /Synthetic published news/);
    assert.match(page.html, /name="robots" content="index, follow"/);
    assert.doesNotMatch(page.html, /awaiting release approval|wartet auf Freigabe|Publication approval pending/);
    assert.equal(requests.filter(request => request.path.endsWith('/company')).length, 0,
      'A denied, slow or unavailable approval-status endpoint is never requested by public rendering');
    assert.ok(requests.every(request => request.path === '/api/v1/public/content'),
      'Public rendering uses only published-content endpoints');
    assert.doesNotMatch(page.html.match(/<footer[\s\S]*?<\/footer>/)?.[0] || '', /mailto:|tel:/);
    assert.match(page.html, /href="\/en\/contact"/);
  }
  prelaunch = true;
  const development = await probe(frontend.origin, '/');
  assert.ok(development.heroAt !== undefined);
  assert.match(development.html, /Synthetic published news/);
  assert.doesNotMatch(development.html, /awaiting release approval|wartet auf Freigabe/);
  console.log('PASS public website and indexing remain available without an approval-status request; backend content boundaries are unchanged');

} finally {
  if (frontend) await stopFrontend(frontend.child);
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
}
