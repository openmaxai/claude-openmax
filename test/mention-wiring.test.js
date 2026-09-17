import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTools } from '../src/mcp-tools.js';
import { createInboundDelivery } from '../src/inbound-delivery.js';

// These guard the WIRING and the on-the-wire placement, not the resolution
// algorithm (that is mentions.test.js). Without them the registry can be
// perfectly correct and still never be called, or be called and have its result
// posted where cws-core does not index it — both indistinguishable from the bug.

function spyMentions(mentions = [{ type: 'member', member_id: 'm1' }]) {
  const recorded = [];
  const decorated = [];
  return {
    recorded,
    decorated,
    record: async (p) => { recorded.push(p); },
    decorate: async (text, conversationId) => {
      decorated.push({ text, conversationId });
      return { text: `CANON:${text}`, mentions };
    },
  };
}

// A comm service whose http client records every call, shaped like CwsHttpClient.
function spyComm({ members = [] } = {}) {
  const posts = [];
  const gets = [];
  return {
    posts,
    gets,
    service: {
      send: async (p) => { posts.push({ via: 'service.send', params: p }); return { id: 'msg-svc' }; },
      http: {
        apiPath: (p) => `/api/v1${p}`,
        get: async (path) => { gets.push({ path }); return members; },
        getForOrg: async (orgId, path) => { gets.push({ orgId, path }); return members; },
        post: async (path, body) => { posts.push({ path, body }); return { id: 'msg-1' }; },
        postForOrg: async (orgId, path, body) => { posts.push({ orgId, path, body }); return { id: 'msg-1' }; },
      },
    },
  };
}

test('inbound.deliver feeds the sender display name into the registry', async () => {
  const mentions = spyMentions();
  const del = createInboundDelivery({ wake: async () => ({}), mentions });
  await del.deliver({ messageId: 'm1', conversationId: 'c1', senderId: 'mem-9', senderDisplayName: 'zylos0t', text: 'hi' });
  assert.deepEqual(mentions.recorded, [{ conversationId: 'c1', displayName: 'zylos0t', memberId: 'mem-9' }]);
});

// A storage hiccup in a best-effort side channel must not cost us the message.
test('inbound.deliver still delivers when the registry throws', async () => {
  let woke = false;
  const del = createInboundDelivery({
    wake: async () => { woke = true; return {}; },
    mentions: { record: async () => { throw new Error('disk on fire'); } },
  });
  const res = await del.deliver({ messageId: 'm1', conversationId: 'c1', text: 'hi' });
  assert.equal(res.ok, true);
  assert.equal(woke, true);
});

// THE regression guard. `bridge.send` cannot carry mentions at all, and an
// array nested under content.body is stored as body data and indexed by nobody.
test('comm_send posts mentions at the TOP LEVEL, not inside content.body', async () => {
  const mentions = spyMentions();
  const comm = spyComm();
  const bridge = { send: async () => { throw new Error('bridge.send must not be used for a mentioning send'); } };
  const { handler } = createMcpTools({ services: { comm: comm.service }, bridge, mentions });

  const res = await handler('comm_send', { endpoint: 'conv-7|reply:msg-1', content: '@ZYLOS0T ping', orgId: 'org-1' });
  assert.equal(res.isError, undefined);

  // The conversation id is the leading endpoint segment, not the whole string.
  assert.deepEqual(mentions.decorated, [{ text: '@ZYLOS0T ping', conversationId: 'conv-7' }]);

  const sent = comm.posts.find((p) => p.path?.endsWith('/messages'));
  assert.equal(sent.orgId, 'org-1');
  assert.equal(sent.path, '/api/v1/conversations/conv-7/messages');
  assert.deepEqual(sent.body.mentions, [{ type: 'member', member_id: 'm1' }]);
  assert.equal(sent.body.content.body.mentions, undefined);
  assert.equal(sent.body.content.body.text, 'CANON:@ZYLOS0T ping');
  assert.equal(sent.body.parent_id, 'msg-1'); // reply routing survives the detour
  assert.ok(sent.body.client_msg_id);
});

// Everything that does not mention anyone keeps the pre-existing transport.
test('comm_send without a resolved mention still goes through bridge.send', async () => {
  const mentions = spyMentions([]);
  const comm = spyComm();
  const sent = [];
  const bridge = { send: async (endpoint, content, opts) => { sent.push({ endpoint, content, opts }); return { messageId: 'b1' }; } };
  const { handler } = createMcpTools({ services: { comm: comm.service }, bridge, mentions });

  await handler('comm_send', { endpoint: 'conv-7', content: '@nobody ping' });

  assert.equal(sent[0].content, 'CANON:@nobody ping');
  assert.equal(comm.posts.length, 0);
});

// The generic dispatch path must not be a silent bypass.
test('generic comm/send routes mentions through the SDK body override', async () => {
  const mentions = spyMentions();
  const comm = spyComm();
  const { handler } = createMcpTools({ services: { comm: comm.service }, mentions });

  await handler('comm', { method: 'send', params: { conversationId: 'conv-8', content: '@ZYLOS0T ping' } });

  assert.deepEqual(mentions.decorated, [{ text: '@ZYLOS0T ping', conversationId: 'conv-8' }]);
  const p = comm.posts[0].params;
  // buildSendBody forwards `body` verbatim only when it carries content + type.
  assert.equal(p.content, undefined);
  assert.equal(p.body.type, 'AGENT_TEXT');
  assert.deepEqual(p.body.mentions, [{ type: 'member', member_id: 'm1' }]);
  assert.equal(p.body.content.body.text, 'CANON:@ZYLOS0T ping');
});

// The http client unwraps the response envelope, so a list endpoint returns a
// bare array. Reading `res.data` yields undefined and loops zero times — silent,
// and indistinguishable from the hydration never running.
test('roster hydration consumes a bare-array response', async () => {
  const mentions = spyMentions();
  const comm = spyComm({ members: [
    { member_id: 'm-1', display_name: 'zylos0t' },
    { member_id: 'm-2', display_name: 'nova-noah' },
  ] });
  const bridge = { send: async () => ({}) };
  const { handler } = createMcpTools({ services: { comm: comm.service }, bridge, mentions, defaultOrgId: 'org-9' });

  await handler('comm_send', { endpoint: 'conv-5', content: '@zylos0t ping' });

  assert.deepEqual(comm.gets, [{ orgId: 'org-9', path: '/api/v1/conversations/conv-5/members' }]);
  assert.deepEqual(mentions.recorded, [
    { conversationId: 'conv-5', displayName: 'zylos0t', memberId: 'm-1' },
    { conversationId: 'conv-5', displayName: 'nova-noah', memberId: 'm-2' },
  ]);
});

test('roster hydration is skipped for text with no @ and cached per conversation', async () => {
  const mentions = spyMentions();
  const comm = spyComm({ members: [{ member_id: 'm-1', display_name: 'zylos0t' }] });
  const bridge = { send: async () => ({}) };
  const { handler } = createMcpTools({ services: { comm: comm.service }, bridge, mentions });

  await handler('comm_send', { endpoint: 'conv-5', content: 'no at sign here' });
  assert.equal(comm.gets.length, 0);

  await handler('comm_send', { endpoint: 'conv-5', content: '@zylos0t one' });
  await handler('comm_send', { endpoint: 'conv-5', content: '@zylos0t two' });
  assert.equal(comm.gets.length, 1, 'second send within the TTL must reuse the roster');
});

test('a failing roster read does not stop the send', async () => {
  const mentions = spyMentions([]);
  const sent = [];
  const services = { comm: { http: {
    apiPath: (p) => p,
    get: async () => { throw new Error('502'); },
    getForOrg: async () => { throw new Error('502'); },
  } } };
  const bridge = { send: async (endpoint, content) => { sent.push(content); return {}; } };
  const { handler } = createMcpTools({ services, bridge, mentions });

  const res = await handler('comm_send', { endpoint: 'conv-1', content: '@zylos0t ping' });
  assert.equal(res.isError, undefined);
  assert.equal(sent[0], 'CANON:@zylos0t ping');
});

test('a failing registry sends the original content verbatim rather than dropping the message', async () => {
  const sent = [];
  const bridge = { send: async (endpoint, content) => { sent.push(content); return { ok: true }; } };
  const { handler } = createMcpTools({
    services: { comm: {} },
    bridge,
    mentions: { decorate: async () => { throw new Error('boom'); } },
  });
  const res = await handler('comm_send', { endpoint: 'conv-9', content: '@zylos0t ping' });
  assert.equal(res.isError, undefined);
  assert.equal(sent[0], '@zylos0t ping');
});

test('with no registry wired, content passes through untouched', async () => {
  const sent = [];
  const bridge = { send: async (endpoint, content) => { sent.push(content); return { ok: true }; } };
  const { handler } = createMcpTools({ services: { comm: {} }, bridge });
  await handler('comm_send', { endpoint: 'conv-1', content: '@zylos0t ping' });
  assert.equal(sent[0], '@zylos0t ping');
});
