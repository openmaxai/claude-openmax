import test from 'node:test';
import assert from 'node:assert/strict';
import { createStderrLogger } from '../src/providers.js';

// Regression: the SDK's RPC logger calls logger.log(...). createStderrLogger
// originally only defined info/warn/error/debug, so the FIRST token exchange
// threw "this._logger.log is not a function" out of the box. Guard every level
// the SDK may call, and that .log is a no-throw.
test('createStderrLogger exposes every level the SDK may call (incl. .log)', () => {
  const l = createStderrLogger('[test]');
  for (const m of ['info', 'log', 'warn', 'error', 'debug']) {
    assert.equal(typeof l[m], 'function', `logger.${m} must be a function`);
  }
  assert.doesNotThrow(() => l.log('rpc trace', { conversationId: 'c1' }));
});
