import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from './it-infrastructure-worker.mjs';

const base = 'https://it-infrastructure.onesa.eu';

async function sampleStatus(status) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {status});
  try {
    const response = await worker.fetch(new Request(base + '/api/status'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    return response.json();
  } finally {
    globalThis.fetch = previous;
  }
}

test('a homepage HTTP 200 is not a passed application health check', async () => {
  const result = await sampleStatus(200);
  assert.equal(result.scope, 'edge_http_reachability');
  assert.ok(Array.isArray(result.services) && result.services.length > 0);
  assert.ok(result.services.every(x => x.state === 'unknown' && x.status === 200));
  assert.ok(result.services.every(x => !/operational|healthy/i.test(x.label)));
});

test('a Cloudflare Access redirect never counts as verified origin health', async () => {
  const result = await sampleStatus(302);
  assert.ok(result.services.every(x => x.state === 'unknown' && x.status === 302));
});

test('401 and 403 require independent origin checks', async () => {
  for (const status of [401, 403]) {
    const result = await sampleStatus(status);
    assert.ok(result.services.every(x => x.state === 'unknown'));
  }
});

test('unavailable backend and missing routes are failures', async () => {
  for (const status of [503, 404]) {
    const result = await sampleStatus(status);
    assert.ok(result.services.every(x => x.state === 'bad'));
  }
});

test('network failure does not produce green health', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('origin unavailable'); };
  try {
    const response = await worker.fetch(new Request(base + '/api/status'));
    const result = await response.json();
    assert.ok(result.services.every(x => x.state === 'bad'));
  } finally {
    globalThis.fetch = previous;
  }
});

test('static directory is restricted and excludes inactive Render production hosting', async () => {
  const response = await worker.fetch(new Request(base + '/'));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(html, /HTTP reachability only/);
  assert.doesNotMatch(html, /dashboard\.render\.com/);
  assert.doesNotMatch(html, /Render<\/h3>/);
});

test('control methods cannot mutate the directory', async () => {
  const response = await worker.fetch(new Request(base + '/api/status', {method:'POST'}));
  assert.equal(response.status, 405);
});
