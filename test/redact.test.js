import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretsDeep, scrubLine, safeJson } from '../src/redact.js';

test('redactSecretsDeep: masks a NESTED api_key (deep, not just top-level)', () => {
  const input = {
    dmPolicy: 'open',
    agent: { api_key: 'cwsk_live', device_id: 'd1', nested: { client_secret: 'shh', token: 't' } },
    list: [{ apiKey: 'k1' }, { keep: 'ok' }],
  };
  const out = redactSecretsDeep(input);
  assert.equal(out.dmPolicy, 'open');
  assert.equal(out.agent.api_key, '[redacted]');
  assert.equal(out.agent.device_id, 'd1');            // non-secret preserved
  assert.equal(out.agent.nested.client_secret, '[redacted]');
  assert.equal(out.agent.nested.token, '[redacted]');
  assert.equal(out.list[0].apiKey, '[redacted]');
  assert.equal(out.list[1].keep, 'ok');
  // original is not mutated
  assert.equal(input.agent.api_key, 'cwsk_live');
});

test('redactSecretsDeep: cycle-safe and passes through non-objects', () => {
  const a = { name: 'x' }; a.self = a;
  assert.doesNotThrow(() => redactSecretsDeep(a));
  assert.equal(redactSecretsDeep('plain'), 'plain');
  assert.equal(redactSecretsDeep(42), 42);
  assert.equal(redactSecretsDeep(null), null);
});

test('scrubLine: masks JWT / cwsk_ / Bearer / labeled secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aSignature_part-123';
  assert.equal(scrubLine(jwt).includes(jwt), false);
  assert.match(scrubLine(jwt), /\[redacted-jwt\]/);

  assert.equal(scrubLine('key=cwsk_abc123DEF').includes('cwsk_abc123DEF'), false);
  assert.match(scrubLine('key=cwsk_abc123DEF'), /\[redacted-key\]/);

  assert.match(scrubLine('Authorization: Bearer abc.def-ghi_jkl'), /Bearer \[redacted\]/);
  assert.equal(/abc\.def-ghi_jkl/.test(scrubLine('Authorization: Bearer abc.def-ghi_jkl')), false);

  assert.match(scrubLine('{"api_key":"secretvalue","x":1}'), /"api_key":"?\[redacted\]/);
  assert.match(scrubLine('password=hunter2'), /password=\[redacted\]/);
  assert.match(scrubLine('client_secret: topsecret'), /client_secret:\s*\[redacted\]/);
});

test('scrubLine: leaves non-secret lines untouched and tolerates non-strings', () => {
  assert.equal(scrubLine('dmPolicy changed to open'), 'dmPolicy changed to open');
  assert.equal(scrubLine(''), '');
  assert.equal(scrubLine(undefined), undefined);
});

test('safeJson: stringifies and never throws on cycles', () => {
  assert.equal(safeJson({ a: 1 }), '{"a":1}');
  const c = {}; c.self = c;
  assert.doesNotThrow(() => safeJson(c));
});
