import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  apiKeyFingerprint,
  identityIdFromMe,
  guardStaleTokenCache,
  writeApiKeyMarkers,
  purgeOrgTokenCache,
} from '../src/token-guard.js';
import { createFileStorage } from '../src/storage.js';
import { normalizeConfig, buildRuntime } from '../src/config.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const silent = { info() {}, warn() {}, error() {}, debug() {} };

// In-memory StorageProvider with the extra `remove` seam the guard uses.
function memStorage(initial = {}) {
  const files = { ...initial };
  return {
    files,
    get: async (k) => (k in files ? files[k] : null),
    set: async (k, v) => { files[k] = String(v); },
    remove: async (k) => { const had = k in files; delete files[k]; return had; },
  };
}

const tokKey = (id) => `tokens/${id}.json`;
const sessKey = (id) => `sessions/${id}.json`;
const inbKey = (id) => `inbox-${id}.json`;
const fpKey = (id) => `apikey-fp/${id}.json`;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-guard-'));
  return path.join(dir, 'config.json');
}

function newShape(over = {}) {
  return {
    enabled: true,
    server: { bff_url: 'https://core.example.com', ws_url: 'wss://comm.example.com/cws-comm', frontend_base_path: '/workspace' },
    agent: { identity_id: '', api_key: 'cwsk_key', device_id: 'dev1', app_version: 'claude-openmax/9.9' },
    orgs: {
      'org-uuid-1': {
        enabled: true, org_id: 'org-uuid-1', org_name: 'Acme Corp',
        owner: { member_id: '', name: '' }, self: { member_id: '', name: 'Claude', display_name: '' }, access: {},
      },
    },
    ...over,
  };
}

// ── fingerprint ────────────────────────────────────────────────────────────────
test('apiKeyFingerprint: 8-char hex, deterministic, differs per key, empty for falsy', () => {
  const a = apiKeyFingerprint('cwsk_ABC');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, apiKeyFingerprint('cwsk_ABC'));       // deterministic
  assert.notEqual(a, apiKeyFingerprint('cwsk_XYZ'));    // key-sensitive
  assert.equal(apiKeyFingerprint(''), '');
  assert.equal(apiKeyFingerprint(undefined), '');
  // never leaks the key material
  assert.equal(a.includes('cwsk'), false);
});

test('identityIdFromMe: reads identity_id (with identity.id fallback)', () => {
  assert.equal(identityIdFromMe({ identity_id: 'abc' }), 'abc');
  assert.equal(identityIdFromMe({ identity: { id: 'nested' } }), 'nested');
  assert.equal(identityIdFromMe({}), '');
  assert.equal(identityIdFromMe(null), '');
});

// ── (a) same api_key → cache kept ───────────────────────────────────────────────
test('guard: same api_key (marker matches) keeps the cache', async () => {
  const org = 'org-1';
  const fp = apiKeyFingerprint('cwsk_SAME');
  const storage = memStorage({
    [fpKey(org)]: JSON.stringify({ fp }),
    [tokKey(org)]: '{"jwt":"good"}',
    [sessKey(org)]: '{"cursor":5}',
    [inbKey(org)]: '{"acked_seq":9}',
  });
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_SAME', logger: silent });
  assert.deepEqual(purged, []);
  assert.equal(storage.files[tokKey(org)], '{"jwt":"good"}');
  assert.equal(storage.files[sessKey(org)], '{"cursor":5}');
  assert.equal(storage.files[inbKey(org)], '{"acked_seq":9}');
});

// ── (b) changed api_key → three files purged before connect ─────────────────────
test('guard: changed api_key purges token + session + inbox', async () => {
  const org = 'org-1';
  const storage = memStorage({
    [fpKey(org)]: JSON.stringify({ fp: apiKeyFingerprint('cwsk_OLD') }),
    [tokKey(org)]: '{"jwt":"stale"}',
    [sessKey(org)]: '{"cursor":5}',
    [inbKey(org)]: '{"acked_seq":9}',
    // an unrelated org must be untouched
    [tokKey('other')]: '{"jwt":"other"}',
  });
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_NEW', logger: silent });
  assert.ok(purged.includes(org));
  assert.equal(storage.files[tokKey(org)], undefined);
  assert.equal(storage.files[sessKey(org)], undefined);
  assert.equal(storage.files[inbKey(org)], undefined);
  assert.equal(storage.files[tokKey('other')], '{"jwt":"other"}'); // untouched
});

// ── first-run vs legacy no-marker semantics ─────────────────────────────────────
test('guard: no marker + no token = genuine first run → keep (nothing purged)', async () => {
  const org = 'org-1';
  const storage = memStorage({});
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_NEW', logger: silent });
  assert.deepEqual(purged, []);
  assert.deepEqual(storage.files, {});
});

test('guard: no marker + a token exists (legacy) → purge to be safe', async () => {
  const org = 'org-1';
  const storage = memStorage({
    [tokKey(org)]: '{"jwt":"unverifiable"}',
    [sessKey(org)]: '{"cursor":1}',
    [inbKey(org)]: '{"acked_seq":2}',
  });
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_ANY', logger: silent });
  assert.ok(purged.includes(org));
  assert.equal(storage.files[tokKey(org)], undefined);
  assert.equal(storage.files[sessKey(org)], undefined);
  assert.equal(storage.files[inbKey(org)], undefined);
});

// ── identity-only slot is always guarded ────────────────────────────────────────
test('guard: identity-only slot (_identity) is purged on api_key change', async () => {
  const storage = memStorage({
    [fpKey('_identity')]: JSON.stringify({ fp: apiKeyFingerprint('cwsk_OLD') }),
    [tokKey('_identity')]: '{"jwt":"identity-stale"}',
  });
  const purged = await guardStaleTokenCache({ storage, orgIds: [], apiKey: 'cwsk_NEW', logger: silent });
  assert.ok(purged.includes('_identity'));
  assert.equal(storage.files[tokKey('_identity')], undefined);
});

// ── never throws + degrades to purge-to-be-safe ─────────────────────────────────
test('guard: a get() that throws degrades to purge-to-be-safe (never throws)', async () => {
  const org = 'org-1';
  const removed = new Set();
  const storage = {
    get: async () => { throw new Error('disk boom'); },
    set: async () => {},
    remove: async (k) => { removed.add(k); return true; },
  };
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'k', logger: silent });
  assert.ok(purged.includes(org));
  assert.ok(removed.has(tokKey(org)) && removed.has(sessKey(org)) && removed.has(inbKey(org)));
});

test('purgeOrgTokenCache: degrades to set("") when storage has no remove()', async () => {
  const org = 'org-1';
  const storage = {
    files: { [tokKey(org)]: '{"jwt":"x"}' },
    get: async function (k) { return k in this.files ? this.files[k] : null; },
    set: async function (k, v) { this.files[k] = String(v); },
    // no remove
  };
  const removed = await purgeOrgTokenCache({ storage, orgId: org, logger: silent });
  assert.ok(removed.includes(tokKey(org)));
  assert.equal(storage.files[tokKey(org)], '');           // blanked → next read is falsy/absent
});

// ── writeApiKeyMarkers ──────────────────────────────────────────────────────────
test('writeApiKeyMarkers: persists fp per org + the identity slot', async () => {
  const storage = memStorage({});
  await writeApiKeyMarkers({ storage, orgIds: ['org-1', 'org-2'], apiKey: 'cwsk_K', logger: silent });
  const fp = apiKeyFingerprint('cwsk_K');
  assert.equal(JSON.parse(storage.files[fpKey('org-1')]).fp, fp);
  assert.equal(JSON.parse(storage.files[fpKey('org-2')]).fp, fp);
  assert.equal(JSON.parse(storage.files[fpKey('_identity')]).fp, fp);
});

test('round-trip: write markers then guard with the SAME key keeps the cache', async () => {
  const org = 'org-1';
  const storage = memStorage({ [tokKey(org)]: '{"jwt":"good"}' });
  await writeApiKeyMarkers({ storage, orgIds: [org], apiKey: 'cwsk_K', logger: silent });
  const purged = await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_K', logger: silent });
  assert.deepEqual(purged, []);
  assert.equal(storage.files[tokKey(org)], '{"jwt":"good"}');
});

// ── real file storage: key→file mapping + remove ────────────────────────────────
test('createFileStorage.remove deletes the mapped file (and reports existence)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-store-'));
  const storage = createFileStorage({ dataDir: dir });
  await storage.set(tokKey('org-1'), '{"jwt":"x"}');
  assert.equal(fs.existsSync(path.join(dir, 'tokens', 'org-1.json')), true);
  assert.equal(await storage.remove(tokKey('org-1')), true);
  assert.equal(fs.existsSync(path.join(dir, 'tokens', 'org-1.json')), false);
  assert.equal(await storage.remove(tokKey('org-1')), false);   // already gone
});

test('guard against real file storage purges the mapped token/session/inbox files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-store-'));
  const storage = createFileStorage({ dataDir: dir });
  const org = 'org-1';
  await storage.set(fpKey(org), JSON.stringify({ fp: apiKeyFingerprint('cwsk_OLD') }));
  await storage.set(tokKey(org), '{"jwt":"stale"}');
  await storage.set(sessKey(org), '{"cursor":1}');
  await storage.set(inbKey(org), '{"acked_seq":2}');
  await guardStaleTokenCache({ storage, orgIds: [org], apiKey: 'cwsk_NEW', logger: silent });
  assert.equal(await storage.get(tokKey(org)), null);
  assert.equal(await storage.get(sessKey(org)), null);
  assert.equal(await storage.get(inbKey(org)), null);
});

// ── (c) /me identity ≠ config.identity_id → warning + purge (via syncSelf) ───────
test('syncSelf: /me identity_id ≠ configured identity_id → LOUD warning + purge', async () => {
  const file = tmpFile();
  const raw = newShape();
  raw.agent.identity_id = 'wanted-id';                    // a specific identity is configured
  const config = normalizeConfig(raw, { logger: silent });
  const storage = memStorage({
    [tokKey('org-uuid-1')]: '{"jwt":"stale"}',
    [sessKey('org-uuid-1')]: '{"cursor":3}',
    [inbKey('org-uuid-1')]: '{"acked_seq":4}',
  });
  const errors = [];
  const logger = { ...silent, error: (m) => errors.push(m) };
  const fakeHttp = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async () => ({ identity_id: 'WRONG-id', display_name: 'Claude (Acme)' }),
  };
  const rt = buildRuntime({ config, file, storage, logger, httpClient: fakeHttp });
  const res = await rt.callbacks.syncSelf(rt.orgConfigs[0]);
  // loud warning emitted
  assert.equal(errors.length, 1);
  assert.match(errors[0], /IDENTITY MISMATCH/);
  assert.match(errors[0], /wanted-id/);
  assert.match(errors[0], /WRONG-id/);
  // cache purged so the next bootstrap re-exchanges
  assert.equal(storage.files[tokKey('org-uuid-1')], undefined);
  assert.equal(storage.files[sessKey('org-uuid-1')], undefined);
  assert.equal(storage.files[inbKey('org-uuid-1')], undefined);
  // display_name hydration still proceeds
  assert.equal(res.nameReady, true);
  assert.equal(res.displayName, 'Claude (Acme)');
});

test('syncSelf: matching /me identity_id → no warning, cache kept', async () => {
  const file = tmpFile();
  const raw = newShape();
  raw.agent.identity_id = 'agent-1';
  const config = normalizeConfig(raw, { logger: silent });
  const storage = memStorage({ [tokKey('org-uuid-1')]: '{"jwt":"good"}' });
  const errors = [];
  const logger = { ...silent, error: (m) => errors.push(m) };
  const fakeHttp = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async () => ({ identity_id: 'agent-1', display_name: 'Claude' }),
  };
  const rt = buildRuntime({ config, file, storage, logger, httpClient: fakeHttp });
  await rt.callbacks.syncSelf(rt.orgConfigs[0]);
  assert.deepEqual(errors, []);
  assert.equal(storage.files[tokKey('org-uuid-1')], '{"jwt":"good"}');   // untouched
});

test('syncSelf: no configured identity_id → mismatch guard is inert', async () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silent });   // identity_id empty
  const storage = memStorage({ [tokKey('org-uuid-1')]: '{"jwt":"good"}' });
  const errors = [];
  const logger = { ...silent, error: (m) => errors.push(m) };
  const fakeHttp = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async () => ({ identity_id: 'whatever', display_name: 'Claude' }),
  };
  const rt = buildRuntime({ config, file, storage, logger, httpClient: fakeHttp });
  await rt.callbacks.syncSelf(rt.orgConfigs[0]);
  assert.deepEqual(errors, []);
  assert.equal(storage.files[tokKey('org-uuid-1')], '{"jwt":"good"}');
});
