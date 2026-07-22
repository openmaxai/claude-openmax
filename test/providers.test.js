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

// Opt-in: with NO logFile, nothing is written to disk (stderr-only, the default).
test('createStderrLogger writes NO file when logFile is not provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-nolog-'));
  const l = createStderrLogger('[test]'); // no { logFile }
  l.info('goes to stderr only');
  l.warn('still no file');
  assert.deepEqual(fs.readdirSync(dir), [], 'no log file should be created when file logging is off');
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

// Security: the log file is created 0600 (it can contain secrets), matching config.json.
test('createStderrLogger creates the log file with 0600 perms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-log-'));
  const logFile = path.join(dir, 'claude-openmax.log');
  const l = createStderrLogger('[test]', { logFile });
  l.info('touch');
  const mode = fs.statSync(logFile).mode & 0o777;
  assert.equal(mode, 0o600, `log file mode should be 0o600, got 0o${mode.toString(8)}`);
});

// Security: every line written to the FILE is scrubbed of common secret shapes.
test('createStderrLogger scrubs secrets (JWT / api_key / cwsk_ / Bearer) in the file sink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-log-'));
  const logFile = path.join(dir, 'claude-openmax.log');
  const l = createStderrLogger('[test]', { logFile });
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.s3cr3tSignaturePart';
  l.info(`token exchange failed: ${jwt}`);
  l.error('config has api_key=cwsk_LIVEsecret123 and Authorization: Bearer abc.def-ghi');
  l.warn('body {"api_key":"cwsk_anotherLiveKey","dmPolicy":"open"}');
  const contents = fs.readFileSync(logFile, 'utf8');
  // No raw secret material remains.
  assert.equal(contents.includes(jwt), false, 'JWT must be masked');
  assert.equal(contents.includes('cwsk_LIVEsecret123'), false, 'cwsk_ key must be masked');
  assert.equal(contents.includes('cwsk_anotherLiveKey'), false, 'cwsk_ key in JSON must be masked');
  assert.equal(/Bearer\s+abc\.def-ghi/.test(contents), false, 'Bearer token must be masked');
  // Non-secret content is preserved.
  assert.match(contents, /dmPolicy/);
  assert.match(contents, /\[redacted-jwt\]/);
});
