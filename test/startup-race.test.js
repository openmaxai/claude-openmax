import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForApiKey, hasUsableApiKey, buildRuntime, normalizeConfig } from '../src/config.js';

const withKey = (k) => ({ agent: { api_key: k } });

test('hasUsableApiKey: blank and the example placeholder are not usable', () => {
  assert.equal(hasUsableApiKey(withKey('')), false);
  assert.equal(hasUsableApiKey(withKey('cwsk_replace_me')), false);
  assert.equal(hasUsableApiKey(withKey('cwsk_real')), true);
});

test('waitForApiKey returns immediately when the key is already there', async () => {
  let loads = 0;
  const cfg = withKey('cwsk_real');
  assert.equal(await waitForApiKey({ initial: cfg, load: () => { loads++; return { config: cfg }; } }), cfg);
  assert.equal(loads, 0);
});

test('waitForApiKey picks up a key written after startup (SessionStart registration race)', async () => {
  let n = 0;
  const got = await waitForApiKey({
    initial: withKey(''),
    load: () => ({ config: withKey(++n >= 3 ? 'cwsk_late' : '') }),
    intervalMs: 1,
    timeoutMs: 1000,
  });
  assert.equal(got.agent.api_key, 'cwsk_late');
  assert.equal(n, 3);
});

test('waitForApiKey gives up after the timeout and stops when cancelled', async () => {
  assert.equal(await waitForApiKey({ initial: withKey(''), load: () => ({ config: withKey('') }), intervalMs: 5, timeoutMs: 20 }), null);
  let cancel = false;
  const p = waitForApiKey({ initial: withKey(''), load: () => ({ config: withKey('') }), intervalMs: 5, timeoutMs: 60000, cancelled: () => cancel });
  cancel = true;
  assert.equal(await p, null);
});

test('waitForApiKey tolerates a transiently unreadable config', async () => {
  let n = 0;
  const got = await waitForApiKey({
    initial: withKey(''),
    load: () => { if (++n === 1) throw new Error('partial write'); return { config: withKey('cwsk_ok') }; },
    intervalMs: 1,
    timeoutMs: 1000,
  });
  assert.equal(got.agent.api_key, 'cwsk_ok');
});

test('buildRuntime routes SDK token requests through the injected (guarded) fetch', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: new Map(), async text() { return JSON.stringify({ data: { access_token: 'eyJ.x.y', expires_in: 3600 } }); } };
  };
  const config = normalizeConfig({ server: { bff_url: 'https://core.test' }, agent: { api_key: 'cwsk_k' }, orgs: {} });
  const storage = { async get() { return null; }, async set() {} };
  const rt = buildRuntime({ config, file: '/dev/null', storage, logger: { info() {}, warn() {}, error() {}, log() {}, debug() {} }, fetchImpl });
  await rt.tokenManager.exchange('').catch(() => {});
  assert.ok(urls.some((u) => u.endsWith('/auth/agent/token')), `token exchange should use the injected fetch; saw ${urls.join(', ')}`);
});

test('buildRuntime routes CwsHttpClient (REST/tool) requests through the injected fetch too', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const body = String(url).endsWith('/auth/agent/token')
      ? { data: { access_token: 'eyJ.x.y', expires_in: 3600 } }
      : { data: { id: 'me' } };
    return { ok: true, status: 200, headers: new Map(), async text() { return JSON.stringify(body); } };
  };
  const config = normalizeConfig({ server: { bff_url: 'https://core.test' }, agent: { api_key: 'cwsk_k' }, orgs: {} });
  const storage = { async get() { return null; }, async set() {} };
  const rt = buildRuntime({ config, file: '/dev/null', storage, logger: { info() {}, warn() {}, error() {}, log() {}, debug() {} }, fetchImpl });
  await rt.http.get(rt.http.apiPath('/me')).catch(() => {});
  assert.ok(urls.some((u) => /\/me$/.test(u) && !u.includes('/auth/')), `REST call should use the injected fetch; saw ${urls.join(', ')}`);
});
