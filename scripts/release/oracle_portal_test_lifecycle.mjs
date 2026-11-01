// Disposable local tests only. No hosted probe, receipt or production process
// imports this helper. Termination uses only ChildProcess handles created here.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

async function deadline(operation, milliseconds, label) {
  assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} deadline exceeded`);
          error.code = 'FIXTURE_DEADLINE'; reject(error);
        }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function listenFixture(server, {timeoutMs = 5000} = {}) {
  let failed;
  try {
    await deadline(() => new Promise((resolve, reject) => {
      failed = reject; server.once('error', failed);
      server.listen(0, '127.0.0.1', resolve);
    }), timeoutMs, 'Fixture listen');
    return server.address().port;
  } catch (error) {
    server.closeAllConnections(); server.close(() => {}); throw error;
  } finally { if (failed) server.removeListener('error', failed); }
}

export async function closeFixtureServer(server, {timeoutMs = 5000} = {}) {
  if (!server) return;
  if (!server.listening) { server.closeAllConnections(); return; }
  await deadline(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // Close intentionally held responses before awaiting the close callback.
    server.closeAllConnections();
  }), timeoutMs, 'Fixture server cleanup');
}

export function spawnFixture(command, args, options, {graceMs = 3000, killMs = 2000} = {}) {
  const child = spawn(command, args, options);
  let finished, stopping;
  const exited = new Promise(resolve => {
    const complete = value => { if (!finished) { finished = value; resolve(value); } };
    // Register both outcomes immediately, before startup polling or cleanup.
    child.once('error', error => complete({error, code: null, signal: null}));
    child.once('exit', (code, signal) => complete({error: null, code, signal}));
  });
  return {
    child, exited,
    get finished() { return finished; },
    stop() {
      if (!stopping) stopping = (async () => {
        if (finished) return finished;
        child.kill('SIGTERM');
        try { return await deadline(() => exited, graceMs, 'Fixture SIGTERM'); }
        catch (error) { if (error.code !== 'FIXTURE_DEADLINE') throw error; }
        if (finished) return finished;
        child.kill('SIGKILL');
        return deadline(() => exited, killMs, 'Fixture SIGKILL');
      })();
      return stopping;
    },
  };
}

export function fetchFixture(url, options = {}, {timeoutMs = 10000, signal} = {}) {
  const target = new URL(url);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.username, ''); assert.equal(target.password, '');
  assert.ok(options.redirect === undefined || options.redirect === 'manual', 'Fixture redirects are never followed');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  // The signal remains attached through body reads, not only response headers.
  const signals = [AbortSignal.timeout(timeoutMs), options.signal, signal].filter(Boolean);
  return fetch(target, {...options, redirect: 'manual', signal: AbortSignal.any(signals)});
}

export async function waitForFixtureFrontend(process, origin, {startupMs = 15000, signal} = {}) {
  assert.ok(Number.isSafeInteger(startupMs) && startupMs > 0);
  const expires = performance.now() + startupMs;
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    assert.equal(process.finished, undefined, 'Isolated frontend exited before readiness');
    const remaining = Math.ceil(expires - performance.now());
    if (remaining <= 0) break;
    try {
      const response = await fetchFixture(`${origin}/en/products/onesa-drone`, {}, {timeoutMs: Math.min(2000, remaining), signal});
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return;
    } catch { signal?.throwIfAborted(); }
    const pause = Math.min(250, Math.ceil(expires - performance.now()));
    if (pause <= 0) break;
    await delay(pause, undefined, signal ? {signal} : undefined);
  }
  throw new Error('Isolated production build did not become ready within its startup deadline');
}

export async function withFixtureResource(t, acquire, observe, {closeMs = 5000} = {}) {
  let resource, closing, primary;
  const close = () => {
    if (!resource) return Promise.resolve(); // A late acquisition is closed in finally.
    if (!closing) closing = deadline(() => resource.close(), closeMs, 'Owned fixture cleanup');
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  t.signal.addEventListener('abort', abort, {once: true});
  try {
    t.signal.throwIfAborted();
    resource = await acquire();
    t.signal.throwIfAborted();
    const result = await observe(resource);
    t.signal.throwIfAborted();
    return result;
  } catch (error) { primary = error; throw error; }
  finally {
    t.signal.removeEventListener('abort', abort);
    try { await close(); }
    catch (error) {
      if (!primary) throw error;
      t.diagnostic('Owned fixture cleanup failed; original failure preserved');
    }
  }
}
