import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// File tee: with { logFile }, lines are ALSO appended to the file (stderr kept),
// creating the parent directory if needed.
test('createStderrLogger tees log lines to the given logFile (append)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-log-'));
  const logFile = path.join(dir, 'nested', 'claude-openmax.log'); // dir does not exist yet
  const l = createStderrLogger('[test]', { logFile });
  l.info('hello', { org_id: 'o1' });
  l.warn('careful');
  const contents = fs.readFileSync(logFile, 'utf8');
  assert.match(contents, /INFO hello \{"org_id":"o1"\}/);
  assert.match(contents, /WARN careful/);
  // two emitted lines → two newline-terminated records
  assert.equal(contents.trim().split('\n').length, 2);
});

// Robustness: an unopenable logFile must NOT throw out of setup (degrades to
// stderr-only). Using a path whose parent is a FILE forces mkdir/open to fail.
test('createStderrLogger with an unusable logFile falls back to stderr-only (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-log-'));
  const notADir = path.join(dir, 'iamafile');
  fs.writeFileSync(notADir, 'x');
  const badLogFile = path.join(notADir, 'claude-openmax.log'); // parent is a file → open fails
  let l;
  assert.doesNotThrow(() => { l = createStderrLogger('[test]', { logFile: badLogFile }); });
  assert.doesNotThrow(() => l.info('still works via stderr'));
});
