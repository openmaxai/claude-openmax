import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTools } from '../src/mcp-tools.js';

function fakeServices() {
  return {
    tm: { issueCreate: async (p) => ({ id: 'issue1', title: p.title }), _secret: async () => 'nope' },
    comm: { getMessages: async (p) => ({ conversationId: p.conversationId, messages: [] }) },
    core: { me: async () => ({ member_id: 'self1' }) },
  };
}

function parse(result) { return JSON.parse(result.content[0].text); }

test('registers one dispatch tool per available service + comm_send', () => {
  const { defs } = createMcpTools({ services: fakeServices() });
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ['comm', 'comm_send', 'core', 'tm']);
});

test('dispatch: {method:"list"} enumerates callable verbs (excludes private)', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const res = await handler('tm', { method: 'list' });
  const body = parse(res);
  const names = body.methods.map((m) => m.name);
  assert.ok(names.includes('issueCreate'));
  assert.ok(!names.includes('_secret'));
});

test('dispatch: {method:"list"} returns per-method field schemas from the ops docs', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const body = parse(await handler('tm', { method: 'list' }));
  const issueCreate = body.methods.find((m) => m.name === 'issueCreate');
  // Each method entry carries a params[] of {name, required, description}.
  assert.ok(Array.isArray(issueCreate.params));
  const byName = Object.fromEntries(issueCreate.params.map((p) => [p.name, p]));
  // Required-ness reflects what cws-core validates.
  assert.equal(byName.projectId.required, true);
  assert.equal(byName.ownerMemberId.required, true);
  assert.equal(byName.backlog.required, false);
  assert.ok(typeof byName.projectId.description === 'string' && byName.projectId.description.length > 0);
});

test('dispatch: {method:"list"} flags SDK-vs-docs field divergences via note', async () => {
  const services = { kb: { pageUpdate: async () => ({}), search: async () => ({}) } };
  const { handler } = createMcpTools({ services });
  const body = parse(await handler('kb', { method: 'list' }));
  const pageUpdate = body.methods.find((m) => m.name === 'pageUpdate');
  assert.ok(pageUpdate.note && /pageContentWrite/.test(pageUpdate.note));
});

test('dispatch tool description inlines high-frequency method signatures', () => {
  const { defs } = createMcpTools({ services: fakeServices() });
  const tm = defs.find((d) => d.name === 'tm');
  // `*` marks required, `?` marks optional — the agent can read the shape without a call.
  assert.match(tm.description, /issueCreate\(projectId\*, title\*, leadAgentId\*, ownerMemberId\*/);
});

test('dispatch: valid method calls the service with params', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const res = await handler('tm', { method: 'issueCreate', params: { title: 'Bug' } });
  assert.deepEqual(parse(res), { id: 'issue1', title: 'Bug' });
});

test('dispatch: unknown / private method => isError', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const bad = await handler('tm', { method: 'nope' });
  assert.equal(bad.isError, true);
  const priv = await handler('tm', { method: '_secret' });
  assert.equal(priv.isError, true);
});

test('comm_send uses bridge.send(endpoint, content, {orgId, replyTo})', async () => {
  const calls = [];
  const bridge = { send: async (endpoint, content, opts) => { calls.push({ endpoint, content, opts }); return { messageId: 'm9' }; } };
  const { handler } = createMcpTools({ services: fakeServices(), bridge, defaultOrgId: 'org1' });
  const res = await handler('comm_send', { endpoint: 'conv1', content: 'done', replyTo: 'msg1' });
  assert.deepEqual(parse(res), { messageId: 'm9' });
  assert.deepEqual(calls[0], { endpoint: 'conv1', content: 'done', opts: { orgId: 'org1', replyTo: 'msg1' } });
});

test('comm_send without a bridge is a clean error, not a silent no-op', async () => {
  const { handler } = createMcpTools({ services: fakeServices(), bridge: null });
  const res = await handler('comm_send', { endpoint: 'c', content: 'x' });
  assert.equal(res.isError, true);
});

test('unknown tool name => isError', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const res = await handler('bogus', {});
  assert.equal(res.isError, true);
});
