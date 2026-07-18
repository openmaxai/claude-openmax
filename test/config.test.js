import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeConfig,
  slugify,
  deriveSlug,
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

// ── slug derivation ────────────────────────────────────────────────────────────
test('slugify: lowercases, strips punctuation, collapses to dashes', () => {
  assert.equal(slugify('Acme Corp'), 'acme-corp');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('***'), '');
});

test('deriveSlug: explicit slug > slugified org_name > org_id', () => {
  assert.equal(deriveSlug({ slug: 'explicit', org_name: 'Acme', org_id: 'id1' }, 'id1'), 'explicit');
  assert.equal(deriveSlug({ org_name: 'Acme Corp', org_id: 'id1' }, 'id1'), 'acme-corp');
  assert.equal(deriveSlug({ org_id: 'id1' }, 'id1'), 'id1');
  assert.equal(deriveSlug({ org_name: '***', org_id: 'id1' }, 'id1'), 'id1'); // unslugable name falls back
  assert.equal(deriveSlug({}, 'keyed-id'), 'keyed-id');                        // uses the map key
});

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
  // orgs normalized to an internal ARRAY with a derived slug
  assert.equal(c.orgs.length, 1);
  assert.equal(c.orgs[0].org_id, 'org-uuid-1');
  assert.equal(c.orgs[0].slug, 'acme-corp');
  assert.equal(c.orgs[0].slugExplicit, false);
});

test('normalizeConfig: frontend_base_path defaults to /workspace when absent', () => {
  const raw = newShape();
  delete raw.server.frontend_base_path;
  const c = normalizeConfig(raw, { logger: silentLogger });
  assert.equal(c.server.frontend_base_path, '/workspace');
});

test('normalizeConfig: explicit slug is preserved and flagged', () => {
  const raw = newShape();
  raw.orgs['org-uuid-1'].slug = 'my-explicit';
  const c = normalizeConfig(raw, { logger: silentLogger });
  assert.equal(c.orgs[0].slug, 'my-explicit');
  assert.equal(c.orgs[0].slugExplicit, true);
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
  assert.equal(c.orgs[0].slug, 'team-alpha');      // explicit slug preserved through translation
  assert.equal(c.orgs[0].self.member_id, 'm-old');
});

// ── org_id ⇄ slug bridge + slug-keyed loadConfig ───────────────────────────────
test('buildRuntime: loadConfig() returns a SLUG-keyed org map (SDK expectation)', () => {
  const file = tmpFile();
  const config = normalizeConfig(newShape(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  const loaded = rt.callbacks.loadConfig();
  assert.deepEqual(Object.keys(loaded.orgs), ['acme-corp']);
  assert.equal(loaded.orgs['acme-corp'].org_id, 'org-uuid-1');
  // orgConfigs handed to the SDK carry both slug and org_id
  assert.equal(rt.orgConfigs[0].slug, 'acme-corp');
  assert.equal(rt.orgConfigs[0].org_id, 'org-uuid-1');
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
  rt.callbacks.onOwnerBind('acme-corp', 'OWNER-9', 'Alice');
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
