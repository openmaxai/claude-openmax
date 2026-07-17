import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionStartOutput, OPENMAX_SESSION_ORIENTATION } from '../hooks/orientation.js';

test('SessionStart payload => hookSpecificOutput with orientation context', () => {
  const out = buildSessionStartOutput({ hook_event_name: 'SessionStart' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, OPENMAX_SESSION_ORIENTATION);
});

test('non-SessionStart / malformed payload => null (no output)', () => {
  assert.equal(buildSessionStartOutput({ hook_event_name: 'Stop' }), null);
  assert.equal(buildSessionStartOutput(null), null);
  assert.equal(buildSessionStartOutput('x'), null);
});

test('orientation forbids extra compression (built-in autocompact only)', () => {
  assert.match(OPENMAX_SESSION_ORIENTATION, /autocompact/);
});
