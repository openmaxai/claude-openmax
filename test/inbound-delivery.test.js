import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInboundDelivery } from '../src/inbound-delivery.js';

const inbound = { messageId: 'msg1', conversationId: 'conv1', senderId: 'm1', text: 'hi' };

test('ok:true ONLY when the wake injection resolves; carries runtimeSession', async () => {
  const calls = [];
  const del = createInboundDelivery({
    wake: async (req) => { calls.push(req); return { runtimeSession: 'claude_abc' }; },
  });
  const res = await del.deliver(inbound);
  assert.deepEqual(res, { ok: true, runtimeSession: 'claude_abc' });
  assert.equal(calls[0].messageId, 'msg1');
});

test('falls back to configured runtimeSession when the injector returns none', async () => {
  const del = createInboundDelivery({ wake: async () => ({}), runtimeSession: 'claude_fallback' });
  const res = await del.deliver(inbound);
  assert.deepEqual(res, { ok: true, runtimeSession: 'claude_fallback' });
});

test('wake throwing with a failureClass maps to {ok:false, failureClass, retryAfterMs}', async () => {
  const del = createInboundDelivery({
    wake: async () => { const e = new Error('no session'); e.failureClass = 'runtime_unavailable'; e.retryAfterMs = 1234; throw e; },
  });
  const res = await del.deliver(inbound);
  assert.equal(res.ok, false);
  assert.equal(res.failureClass, 'runtime_unavailable');
  assert.equal(res.retryAfterMs, 1234);
});

test('generic wake failure falls back to canonical wake_failed + default backoff', async () => {
  const del = createInboundDelivery({ wake: async () => { throw new Error('boom'); }, retryAfterMs: 5000 });
  const res = await del.deliver(inbound);
  assert.equal(res.ok, false);
  assert.equal(res.failureClass, 'wake_failed');
  assert.equal(res.retryAfterMs, 5000);
});

test('never returns ok:true when the injector throws (no false ack)', async () => {
  const del = createInboundDelivery({ wake: async () => { throw new Error('x'); } });
  const res = await del.deliver(inbound);
  assert.notEqual(res.ok, true);
});

test('malformed inbound (no messageId) => ok:false wake_failed, injector not called', async () => {
  let called = false;
  const del = createInboundDelivery({ wake: async () => { called = true; } });
  const res = await del.deliver({ conversationId: 'c', text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.failureClass, 'wake_failed');
  assert.equal(called, false);
});

test('createInboundDelivery requires a wake function', () => {
  assert.throws(() => createInboundDelivery({}), /wake/);
});
