import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRegistered, resolveConfigPath } from '../hooks/auto-register.js';

function seedConfig(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-reg-'));
  const cfgPath = path.join(dir, 'config.json');
  const cfg = {
    server: { bff_url: 'https://core.test' },
    agent: { api_key: '', identity_id: '', device_id: 'd1' },
    cf_access: { client_id: 'cf-id', client_secret: 'cf-secret' },
    ...overrides,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 }); // 644 on purpose
  return cfgPath;
}

/** Swap globalThis.fetch for the duration of `fn`, capturing the calls made. */
async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } });

async function runWith(cfgPath, fn) {
  const prev = process.env.CLAUDE_OPENMAX_CONFIG;
  process.env.CLAUDE_OPENMAX_CONFIG = cfgPath;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_OPENMAX_CONFIG; else process.env.CLAUDE_OPENMAX_CONFIG = prev;
  }
}

test('resolveConfigPath honors CLAUDE_OPENMAX_CONFIG', () => {
  const prev = process.env.CLAUDE_OPENMAX_CONFIG;
  process.env.CLAUDE_OPENMAX_CONFIG = '/tmp/x/config.json';
  assert.equal(resolveConfigPath(), '/tmp/x/config.json');
  if (prev === undefined) delete process.env.CLAUDE_OPENMAX_CONFIG; else process.env.CLAUDE_OPENMAX_CONFIG = prev;
});

test('registers when api_key is blank, persists creds, and forces 0600', async () => {
  const cfgPath = seedConfig();
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent')
      ? jsonRes(200, { identity_id: 'id-123', api_key: 'cwsk_real' })
      : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.agent.identity_id, 'id-123');
  assert.equal(cfg.agent.api_key, 'cwsk_real');
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'secret-bearing config must be 0600');
});

test('is idempotent — a real api_key present means no register call', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_already', identity_id: 'id-0' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    () => { throw new Error('fetch must not be called when already registered'); },
    (calls) => ensureRegistered().then((w) => { assert.equal(calls.length, 0); return w; }),
  ));
  assert.equal(wrote, false);
});

test('skips (no write) when CF-Access credentials are missing', async () => {
  const cfgPath = seedConfig({ cf_access: {} });
  const before = readFileSync(cfgPath, 'utf8');
  const wrote = await runWith(cfgPath, () => withFetch(
    () => { throw new Error('fetch must not be called without cf_access'); },
    () => ensureRegistered(),
  ));
  assert.equal(wrote, false);
  assert.equal(readFileSync(cfgPath, 'utf8'), before);
});

test('placeholder api_key (cwsk_replace_me) is treated as unregistered', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_replace_me' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent') ? jsonRes(200, { identity_id: 'id-9', api_key: 'cwsk_new' }) : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).agent.api_key, 'cwsk_new');
});

test('when an invite block is present, also accepts the invitation and clears it', async () => {
  const cfgPath = seedConfig({ invite: { invitation_id: 'inv-1', token: 'tok-abc' } });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/register/agent')) return jsonRes(200, { identity_id: 'id-1', api_key: 'cwsk_k' });
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'access-xyz' });
    if (url.includes('/invitations/inv-1/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then(() => {
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes('/invitations/inv-1/accept')), 'should accept the invitation');
  })));
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.invite, undefined, 'one-time invite block should be cleared after accept');
  assert.equal(existsSync(cfgPath), true);
});

test('legacy-shape config: writes the key where the runtime reads it (auth.apiKey)', async () => {
  // Legacy marker: top-level `auth`. Runtime translateLegacy() reads api_key from auth.apiKey.
  const cfgPath = seedConfig({ auth: {}, agent: { identity_id: '', api_key: '' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent') ? jsonRes(200, { identity_id: 'id-L', api_key: 'cwsk_legacy' }) : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.auth.apiKey, 'cwsk_legacy', 'legacy runtime reads auth.apiKey');
  assert.equal(cfg.agent.api_key, 'cwsk_legacy');
});

test('legacy-shape config already keyed in auth.apiKey is idempotent (no re-register)', async () => {
  const cfgPath = seedConfig({ auth: { apiKey: 'cwsk_existing' }, agent: { api_key: '' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    () => { throw new Error('fetch must not be called — already registered via auth.apiKey'); },
    (calls) => ensureRegistered().then((w) => { assert.equal(calls.length, 0); return w; }),
  ));
  assert.equal(wrote, false);
});

test('accepts an invitation even when api_key already exists (retry across sessions)', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have', identity_id: 'id-x' }, invite: { invitation_id: 'inv-9', token: 'tok-9' } });
  const wrote = await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/register/agent')) throw new Error('must NOT register when key exists');
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc-9' });
    if (url.includes('/invitations/inv-9/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then((w) => {
    assert.ok(calls.some((c) => c.url.includes('/invitations/inv-9/accept')), 'should accept the invitation');
    assert.ok(!calls.some((c) => c.url.endsWith('/auth/register/agent')), 'should not re-register');
    return w;
  })));
  assert.equal(wrote, false, 'no new registration credentials were written');
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).invite, undefined, 'invite cleared after accept');
});

test('invite is NOT cleared when acceptance fails (so it retries next session)', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' }, invite: { invitation_id: 'inv-f', token: 'tok-f' } });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc' });
    if (url.includes('/invitations/inv-f/accept')) return jsonRes(500, { error: 'boom' });
    return jsonRes(404, {});
  }, () => ensureRegistered()));
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).invite, { invitation_id: 'inv-f', token: 'tok-f' }, 'invite retained on failure');
});
