import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveWakeRequest,
  validateWakeRequest,
  channelNoticeContent,
  channelNoticeMeta,
  WAKE_SCHEMA,
} from '../src/wake.js';

function inbound(over = {}) {
  return {
    orgId: 'org1', orgSlug: 'acme', conversationId: 'conv1', messageId: 'msg1',
    senderId: 'mem1', senderType: 'HUMAN', text: 'hello world', endpoint: 'conv1',
    via: 'ws', decision: { handle: true, reason: 'ok' }, message: {},
    ...over,
  };
}

test('deriveWakeRequest: builds raft-channel-wake.v1 shape with senderId', () => {
  const w = deriveWakeRequest(inbound());
  assert.equal(w.schema, WAKE_SCHEMA);
  assert.equal(w.messageId, 'msg1');
  assert.equal(w.conversationId, 'conv1');
  assert.equal(w.senderId, 'mem1');
  assert.equal(w.contentPreview, 'hello world');
});

test('deriveWakeRequest: tolerates missing senderId (OPTIONAL per schema)', () => {
  const w = deriveWakeRequest(inbound({ senderId: undefined }));
  assert.equal('senderId' in w, false, 'senderId must be omitted, not empty');
  // still valid against the contract
  assert.doesNotThrow(() => validateWakeRequest(w));
});

test('deriveWakeRequest: requires messageId and conversationId', () => {
  assert.throws(() => deriveWakeRequest(inbound({ messageId: '' })), /messageId/);
  assert.throws(() => deriveWakeRequest(inbound({ conversationId: '' })), /conversationId/);
  assert.throws(() => deriveWakeRequest(null), /required/);
});

test('deriveWakeRequest: truncates preview beyond previewMax and marks it', () => {
  const long = 'x'.repeat(50);
  const w = deriveWakeRequest(inbound({ text: long }), { previewMax: 10 });
  assert.ok(w.contentPreview.startsWith('xxxxxxxxxx'));
  assert.match(w.contentPreview, /truncated 40 chars/);
});

test('deriveWakeRequest: empty text yields empty preview (still required string)', () => {
  const w = deriveWakeRequest(inbound({ text: '' }));
  assert.equal(w.contentPreview, '');
  // empty contentPreview fails validation (must be non-empty) — surfaces as a
  // derive-then-validate contract check; deriveWakeRequest itself does not throw.
  assert.throws(() => validateWakeRequest(w), /contentPreview/);
});

test('validateWakeRequest: rejects wrong schema tag', () => {
  assert.throws(() => validateWakeRequest({ schema: 'nope', messageId: 'm', conversationId: 'c', contentPreview: 'p' }), /schema/);
});

test('validateWakeRequest: rejects unknown / content-shaped extra fields', () => {
  const base = { schema: WAKE_SCHEMA, messageId: 'm', conversationId: 'c', contentPreview: 'p' };
  assert.throws(() => validateWakeRequest({ ...base, body: 'leak' }), /not allowed/);
  assert.throws(() => validateWakeRequest({ ...base, text: 'leak' }), /not allowed/);
});

test('validateWakeRequest: rejects empty senderId when present', () => {
  const base = { schema: WAKE_SCHEMA, messageId: 'm', conversationId: 'c', contentPreview: 'p' };
  assert.throws(() => validateWakeRequest({ ...base, senderId: '' }), /senderId/);
});

test('channelNoticeContent: single wake includes ids and preview when enabled', () => {
  const w = deriveWakeRequest(inbound());
  const text = channelNoticeContent([w], { includePreview: true });
  assert.match(text, /message_id=msg1/);
  assert.match(text, /sender_id=mem1/);
  assert.match(text, /hello world/);
  assert.match(text, /comm_send/);
});

test('channelNoticeContent: burst is coalesced into one notice covering all', () => {
  const ws = [deriveWakeRequest(inbound({ messageId: 'a' })), deriveWakeRequest(inbound({ messageId: 'b' }))];
  const text = channelNoticeContent(ws);
  assert.match(text, /2 new workspace messages/);
  assert.match(text, /message_ids=a,b/);
});

test('channelNoticeMeta: carries routing ids, omits sender when absent', () => {
  const meta = channelNoticeMeta([deriveWakeRequest(inbound({ senderId: undefined }))]);
  assert.equal(meta.openmax_message_id, 'msg1');
  assert.equal(meta.openmax_conversation_id, 'conv1');
  assert.equal('openmax_sender_id' in meta, false);
});
