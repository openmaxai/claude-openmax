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

// ── thread endpoint + attachment preview ────────────────────────────────────────────────────

const THREAD_EP = 'conv1|thread:th9|parent:msg0';

test('deriveWakeRequest carries the SDK endpoint (thread replies land in the thread)', () => {
  const w = deriveWakeRequest(inbound({ endpoint: THREAD_EP }));
  assert.equal(w.endpoint, THREAD_EP);
  assert.doesNotThrow(() => validateWakeRequest(w), 'endpoint is an allowed optional field');
});

test('validateWakeRequest rejects an empty endpoint', () => {
  const w = deriveWakeRequest(inbound());
  assert.throws(() => validateWakeRequest({ ...w, endpoint: '' }), /endpoint/);
});

test('notice + meta expose the thread endpoint and tell the agent to reply with it', () => {
  const w = deriveWakeRequest(inbound({ endpoint: THREAD_EP }));
  const content = channelNoticeContent([w]);
  assert.match(content, /endpoint=conv1\|thread:th9\|parent:msg0/);
  assert.ok(content.includes(`comm_send\` ({endpoint: "${THREAD_EP}", content, replyTo: "msg1"})`), content);
  assert.equal(channelNoticeMeta([w]).openmax_endpoint, THREAD_EP);
});

test('plain DM: endpoint == conversation id is not repeated as its own line', () => {
  const content = channelNoticeContent([deriveWakeRequest(inbound())]);
  assert.ok(!/^endpoint=/m.test(content));
  assert.ok(content.includes('({endpoint: "conv1", content, replyTo: "msg1"})'));
});

test('attachment-only message gets a non-empty preview naming the attachments', () => {
  const w = deriveWakeRequest(inbound({ text: '', attachments: [{ file_name: 'shot.png', size: 10 }, { name: 'spec.pdf' }] }));
  assert.equal(w.contentPreview, '[2 attachments: shot.png, spec.pdf]');
  assert.doesNotThrow(() => validateWakeRequest(w), 'contentPreview must be non-empty for the split topology');
});

test('text + attachments: summary appended; long lists are capped', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ file_name: `f${i}.txt` }));
  const w = deriveWakeRequest(inbound({ text: 'see files', attachments: many }));
  assert.equal(w.contentPreview, 'see files\n[7 attachments: f0.txt, f1.txt, f2.txt, f3.txt, f4.txt, +2 more]');
  assert.equal(deriveWakeRequest(inbound({ attachments: [] })).contentPreview, 'hello world');
});
