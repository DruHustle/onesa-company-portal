// Real local process/HTTP failures; no application credentials or hosted traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {listenFixture,closeFixtureServer,spawnFixture,fetchFixture,waitForFixtureFrontend,withFixtureResource} from './oracle_portal_test_lifecycle.mjs';

const context = controller => ({signal: controller.signal, diagnostic() {}});
const childOptions = {env: {PATH: process.env.PATH}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']};

test('a successful owned resource is closed once and retains its result', async t => {
  let closes = 0;
  const resource = {close: async () => { closes++; }};
  assert.equal(await withFixtureResource(t, async () => resource, async actual => {
    assert.equal(actual, resource); return 'observed';
  }), 'observed');
  assert.equal(closes, 1);
});

test('abort closes the resource and settles an otherwise pending operation', async () => {
  const controller = new AbortController(), pending = Promise.withResolvers(), entered = Promise.withResolvers();
  const original = new Error('Synthetic test cancellation'); let closes = 0, finalized = false;
  const resource = {close: async () => { closes++; pending.reject(original); }};
  const running = withFixtureResource(context(controller), async () => resource, async () => {
    entered.resolve(); try { await pending.promise; } finally { finalized = true; }
  });
  const rejected = assert.rejects(running, error => error === original);
  await entered.promise; controller.abort(original); await rejected;
  assert.equal(finalized, true); assert.equal(closes, 1);
});

test('a resource acquired after cancellation is closed without running observations', async () => {
  const controller = new AbortController(), acquired = Promise.withResolvers(), started = Promise.withResolvers();
  const original = new Error('Synthetic late acquisition'); let closes = 0, observed = false;
  const running = withFixtureResource(context(controller), () => { started.resolve(); return acquired.promise; }, async () => { observed = true; });
  const rejected = assert.rejects(running, error => error === original);
  await started.promise; controller.abort(original); acquired.resolve({close: async () => { closes++; }});
  await rejected; assert.equal(observed, false); assert.equal(closes, 1);
});

test('primary observation failure survives cleanup failure without becoming success', async () => {
  const controller = new AbortController(), original = new Error('Original observation failure'), diagnostics = [];
  await assert.rejects(withFixtureResource({signal: controller.signal, diagnostic: value => diagnostics.push(value)},
    async () => ({close: async () => { throw new Error('Synthetic close failure'); }}),
    async () => { throw original; }), error => error === original);
  assert.deepEqual(diagnostics, ['Owned fixture cleanup failed; original failure preserved']);
});

test('an unresponsive resource close fails within its bound', async t => {
  await assert.rejects(withFixtureResource(t, async () => ({close: () => new Promise(() => {})}),
    async () => 'observed', {closeMs: 25}), error => error.code === 'FIXTURE_DEADLINE');
});

test('actual node:test cancellation exits failed after disposing a pending resource', {timeout: 5000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-lifecycle-cancel-'));
  const fixture = path.join(directory, 'cancel.mjs');
  fs.writeFileSync(fixture, `import test from 'node:test';
import {withFixtureResource} from ${JSON.stringify(new URL('./oracle_portal_test_lifecycle.mjs', import.meta.url).href)};
test('intentional cancellation', {timeout: 100}, async t => {
 const pending=Promise.withResolvers(); const handle=setInterval(()=>{},25);
 const resource={close:async()=>{clearInterval(handle);pending.reject(t.signal.reason);}};
 await withFixtureResource(t,async()=>resource,async()=>{try{await pending.promise;}finally{console.log('BODY_FINALLY');}});
});
`);
  const child = spawnFixture(process.execPath, [fixture], {env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(async () => { try { await child.stop(); } finally { fs.rmSync(directory, {recursive: true, force: true}); } });
  let output = ''; child.child.stdout.on('data', bytes => { output += bytes; }); child.child.stderr.on('data', bytes => { output += bytes; });
  const result = await child.exited;
  assert.equal(result.error, null); assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.match(output, /BODY_FINALLY/); assert.match(output, /timed out after 100ms/);
});

test('only the owned SIGTERM-resistant child receives the bounded SIGKILL fallback', {timeout: 5000}, async t => {
  const source = "process.on('SIGTERM',()=>{});setInterval(()=>{},25);process.send({ready:true});";
  const owned = spawnFixture(process.execPath, ['-e', source], childOptions, {graceMs: 40, killMs: 1000});
  const unrelated = spawnFixture(process.execPath, ['-e', source], childOptions, {graceMs: 40, killMs: 1000});
  t.after(async () => { await Promise.all([owned.stop(), unrelated.stop()]); });
  await Promise.all([once(owned.child, 'message'), once(unrelated.child, 'message')]);
  const first = owned.stop(), second = owned.stop(); assert.equal(first, second);
  const result = await first; assert.equal(result.signal, 'SIGKILL'); assert.equal(result.code, null);
  assert.equal(unrelated.finished, undefined, 'Another fixture process must remain alive');
});

test('already exited and failed-spawn children cannot leave cleanup waiting', {timeout: 5000}, async t => {
  const exited = spawnFixture(process.execPath, ['-e', 'process.exit(0)'], {env: {PATH: process.env.PATH}, stdio: 'ignore'});
  const missing = spawnFixture(path.join(os.tmpdir(), `onesa-missing-fixture-${process.pid}`), [], {stdio: 'ignore'});
  t.after(async () => { await Promise.all([exited.stop(), missing.stop()]); });
  assert.equal((await exited.exited).code, 0);
  assert.equal((await missing.exited).error.code, 'ENOENT');
  assert.equal(await exited.stop(), exited.finished); assert.equal(await missing.stop(), missing.finished);
  await assert.rejects(waitForFixtureFrontend(missing, 'http://127.0.0.1:1'), /exited before readiness/);
});

test('startup rejects a real HTTP peer that never sends headers', {timeout: 3000}, async t => {
  const requested = Promise.withResolvers(), disconnected = Promise.withResolvers();
  const server = http.createServer(request => { requested.resolve(); request.once('close', disconnected.resolve); });
  t.after(() => closeFixtureServer(server)); const port = await listenFixture(server);
  const waiting = waitForFixtureFrontend({finished: undefined}, `http://127.0.0.1:${port}`, {startupMs: 100, signal: t.signal});
  const rejected = assert.rejects(waiting, /startup deadline/);
  await requested.promise; await rejected; await disconnected.promise;
});

test('startup cancels a successful response body that remains open', {timeout: 3000}, async t => {
  const disconnected = Promise.withResolvers();
  const server = http.createServer((request, response) => {
    request.once('close', disconnected.resolve); response.writeHead(200); response.write('public fixture');
  });
  t.after(() => closeFixtureServer(server)); const port = await listenFixture(server);
  await waitForFixtureFrontend({finished: undefined}, `http://127.0.0.1:${port}`, {startupMs: 1000, signal: t.signal});
  await disconnected.promise;
});

test('the HTTP deadline covers a stalled body after successful headers', {timeout: 3000}, async t => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('public fixture'); });
  t.after(() => closeFixtureServer(server)); const port = await listenFixture(server);
  const response = await fetchFixture(`http://127.0.0.1:${port}/`, {}, {timeoutMs: 100});
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer(), error => ['TimeoutError', 'AbortError'].includes(error.name));
});

test('actual redirects neither reach their target nor satisfy startup readiness', {timeout: 3000}, async t => {
  let arrivals = 0;
  const target = http.createServer((_request, response) => { arrivals++; response.end('not the requested frontend'); });
  const targetPort = await listenFixture(target);
  const start = http.createServer((_request, response) => response.writeHead(302, {location: `http://127.0.0.1:${targetPort}/`}).end());
  t.after(async () => { await Promise.all([closeFixtureServer(start), closeFixtureServer(target)]); });
  const startPort = await listenFixture(start), origin = `http://127.0.0.1:${startPort}`;
  const response = await fetchFixture(origin); assert.equal(response.status, 302); await response.body?.cancel();
  await assert.rejects(waitForFixtureFrontend({finished: undefined}, origin, {startupMs: 100, signal: t.signal}), /startup deadline/);
  assert.equal(arrivals, 0);
  assert.throws(() => fetchFixture(origin, {redirect: 'follow'}), /never followed/);
});

test('server cleanup closes actual held connections and is repeatable', {timeout: 3000}, async t => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('held'); });
  t.after(() => closeFixtureServer(server)); const port = await listenFixture(server);
  const response = await fetchFixture(`http://127.0.0.1:${port}/`);
  const rejected = assert.rejects(response.arrayBuffer());
  await closeFixtureServer(server); await rejected; await closeFixtureServer(server);
  assert.equal(server.listening, false);
});

test('test HTTP helper refuses non-loopback, HTTPS and credential-bearing targets before requesting', () => {
  for (const url of ['https://127.0.0.1/', 'http://example.invalid/', 'http://user:password@127.0.0.1/']) {
    assert.throws(() => fetchFixture(url), assert.AssertionError);
  }
});
