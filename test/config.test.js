import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeConfig,
  buildRuntime,
  resolveAndCacheIdentityId,
} from '../src/config.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-cfg-'));
  return path.join(dir, 'config.json');
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const storageStub = { get: async () => null, set: async () => {} };
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function newShape(over = {}) {
  return {
    enabled: true,
    server: {
      bff_url: 'https://core.example.com',
      ws_url: 'wss://comm.example.com/cws-comm',
      frontend_base_path: '/workspace',
    },
    agent: { identity_id: '', api_key: 'cwsk_key', device_id: 'dev1', app_version: 'claude-openmax/9.9' },
    cf_access: { client_id: 'cid', client_secret: 'sec' },
    orgs: {
      'org-uuid-1': {
        enabled: true,
        org_id: 'org-uuid-1',
        org_name: 'Acme Corp',
        owner: { member_id: '', name: '' },
        self: { member_id: '', name: 'Claude', display_name: '' },
        access: { dmPolicy: 'owner', dmAllowFrom: [], groupPolicy: 'allowlist', groups: {} },
      },
    },
    wake: { endpoint: 'http://127.0.0.1:47600/wake' },
    metricsReport: { dashboardApiKey: '' },
    ws: { reconnectMaxMs: 12345 },
    ...over,
  };
}

// ── new-shape parsing ──────────────────────────────────────────────────────────
test('normalizeConfig: parses new openmax-mirrored shape', () => {
  const c = normalizeConfig(newShape(), { logger: silentLogger });
  assert.equal(c.server.bff_url, 'https://core.example.com');
  assert.equal(c.server.ws_url, 'wss://comm.example.com/cws-comm');
  assert.equal(c.server.frontend_base_path, '/workspace');
  assert.equal(c.agent.api_key, 'cwsk_key');
  assert.equal(c.agent.device_id, 'dev1');
  assert.equal(c.agent.app_version, 'claude-openmax/9.9');
  assert.deepEqual(c.cf_access, { client_id: 'cid', client_secret: 'sec' });
  assert.equal(c.wake.endpoint, 'http://127.0.0.1:47600/wake');
  assert.equal(c.ws.reconnectMaxMs, 12345);
  // orgs normalized to an internal ARRAY, each identified by its org_id
  assert.equal(c.orgs.length, 1);
  assert.equal(c.orgs[0].org_id, 'org-uuid-1');
  assert.equal('slug' in c.orgs[0], false);   // no derived per-org key anymore
});

test('normalizeConfig: frontend_base_path defaults to /workspace when absent', () => {
  const raw = newShape();
  delete raw.server.frontend_base_path;
  const c = normalizeConfig(raw, { logger: silentLogger });
  assert.equal(c.server.frontend_base_path, '/workspace');
});

test('normalizeConfig: a stray on-disk `slug` is ignored (org_id is the only key)', () => {
  const raw = newShape();
  raw.orgs['org-uuid-1'].slug = 'my-explicit';
  const c = normalizeConfig(raw, { logger: silentLogger });
  assert.equal(c.orgs[0].org_id, 'org-uuid-1');
  assert.equal('slug' in c.orgs[0], false);      // slug is not carried into the runtime record
});

// ── env overrides ──────────────────────────────────────────────────────────────
test('normalizeConfig: env fallbacks fill empty nested fields', () => {
  const prev = { ...process.env };
  process.env.COCO_API_URL = 'https://env-core';
  process.env.COCO_WS_URL = 'wss://env-comm';
  process.env.COCO_API_KEY = 'cwsk_env';
  process.env.COCO_DEVICE_ID = 'env-dev';
  process.env.COCO_CLIENT_VERSION = 'env-ver';
  process.env.COCO_FRONTEND_BASE_PATH = '/env-workspace';
  try {
    const c = normalizeConfig({ orgs: {} }, { logger: silentLogger });
    assert.equal(c.server.bff_url, 'https://env-core');
    assert.equal(c.server.ws_url, 'wss://env-comm');
    assert.equal(c.agent.api_key, 'cwsk_env');
    assert.equal(c.agent.device_id, 'env-dev');
    assert.equal(c.agent.app_version, 'env-ver');
    assert.equal(c.server.frontend_base_path, '/env-workspace');
  } finally {
    for (const k of ['COCO_API_URL', 'COCO_WS_URL', 'COCO_API_KEY', 'COCO_DEVICE_ID', 'COCO_CLIENT_VERSION', 'COCO_FRONTEND_BASE_PATH']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

// ── old-shape graceful translation ─────────────────────────────────────────────
test('normalizeConfig: OLD-shape (http/auth + array orgs) is translated', () => {
  let warned = '';
  const legacy = {
    http: { baseUrl: 'https://old-core' },
    ws: { baseUrl: 'wss://old-comm', deviceId: 'old-dev', clientVersion: 'old-ver', reconnectMaxMs: 777 },
    auth: { apiKey: 'cwsk_old' },
    cf_access: { client_id: 'oc', client_secret: 'os' },
    orgs: [
      { slug: 'team-alpha', org_id: 'old-org-1', self: { member_id: 'm-old' }, owner: { member_id: 'o', name: 'O' }, access: { dmPolicy: 'open' } },
    ],
    wake: { endpoint: 'http://127.0.0.1:1/wake' },
  };
  const c = normalizeConfig(legacy, { logger: { warn: (m) => { warned = m; } } });
  assert.match(warned, /OLD-shape/);
  assert.equal(c.server.bff_url, 'https://old-core');
  assert.equal(c.server.ws_url, 'wss://old-comm');
  assert.equal(c.agent.api_key, 'cwsk_old');
  assert.equal(c.agent.device_id, 'old-dev');
  assert.equal(c.agent.app_version, 'old-ver');
  assert.equal(c.ws.reconnectMaxMs, 777);
  assert.equal(c.orgs.length, 1);
  assert.equal(c.orgs[0].org_id, 'old-org-1');
  assert.equal('slug' in c.orgs[0], false);        // slug dropped — org_id is the identity
  assert.equal(c.orgs[0].self.member_id, 'm-old');
});

// ── org_id-keyed loadConfig (SDK keys orgs by org_id) ───────────────────────────
test('buildRuntime: loadConfig() returns an org_id-keyed org map (SDK expectation)', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  const loaded = rt.callbacks.loadConfig();
  assert.deepEqual(Object.keys(loaded.orgs), ['org-uuid-1']);
  assert.equal(loaded.orgs['org-uuid-1'].org_id, 'org-uuid-1');
  // orgConfigs handed to the SDK carry org_id (and no separate slug key)
  assert.equal(rt.orgConfigs[0].org_id, 'org-uuid-1');
  assert.equal('slug' in rt.orgConfigs[0], false);
});

// ── self-healing member_id writeback into the org_id-keyed on-disk map ──────────
test('buildRuntime: applyMemberId writes self.member_id back into the org_id-keyed disk file', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  const changed = rt.applyMemberId('org-uuid-1', 'MEMBER-123');
  assert.equal(changed, true);
  const disk = readJSON(file);
  // on-disk orgs map is keyed by org_id (openmax shape), NOT slug
  assert.deepEqual(Object.keys(disk.orgs), ['org-uuid-1']);
  assert.equal(disk.orgs['org-uuid-1'].self.member_id, 'MEMBER-123');
  assert.equal(disk.orgs['org-uuid-1'].org_id, 'org-uuid-1');
  // top-level openmax structure preserved
  assert.equal(disk.server.bff_url, 'https://core.example.com');
  assert.equal(disk.agent.api_key, 'cwsk_key');
  assert.equal(disk.wake.endpoint, 'http://127.0.0.1:47600/wake');
  assert.ok('metricsReport' in disk);            // reserved block persisted (inert)
});

// ── self-healing self.name writeback via syncSelf ───────────────────────────────
test('buildRuntime: syncSelf hydrates self.name from /me into the org_id-keyed disk file', async () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const fakeHttp = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async (_orgId, _p) => ({ display_name: 'Claude (Acme)' }),
  };
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: fakeHttp });
  const res = await rt.callbacks.syncSelf(rt.orgConfigs[0]);
  assert.equal(res.nameReady, true);
  assert.equal(res.displayName, 'Claude (Acme)');
  const disk = readJSON(file);
  assert.equal(disk.orgs['org-uuid-1'].self.name, 'Claude (Acme)');
});

// ── owner bind writeback ────────────────────────────────────────────────────────
test('buildRuntime: onOwnerBind persists owner into the org_id-keyed disk file', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  rt.callbacks.onOwnerBind('org-uuid-1', 'OWNER-9', 'Alice');
  const disk = readJSON(file);
  assert.equal(disk.orgs['org-uuid-1'].owner.member_id, 'OWNER-9');
  assert.equal(disk.orgs['org-uuid-1'].owner.name, 'Alice');
});

// ── frontendBasePath wired into CwsHttpClient ───────────────────────────────────
test('buildRuntime: frontend_base_path is wired into the real CwsHttpClient (frontendUrl)', () => {
  const file = tmpFile();
  const raw = newShape();
  raw.server.frontend_base_path = '/spaces';
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger }); // real http
  assert.equal(typeof rt.http.frontendUrl, 'function');
  assert.equal(rt.http.frontendUrl('/p/123'), 'https://core.example.com/spaces/p/123');
  // wsConfig carries ws_url + agent identity + cf_access for the WS handshake
  assert.equal(rt.wsConfig.baseUrl, 'wss://comm.example.com/cws-comm');
  assert.equal(rt.wsConfig.deviceId, 'dev1');
  assert.deepEqual(rt.wsConfig.cf_access, { client_id: 'cid', client_secret: 'sec' });
});

// ── identity_id resolve + cache ────────────────────────────────────────────────
test('resolveAndCacheIdentityId: returns configured identity_id without hitting the network', async () => {
  let called = false;
  const agent = { identity_id: 'preset-id' };
  const http = { apiPath: (p) => p, get: async () => { called = true; return {}; } };
  const id = await resolveAndCacheIdentityId({ http, agent, persist: () => {}, logger: silentLogger });
  assert.equal(id, 'preset-id');
  assert.equal(called, false);
});

test('resolveAndCacheIdentityId: resolves from /me and caches + persists when absent', async () => {
  const agent = { identity_id: '' };
  let persisted = 0;
  const http = { apiPath: (p) => `/api/v1${p}`, get: async (p) => { assert.equal(p, '/api/v1/me'); return { identity_id: 'resolved-id' }; } };
  const id = await resolveAndCacheIdentityId({ http, agent, persist: () => { persisted += 1; }, logger: silentLogger });
  assert.equal(id, 'resolved-id');
  assert.equal(agent.identity_id, 'resolved-id');  // cached back into the agent record
  assert.equal(persisted, 1);
});

test('buildRuntime: resolveIdentityId caches identity_id to the org_id-keyed disk file', async () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger }); // identity_id empty
  const fakeHttp = { apiPath: (p) => `/api/v1${p}`, get: async () => ({ identity_id: 'agent-xyz' }) };
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: fakeHttp });
  assert.equal(rt.identityId, '');
  const id = await rt.resolveIdentityId();
  assert.equal(id, 'agent-xyz');
  assert.equal(rt.identityId, 'agent-xyz');         // reachable on the runtime (leadAgentId)
  const disk = readJSON(file);
  assert.equal(disk.agent.identity_id, 'agent-xyz');
});

// ── P0: config file written 0o600 (secrets protection) ─────────────────────────
test('persist() writes the config file 0o600 (secrets not world-readable)', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  rt.applyMemberId('org-uuid-1', 'MEMBER-123'); // triggers persist()
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `config file mode should be 0o600, got 0o${mode.toString(8)}`);
});

// ── P2a: cfAccess is passed to the SDK in the WRAPPED { cf_access } shape ───────
test('buildRuntime wraps cf_access as { cf_access } for the SDK (CF-Access headers work)', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  // no httpClient injected → real CwsHttpClient, whose _cfAccess we inspect
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger });
  assert.deepEqual(rt.http._cfAccess, { cf_access: { client_id: 'cid', client_secret: 'sec' } });
});

test('buildRuntime passes cfAccess=undefined when cf_access is absent', () => {
  const file = tmpFile();
  const raw = newShape(); delete raw.cf_access;
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger });
  assert.equal(rt.http._cfAccess, undefined);
});

// ── P2b: enabled:false orgs are filtered from the SDK-facing views (but kept on disk) ──
test('enabled:false orgs excluded from loadConfig/orgConfigs but preserved by persist', () => {
  const file = tmpFile();
  const raw = newShape();
  raw.orgs['org-uuid-2'] = {
    enabled: false, org_id: 'org-uuid-2', org_name: 'Disabled Org',
    owner: { member_id: '', name: '' }, self: { member_id: '', name: '', display_name: '' }, access: {},
  };
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  // SDK-facing views: enabled org only
  assert.deepEqual(Object.keys(rt.callbacks.loadConfig().orgs), ['org-uuid-1']);
  assert.deepEqual(rt.orgConfigs.map((o) => o.org_id), ['org-uuid-1']);
  assert.deepEqual(rt.configProvider.enabledOrgs().map((o) => o.org_id), ['org-uuid-1']);
  // persist keeps BOTH (disabled org not dropped from disk)
  rt.persist();
  assert.deepEqual(Object.keys(readJSON(file).orgs).sort(), ['org-uuid-1', 'org-uuid-2']);
});

// ── P1: legacy session files migrated forward slug→org_id (cursor preserved) ────
function memStorage(initial = {}) {
  const files = { ...initial };
  return { files, get: async (k) => (k in files ? files[k] : null), set: async (k, v) => { files[k] = v; } };
}
const sessKey = (k) => path.join('sessions', `${k}.json`);

test('loadSession migrates a legacy explicit-slug session forward to org_id', async () => {
  const file = tmpFile();
  const raw = newShape();
  raw.orgs['org-uuid-1'].slug = 'team-alpha'; // explicit legacy slug
  const config = normalizeConfig(raw, { logger: silentLogger });
  const storage = memStorage({ [sessKey('team-alpha')]: JSON.stringify({ cursor: 42 }) });
  const rt = buildRuntime({ config, file, storage, logger: silentLogger, httpClient: {} });
  const session = await rt.callbacks.loadSession('org-uuid-1');
  assert.deepEqual(session, { cursor: 42 });                 // legacy content returned
  assert.equal(storage.files[sessKey('org-uuid-1')], JSON.stringify({ cursor: 42 })); // copied forward
});

test('loadSession migrates a legacy slugify(org_name) session forward to org_id', async () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger }); // org_name "Acme Corp" → acme-corp
  const storage = memStorage({ [sessKey('acme-corp')]: JSON.stringify({ cursor: 7 }) });
  const rt = buildRuntime({ config, file, storage, logger: silentLogger, httpClient: {} });
  assert.deepEqual(await rt.callbacks.loadSession('org-uuid-1'), { cursor: 7 });
  assert.equal(storage.files[sessKey('org-uuid-1')], JSON.stringify({ cursor: 7 }));
});

test('loadSession prefers an existing org_id session over any legacy file', async () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const storage = memStorage({
    [sessKey('org-uuid-1')]: JSON.stringify({ cursor: 100 }),
    [sessKey('acme-corp')]: JSON.stringify({ cursor: 1 }),
  });
  const rt = buildRuntime({ config, file, storage, logger: silentLogger, httpClient: {} });
  assert.deepEqual(await rt.callbacks.loadSession('org-uuid-1'), { cursor: 100 }); // no clobber
});
