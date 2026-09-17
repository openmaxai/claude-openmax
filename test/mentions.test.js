import test from 'node:test';
import assert from 'node:assert/strict';
import { createMentions } from '../src/mentions.js';

// In-memory StorageProvider (string get/set), matching the SDK contract.
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, v); },
    _dump: () => Object.fromEntries(map),
  };
}

const CONV = 'conv-1';

async function withParticipants(list) {
  const storage = memStorage();
  const m = createMentions({ storage });
  for (const p of list) await m.record({ conversationId: CONV, ...p });
  return { m, storage };
}

// An inexact name is a silent no-op in cws-fe's highlighting and in the SDK's
// isSelfNameMentionedInText gate, so the canonical display_name must win
// regardless of how the author typed it.
test('canonicalizes @name to the exact recorded display_name (case-insensitive)', async () => {
  const { m } = await withParticipants([{ displayName: 'zylos0t', memberId: 'm-1' }]);
  const out = await m.decorate('@ZYLOS0T cws-billing !406 ready', CONV);
  assert.equal(out.text, '@zylos0t cws-billing !406 ready');
});

// The shape cws-core's mention index accepts. `{member_id, display_name}` — the
// shape the response uses — is NOT accepted on the request side.
test('emits structured mentions as {type:"member", member_id}', async () => {
  const { m } = await withParticipants([{ displayName: 'nova-noah', memberId: 'm-2' }]);
  const out = await m.decorate('@nova-noah please review', CONV);
  assert.deepEqual(out.mentions, [{ type: 'member', member_id: 'm-2' }]);
});

test('returns the text unchanged and no mentions when nothing matched', async () => {
  const { m } = await withParticipants([{ displayName: 'zylos0t', memberId: 'm-1' }]);
  assert.deepEqual(await m.decorate('no mention here', CONV), { text: 'no mention here', mentions: [] });
  assert.deepEqual(await m.decorate('@stranger hi', CONV), { text: '@stranger hi', mentions: [] });
});

test('leaves unknown @handles untouched while rewriting known ones', async () => {
  const { m } = await withParticipants([{ displayName: 'zylos0t', memberId: 'm-1' }]);
  const out = await m.decorate('@ZYLOS0T and @nobody', CONV);
  assert.equal(out.text, '@zylos0t and @nobody');
  assert.equal(out.mentions.length, 1);
});

// Longest-first, mirroring the SDK: a shorter name that prefixes a longer one
// must not win, or "@Alice Wong" resolves to Alice's id.
test('prefers the longest matching display name', async () => {
  const { m } = await withParticipants([
    { displayName: 'Alice', memberId: 'm-short' },
    { displayName: 'Alice Wong', memberId: 'm-long' },
  ]);
  const out = await m.decorate('@Alice Wong ping', CONV);
  assert.deepEqual(out.mentions, [{ type: 'member', member_id: 'm-long' }]);
});

// One member, mentioned twice: the blanking pass must consume both spans and
// still emit exactly one mention entry.
test('a name mentioned more than once yields a single mention', async () => {
  const { m } = await withParticipants([{ displayName: 'zylos0t', memberId: 'm-1' }]);
  const out = await m.decorate('@ZYLOS0T ping and @zylos0t again', CONV);
  assert.equal(out.text, '@zylos0t ping and @zylos0t again');
  assert.deepEqual(out.mentions, [{ type: 'member', member_id: 'm-1' }]);
});

// A display_name is arbitrary user input; regex metacharacters in it must be
// matched literally rather than compiled into a pattern.
test('a display name containing regex metacharacters matches literally', async () => {
  const { m } = await withParticipants([
    { displayName: 'a.b(c)+', memberId: 'm-meta' },
    { displayName: 'axbXcY', memberId: 'm-wrong' },
  ]);
  const out = await m.decorate('@a.b(c)+ ping', CONV);
  assert.deepEqual(out.mentions, [{ type: 'member', member_id: 'm-meta' }]);
});

test('a participant with a name but no member id still canonicalizes the text', async () => {
  const { m } = await withParticipants([{ displayName: 'zylos0t' }]);
  const out = await m.decorate('@ZYLOS0T hi', CONV);
  assert.equal(out.text, '@zylos0t hi');
  assert.deepEqual(out.mentions, []);
});

// Passive learning: the SDK leaves senderDisplayName empty when it could not
// resolve a name, and that must be a no-op rather than a poisoned entry.
test('record ignores empty display names and unknown conversations', async () => {
  const { m, storage } = await withParticipants([
    { displayName: '', memberId: 'm-x' },
    { displayName: '   ', memberId: 'm-y' },
  ]);
  assert.equal(storage._dump()['mention-registry.json'], undefined);
  assert.deepEqual(await m.decorate('@anyone hi', 'never-seen-conv'), { text: '@anyone hi', mentions: [] });
});

test('scopes participants per conversation', async () => {
  const storage = memStorage();
  const m = createMentions({ storage });
  await m.record({ conversationId: 'conv-a', displayName: 'zylos0t', memberId: 'm-1' });
  assert.deepEqual(await m.decorate('@ZYLOS0T hi', 'conv-b'), { text: '@ZYLOS0T hi', mentions: [] });
});

test('state survives a restart (write-through to storage)', async () => {
  const storage = memStorage();
  await createMentions({ storage }).record({ conversationId: CONV, displayName: 'zylos0t', memberId: 'm-1' });
  const revived = createMentions({ storage }); // fresh instance, same storage
  const out = await revived.decorate('@ZYLOS0T hi', CONV);
  assert.deepEqual(out.mentions, [{ type: 'member', member_id: 'm-1' }]);
});

// A corrupt state file must degrade to "no canonicalization", never throw into
// the send path.
test('corrupt registry state degrades instead of throwing', async () => {
  const storage = memStorage({ 'mention-registry.json': '{not json', 'mention-members.json': '{nope' });
  const m = createMentions({ storage });
  assert.deepEqual(await m.decorate('@zylos0t hi', CONV), { text: '@zylos0t hi', mentions: [] });
});

test('storage is required', () => {
  assert.throws(() => createMentions({}), /requires a storage provider/);
});
