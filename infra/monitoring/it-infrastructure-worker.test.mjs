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
  assert.equal(result.scope, 'edge_http_and_verified_identity_readiness');
  assert.ok(Array.isArray(result.services) && result.services.length > 0);
  assert.ok(result.services.filter(x => x.name !== 'Onesa Account').every(x => x.state === 'unknown' && x.status === 200));
  const identity = result.services.find(x => x.name === 'Onesa Account');
  assert.equal(identity.state, 'bad', 'A contentless HTTP 200 cannot verify /readyz');
  assert.ok(result.services.every(x => !/operational|healthy/i.test(x.label)));
});


test('the verified Identity readiness endpoint alone may display healthy', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (url === 'https://account.onesa.eu/readyz')
      return Response.json({service:'onesa-identity',ready:true});
    return new Response('Home page', {status:200,headers:{'content-type':'text/html'}});
  };
  try {
    const response = await worker.fetch(new Request(base + '/api/status'));
    const result = await response.json();
    const identity = result.services.find(x=>x.name==='Onesa Account');
    assert.equal(identity.state,'ok');
    assert.equal(identity.label,'Identity ready');
    assert.ok(result.services.filter(x=>x.name!=='Onesa Account').every(x=>x.state==='unknown'));
    assert.equal(calls.filter(url=>url.endsWith('/readyz')).length,1);
  } finally {globalThis.fetch=previous;}
});

test('malformed, misleading and oversized Identity responses never pass readiness', async () => {
  const fixtures = [
    Response.json({service:'onesa-identity',ready:false}),
    Response.json({service:'other',ready:true}),
    Response.json({service:'onesa-identity',ready:'true'}),
    new Response('<html>sign in</html>', {status:200,headers:{'content-type':'text/html'}}),
    new Response('x'.repeat(5000), {status:200,headers:{'content-type':'application/json'}}),
    new Response(null, {status:200,headers:{'content-type':'application/json'}}),
  ];
  for (const fixture of fixtures) {
    const previous=globalThis.fetch;
    globalThis.fetch=async url=> url==='https://account.onesa.eu/readyz' ? fixture : Response.json({service:'other',ready:true});
    try{
      const response=await worker.fetch(new Request(base+'/api/status'));
      const result=await response.json();
      assert.equal(result.services.find(x=>x.name==='Onesa Account').state,'bad');
      assert.ok(result.services.filter(x=>x.name!=='Onesa Account').every(x=>x.state==='unknown'));
    }finally{globalThis.fetch=previous;}
  }
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
