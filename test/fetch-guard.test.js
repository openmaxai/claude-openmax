import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGuardedFetch, fetchCause } from '../src/fetch-guard.js';

const netErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const ok = { ok: true, status: 200 };

test('network error names method + path + cause (no query string)', async () => {
  const f = createGuardedFetch({ baseFetch: async () => { throw netErr('ECONNRESET'); }, retries: 0 });
  await assert.rejects(() => f('https://core.test/api/v1/conversations?ticket=SECRET', { method: 'GET' }),
    (e) => e.message === 'fetch failed: GET /api/v1/conversations → ECONNRESET' && e.cause?.cause?.code === 'ECONNRESET');
});

test('times out a hung request and says which one', async () => {
  const hang = (url, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const f = createGuardedFetch({ baseFetch: hang, timeoutMs: 20, retries: 0 });
  await assert.rejects(() => f('https://core.test/auth/agent/token', { method: 'POST', body: '{}' }),
    (e) => e.name === 'TimeoutError' && e.message === 'fetch timed out after 20ms: POST /auth/agent/token');
});

test('token / ws-ticket requests are retried on network errors, then succeed', async () => {
  let n = 0;
  const f = createGuardedFetch({ baseFetch: async () => { if (++n < 3) throw netErr('ECONNRESET'); return ok; }, retryDelayMs: 1 });
  assert.equal(await f('https://core.test/auth/ws-ticket', { method: 'POST', body: '{}' }), ok);
  assert.equal(n, 3);
});

test('other paths are not retried', async () => {
  let n = 0;
  const f = createGuardedFetch({ baseFetch: async () => { n++; throw netErr('ECONNREFUSED'); }, retryDelayMs: 1 });
  await assert.rejects(() => f('https://core.test/api/v1/messages', { method: 'POST', body: '{}' }));
  assert.equal(n, 1);
});

test('an HTTP error status is returned as-is (never retried here)', async () => {
  let n = 0;
  const res500 = { ok: false, status: 500 };
  const f = createGuardedFetch({ baseFetch: async () => { n++; return res500; }, retryDelayMs: 1 });
  assert.equal(await f('https://core.test/auth/agent/token', { method: 'POST', body: '{}' }), res500);
  assert.equal(n, 1);
});

test('uploads (PUT / binary body) are not timed out', async () => {
  let sawSignal = 'unset';
  const f = createGuardedFetch({ baseFetch: async (u, init) => { sawSignal = init.signal; return ok; }, timeoutMs: 1 });
  await f('https://s3.test/put', { method: 'PUT', body: Buffer.from('x') });
  assert.equal(sawSignal, undefined);
  await f('https://core.test/upload', { method: 'POST', body: new Uint8Array(1) });
  assert.equal(sawSignal, undefined);
});

test('a caller abort is passed through and not retried', async () => {
  let n = 0;
  const ctrl = new AbortController();
  const f = createGuardedFetch({
    baseFetch: (u, init) => { n++; return new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); },
    retryDelayMs: 1,
  });
  const p = f('https://core.test/auth/ws-ticket', { method: 'POST', body: '{}', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(n, 1);
});

test('fetchCause prefers cause.code', () => {
  assert.equal(fetchCause(netErr('ENOTFOUND')), 'ENOTFOUND');
  assert.equal(fetchCause(new Error('plain')), 'plain');
});
