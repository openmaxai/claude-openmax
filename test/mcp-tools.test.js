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

test('comm_send clears the receive-reaction for the endpoint conversation', async () => {
  const cleared = [];
  const reactions = { clearForConversation: (convId, reason) => cleared.push({ convId, reason }) };
  const bridge = { send: async () => ({ ok: true, messageId: 'reply1' }) };
  const { handler } = createMcpTools({ services: fakeServices(), bridge, reactions, defaultOrgId: 'org1' });

  // endpoint carries reply/thread suffixes → only the conversationId prefix is used
  const res = await handler('comm_send', { endpoint: 'conv1|reply:msg9', content: 'hi' });
  assert.equal(parse(res).ok, true);
  assert.deepEqual(cleared, [{ convId: 'conv1', reason: 'reply' }]);
});

test('comm_send works without a reactions manager wired', async () => {
  const bridge = { send: async () => ({ ok: true }) };
  const { handler } = createMcpTools({ services: fakeServices(), bridge, defaultOrgId: 'org1' });
  const res = await handler('comm_send', { endpoint: 'conv1', content: 'hi' });
  assert.equal(parse(res).ok, true);
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

test('dispatch: {method:"list"} returns a per-method PURPOSE summary', async () => {
  const { handler } = createMcpTools({ services: fakeServices() });
  const body = parse(await handler('tm', { method: 'list' }));
  const issueCreate = body.methods.find((m) => m.name === 'issueCreate');
  // The summary is the "what it does / when to use" line, distinct from params.
  assert.ok(typeof issueCreate.summary === 'string' && issueCreate.summary.length > 0);
  // It names the non-obvious semantics (owner = the acceptor).
  assert.match(issueCreate.summary, /owner/i);
});

test('dispatch: {method:"list"} summaries disambiguate near-synonyms', async () => {
  const services = {
    kb: { pageUpdate: async () => ({}), pageContentWrite: async () => ({}) },
    tm: { taskClaim: async () => ({}), taskStart: async () => ({}) },
  };
  const { handler } = createMcpTools({ services });
  const kb = parse(await handler('kb', { method: 'list' })).methods;
  const pageUpdate = kb.find((m) => m.name === 'pageUpdate');
  const pageContentWrite = kb.find((m) => m.name === 'pageContentWrite');
  // pageUpdate = metadata only; pageContentWrite = the body.
  assert.match(pageUpdate.summary, /metadata|title\/path/i);
  assert.match(pageContentWrite.summary, /body/i);
  const tm = parse(await handler('tm', { method: 'list' })).methods;
  // claim = ownership only; start = begin work.
  assert.match(tm.find((m) => m.name === 'taskClaim').summary, /claim|ownership/i);
  assert.match(tm.find((m) => m.name === 'taskStart').summary, /begin|running|execut/i);
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

test('static description tags each highlight signature with a purpose gloss', () => {
  const { defs } = createMcpTools({ services: fakeServices() });
  const tm = defs.find((d) => d.name === 'tm');
  // The `— <few words>` gloss names the verb's purpose without a `list` call.
  assert.match(tm.description, /issueCreate\([^)]*\) — create issue w\/ owner=acceptor/);
  assert.match(tm.description, /attemptTransition\([^)]*\) — generic state-machine transition/);
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

// --- as-service positional dispatch -----------------------------------------
// The `as` SDK methods take POSITIONAL args (localPath, opts) / (idOrUri, opts)
// / (uris, opts) / (url, filename). The agent still passes a FLAT params object;
// the adapter must map it onto the positional call, NOT pass a single object.
function recordingAsServices() {
  const calls = {};
  const record = (name) => async (...args) => { calls[name] = args; return { ok: name }; };
  return {
    services: {
      as: {
        uploadMedia: record('uploadMedia'),
        getMediaUrl: record('getMediaUrl'),
        resolveUris: record('resolveUris'),
        downloadMedia: record('downloadMedia'),
      },
      tm: { issueCreate: async (...args) => { calls.issueCreate = args; return { id: 'i1' }; } },
    },
    calls,
  };
}

test('as.getMediaUrl maps flat params to (idOrUri, opts) positionally', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  await handler('as', { method: 'getMediaUrl', params: { idOrUri: 'abc', inline: true } });
  // arg0 is the bare string, arg1 is the leftover opts — NOT a single object.
  assert.deepEqual(calls.getMediaUrl, ['abc', { inline: true }]);
});

test('as.uploadMedia maps to (localPath, optsWithoutLocalPath)', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  await handler('as', {
    method: 'uploadMedia',
    params: { localPath: '/tmp/a.png', filename: 'a.png', conversationId: 'c1', mediaType: 'image' },
  });
  assert.deepEqual(calls.uploadMedia, [
    '/tmp/a.png',
    { filename: 'a.png', conversationId: 'c1', mediaType: 'image' },
  ]);
  // localPath must NOT leak into the opts object.
  assert.equal('localPath' in calls.uploadMedia[1], false);
});

test('as.resolveUris maps to (arrayOfUris, {inline})', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  const uris = ['artifact://x', 'artifact://y'];
  await handler('as', { method: 'resolveUris', params: { uris, inline: true } });
  assert.deepEqual(calls.resolveUris, [uris, { inline: true }]);
  assert.ok(Array.isArray(calls.resolveUris[0]));
});

test('as.downloadMedia maps to (url, filename) with NO trailing opts arg', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  await handler('as', { method: 'downloadMedia', params: { urlOrIdOrUri: 'artifact://z', filename: 'out.bin' } });
  assert.deepEqual(calls.downloadMedia, ['artifact://z', 'out.bin']);
  // Exactly two args — the SDK signature has no third options object.
  assert.equal(calls.downloadMedia.length, 2);
});

test('as positional mapping passes undefined through when a required arg is missing', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  // No params at all: the SDK method should receive (undefined, {}) and surface
  // its own "required" error — the adapter does not pre-empt it.
  await handler('as', { method: 'getMediaUrl' });
  assert.deepEqual(calls.getMediaUrl, [undefined, {}]);
});

test('regression: non-as service still receives a single params object', async () => {
  const { services, calls } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  await handler('tm', { method: 'issueCreate', params: { title: 'Bug', projectId: 'p1' } });
  // tm is NOT positional: exactly one arg, the whole params object.
  assert.equal(calls.issueCreate.length, 1);
  assert.deepEqual(calls.issueCreate[0], { title: 'Bug', projectId: 'p1' });
});

test('as {method:"list"} exposes flat-param schemas + positional-mapping notes', async () => {
  const { services } = recordingAsServices();
  const { handler } = createMcpTools({ services });
  const methods = parse(await handler('as', { method: 'list' })).methods;
  const byName = Object.fromEntries(methods.map((m) => [m.name, m]));
  // Each as method has a purpose summary and a flat param list.
  assert.match(byName.getMediaUrl.summary, /presigned|resolve/i);
  const gm = Object.fromEntries(byName.getMediaUrl.params.map((p) => [p.name, p]));
  assert.equal(gm.idOrUri.required, true);
  assert.equal(gm.inline.required, false);
  const um = Object.fromEntries(byName.uploadMedia.params.map((p) => [p.name, p]));
  assert.equal(um.localPath.required, true);
  // The note documents the adapter's positional mapping.
  assert.match(byName.downloadMedia.note, /downloadMedia\(urlOrIdOrUri, filename\)|no trailing/i);
});
