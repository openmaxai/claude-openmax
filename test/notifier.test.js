import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DebouncedWakeNotifier } from '../src/notifier.js';

test('debounceMs=0 forwards each wake immediately as a size-1 batch', async () => {
  const batches = [];
  const n = new DebouncedWakeNotifier({ notify: async (w) => { batches.push(w); }, debounceMs: 0 });
  await n.notify({ messageId: 'a' });
  await n.notify({ messageId: 'b' });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
});

test('leading-edge injection + window merge: burst -> fewer injections, all resolve', async () => {
  let injections = 0;
  const n = new DebouncedWakeNotifier({
    notify: async () => { injections += 1; },
    debounceMs: 20,
  });
  const p1 = n.notify({ messageId: 'a' });   // leading edge -> injects now
  const p2 = n.notify({ messageId: 'b' });   // merged into window
  const p3 = n.notify({ messageId: 'c' });   // merged into window
  await Promise.all([p1, p2, p3]);
  assert.equal(injections, 1, 'burst of 3 within window => 1 injection (EAB-8)');
});

test('a failed injection rejects all coalesced waiters (=> SDK redelivers each)', async () => {
  const n = new DebouncedWakeNotifier({
    notify: async () => { throw new Error('inject failed'); },
    debounceMs: 20,
  });
  const p1 = n.notify({ messageId: 'a' });
  const p2 = n.notify({ messageId: 'b' });
  await assert.rejects(p1, /inject failed/);
  await assert.rejects(p2, /inject failed/);
});

test('maxBatchSize flushes the window early (without waiting out the debounce)', async () => {
  let injections = 0;
  const n = new DebouncedWakeNotifier({
    notify: async () => { injections += 1; },
    debounceMs: 10_000,     // long window; reaching maxBatchSize must flush before it elapses
    maxBatchSize: 2,
  });
  const started = Date.now();
  const p1 = n.notify({ messageId: 'a' });   // leading edge (injects)
  const p2 = n.notify({ messageId: 'b' });   // pending #1
  const p3 = n.notify({ messageId: 'c' });   // pending #2 -> reaches maxBatchSize -> early flush
  await Promise.all([p1, p2, p3]);
  assert.equal(injections, 1, 'coalesced: leading edge injects once, pending ack against it');
  assert.ok(Date.now() - started < 9_000, 'flushed early, did not wait out the 10s debounce');
});
