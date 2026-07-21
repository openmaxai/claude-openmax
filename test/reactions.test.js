import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReactionManager } from '../src/reactions.js';

// ── fakes ──────────────────────────────────────────────────────────────────
function makeHttp({ failDelete = false } = {}) {
  const posts = [];
  const dels = [];
  return {
    posts,
    dels,
    apiPath: (p) => `/api/v1${p}`,
    async postForOrg(orgId, path, body) {
      posts.push({ orgId, path, body });
      return { ok: true };
    },
    async delForOrg(orgId, path) {
      dels.push({ orgId, path });
      if (failDelete) throw new Error('boom-delete');
      return { ok: true };
    },
  };
}

function makeStorage(initial) {
  const map = new Map();
  if (initial) map.set('reactions/active.json', JSON.stringify(initial));
  return {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async set(k, v) {
      map.set(k, String(v));
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function readMarkers(storage) {
  const raw = storage.map.get('reactions/active.json');
  return raw ? JSON.parse(raw) : {};
}

async function waitFor(pred, { timeoutMs = 500, stepMs = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── react-on-receive ─────────────────────────────────────────────────────────
test('applyOnReceive issues the POST and persists a marker', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', timeoutMs: 60_000, logger: silentLogger });

  await mgr.applyOnReceive('org1', 'conv1', 'msg1');

  assert.equal(http.posts.length, 1);
  assert.deepEqual(http.posts[0], {
    orgId: 'org1',
    path: '/api/v1/messages/msg1/reactions',
    body: { reaction_code: 'eyes' },
  });
  const markers = readMarkers(storage);
  assert.ok(markers.msg1, 'marker persisted for msg1');
  assert.equal(markers.msg1.orgId, 'org1');
  assert.equal(markers.msg1.conversationId, 'conv1');
  assert.equal(markers.msg1.code, 'eyes');
  assert.equal(mgr._activeCount(), 1);
});

// ── reply clears (DELETE + marker removed + timer cleared) ─────────────────────
test('clearForConversation removes the reaction, clears the marker and timer', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', timeoutMs: 60_000, logger: silentLogger });

  await mgr.applyOnReceive('org1', 'conv1', 'msg1');
  assert.equal(mgr._activeCount(), 1);

  await mgr.clearForConversation('conv1', 'reply');

  assert.equal(http.dels.length, 1);
  assert.deepEqual(http.dels[0], { orgId: 'org1', path: '/api/v1/messages/msg1/reactions/eyes' });
  assert.deepEqual(readMarkers(storage), {}, 'marker removed');
  assert.equal(mgr._activeCount(), 0, 'in-memory entry + timer cleared');
});

test('clearForMessage removes a specific messageId reaction', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', timeoutMs: 60_000, logger: silentLogger });

  await mgr.applyOnReceive('org1', 'conv1', 'msgA');
  await mgr.clearForMessage('msgA', 'reply');

  assert.equal(http.dels.length, 1);
  assert.equal(http.dels[0].path, '/api/v1/messages/msgA/reactions/eyes');
  assert.deepEqual(readMarkers(storage), {});
});

// ── timeout fires DELETE ──────────────────────────────────────────────────────
test('the timeout fires a DELETE when no reply arrives', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', timeoutMs: 15, logger: silentLogger });

  await mgr.applyOnReceive('org1', 'conv1', 'msg1');
  await waitFor(() => http.dels.length === 1);

  assert.deepEqual(http.dels[0], { orgId: 'org1', path: '/api/v1/messages/msg1/reactions/eyes' });
  await waitFor(() => Object.keys(readMarkers(storage)).length === 0);
  assert.equal(mgr._activeCount(), 0);
});

// ── remove retries once on failure ─────────────────────────────────────────────
test('reaction removal retries once on failure', async () => {
  const http = makeHttp({ failDelete: true });
  const storage = makeStorage();
  const mgr = createReactionManager({
    http, storage, code: 'eyes', timeoutMs: 60_000, removeRetryMs: 5, logger: silentLogger,
  });

  await mgr.applyOnReceive('org1', 'conv1', 'msg1');
  await mgr.clearForConversation('conv1', 'reply');

  // one immediate attempt + one retry = 2 DELETE calls
  await waitFor(() => http.dels.length === 2);
  assert.equal(http.dels.length, 2);
  // both attempts failed → marker intentionally left for the next startup cleanup
  assert.ok(readMarkers(storage).msg1, 'marker retained after double-failure');
});

// ── startup cleanup removes ALL leftover markers ───────────────────────────────
test('cleanupOnStartup DELETEs every leftover reaction and clears all markers', async () => {
  const http = makeHttp();
  const storage = makeStorage({
    msg1: { orgId: 'org1', conversationId: 'conv1', code: 'eyes', ts: 1 },
    msg2: { orgId: 'org2', conversationId: 'conv2', code: 'eyes', ts: 2 },
  });
  const mgr = createReactionManager({ http, storage, code: 'eyes', timeoutMs: 60_000, logger: silentLogger });

  const res = await mgr.cleanupOnStartup();

  assert.equal(res.removed, 2);
  assert.equal(http.dels.length, 2);
  const paths = http.dels.map((d) => d.path).sort();
  assert.deepEqual(paths, [
    '/api/v1/messages/msg1/reactions/eyes',
    '/api/v1/messages/msg2/reactions/eyes',
  ]);
  assert.deepEqual(readMarkers(storage), {}, 'all markers cleared on restart');
});

test('cleanupOnStartup is a no-op with no markers', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', logger: silentLogger });
  const res = await mgr.cleanupOnStartup();
  assert.equal(res.removed, 0);
  assert.equal(http.dels.length, 0);
});

// ── feature disabled ───────────────────────────────────────────────────────────
test('feature disabled (code falsy) makes applyOnReceive a no-op', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: '', timeoutMs: 60_000, logger: silentLogger });

  assert.equal(mgr.enabled, false);
  await mgr.applyOnReceive('org1', 'conv1', 'msg1');

  assert.equal(http.posts.length, 0, 'no POST when disabled');
  assert.deepEqual(readMarkers(storage), {}, 'no marker when disabled');
  assert.equal(mgr._activeCount(), 0);
});

test('applyOnReceive tolerates missing orgId/messageId without throwing', async () => {
  const http = makeHttp();
  const storage = makeStorage();
  const mgr = createReactionManager({ http, storage, code: 'eyes', logger: silentLogger });

  await mgr.applyOnReceive('', 'conv1', 'msg1');
  await mgr.applyOnReceive('org1', 'conv1', '');
  assert.equal(http.posts.length, 0);
});
