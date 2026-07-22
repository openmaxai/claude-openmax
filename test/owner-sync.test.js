import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig, buildRuntime } from '../src/config.js';
import { startOwnerSync } from '../src/owner-sync.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-owner-'));
  return path.join(dir, 'config.json');
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const storageStub = { get: async () => null, set: async () => {} };
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// A config with a KNOWN self.member_id so syncOwnerFromCore can identify our own
// member record (without it, the sync short-circuits with "not available yet").
function shapeWithSelf(over = {}) {
  return {
    enabled: true,
    server: { bff_url: 'https://core.example.com', ws_url: 'wss://comm.example.com/cws-comm', frontend_base_path: '/workspace' },
    agent: { identity_id: '', api_key: 'cwsk_key', device_id: 'dev1', app_version: 'claude-openmax/9.9' },
    orgs: {
      'org-uuid-1': {
        enabled: true,
        org_id: 'org-uuid-1',
        org_name: 'Acme Corp',
        owner: { member_id: '', name: '' },
        self: { member_id: 'SELF-1', name: 'Claude', display_name: '' },
        access: { dmPolicy: 'owner', dmAllowFrom: [], groupPolicy: 'allowlist', groups: {} },
      },
    },
    wake: { endpoint: 'http://127.0.0.1:47600/wake' },
    ...over,
  };
}

// Fake HTTP whose GET /members/:id returns owner_member_id for the self member
// and a display_name for the owner member. `calls` records every path fetched.
function coreHttp({ selfMemberId = 'SELF-1', ownerMemberId, ownerName = '', calls = [] } = {}) {
  return {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async (_orgId, p) => {
      calls.push(p);
      if (p === `/api/v1/members/${selfMemberId}`) return { display_name: 'Claude (Acme)', owner_member_id: ownerMemberId };
      if (ownerMemberId && p === `/api/v1/members/${ownerMemberId}`) return { display_name: ownerName };
      return {};
    },
  };
}

// ── Logic B: periodic owner-info pull-sync applies + persists owner ────────────
test('syncOwnerFromCore: pulls owner from core and persists it into the org_id-keyed disk file', async () => {
  const file = tmpFile();
  const calls = [];
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: 'OWNER-CORE', ownerName: 'Alice', calls }),
  });

  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, true);
  assert.equal(res.ownerMemberId, 'OWNER-CORE');
  assert.equal(res.ownerName, 'Alice');

  // Persisted to disk...
  const disk = readJSON(file);
  assert.equal(disk.orgs['org-uuid-1'].owner.member_id, 'OWNER-CORE');
  assert.equal(disk.orgs['org-uuid-1'].owner.name, 'Alice');
  // ...and reflected in the live captured orgConfig (no restart needed).
  assert.equal(rt.orgConfigs[0].owner.member_id, 'OWNER-CORE');
});

test('syncOwnerFromCore: no-op when core owner already matches local owner', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  raw.orgs['org-uuid-1'].owner = { member_id: 'OWNER-CORE', name: 'Alice' };
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: 'OWNER-CORE', ownerName: 'Alice' }),
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, false);
  assert.equal(res.ownerMemberId, 'OWNER-CORE');
});

test('syncOwnerFromCore: backfills an EMPTY owner name when the id already matches (prior name lookup had failed)', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  // Owner already bound, but the name is empty (a previous owner-name fetch
  // timed out/failed). The id-match early-return must NOT block the backfill.
  raw.orgs['org-uuid-1'].owner = { member_id: 'OWNER-CORE', name: '' };
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: 'OWNER-CORE', ownerName: 'Alice' }), // name now resolves
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, true);
  assert.equal(res.ownerMemberId, 'OWNER-CORE');
  assert.equal(res.ownerName, 'Alice');
  assert.equal(readJSON(file).orgs['org-uuid-1'].owner.name, 'Alice'); // backfilled + persisted
  assert.equal(rt.orgConfigs[0].owner.name, 'Alice');                  // live orgConfig updated too
});

test('syncOwnerFromCore: no redundant persist when id matches and core still returns no name', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  raw.orgs['org-uuid-1'].owner = { member_id: 'OWNER-CORE', name: '' };
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: 'OWNER-CORE', ownerName: '' }), // core has the id but no name
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, false);
  // persist() writes the config file; a no-change tick must not create it.
  assert.equal(fs.existsSync(file), false);
});

test('syncOwnerFromCore: never CLEARS a local owner when core reports none', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  raw.orgs['org-uuid-1'].owner = { member_id: 'LOCAL-OWNER', name: 'Bob' };
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: '' }), // core has no owner
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, false);
  assert.equal(rt.orgConfigs[0].owner.member_id, 'LOCAL-OWNER'); // preserved
});

test('syncOwnerFromCore: short-circuits (no fetch) when self.member_id is not yet known', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  raw.orgs['org-uuid-1'].self.member_id = ''; // token exchange write-back pending
  const calls = [];
  const config = normalizeConfig(raw, { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: 'OWNER-CORE', calls }),
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, false);
  assert.equal(calls.length, 0); // never hit the network
});

// ── timeout guard: a hung core fetch must never block; behave like fetch-fail ──
test('syncOwnerFromCore: self-member fetch exceeding the timeout keeps the local owner (never clears)', async () => {
  const file = tmpFile();
  const raw = shapeWithSelf();
  raw.orgs['org-uuid-1'].owner = { member_id: 'LOCAL-OWNER', name: 'Bob' };
  const config = normalizeConfig(raw, { logger: silentLogger });
  // getForOrg resolves far LATER than the timeout — simulates a hung/slow core
  // connection. (It settles eventually, rather than never, so node:test doesn't
  // flag a dangling promise at suite exit; the timeout still fires first.)
  const hangingHttp = { apiPath: (p) => `/api/v1${p}`, getForOrg: () => new Promise((resolve) => { setTimeout(() => resolve({ owner_member_id: 'SLOW' }), 200); }) };
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: hangingHttp, ownerSyncTimeoutMs: 20, // short timeout keeps the test fast
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, false);
  assert.match(res.reason, /timed out/);                          // timeout → fetch-failure path
  assert.equal(rt.orgConfigs[0].owner.member_id, 'LOCAL-OWNER');  // local owner preserved, not cleared
});

test('syncOwnerFromCore: owner-NAME fetch timeout is non-fatal — owner still bound (empty name)', async () => {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  // self-member resolves (owner=OWNER-CORE); the cosmetic owner-name lookup hangs.
  const partHangHttp = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: (_orgId, p) => (p === '/api/v1/members/SELF-1'
      ? Promise.resolve({ owner_member_id: 'OWNER-CORE' })
      : new Promise((resolve) => { setTimeout(() => resolve({ display_name: 'Late' }), 200); })),
  };
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: partHangHttp, ownerSyncTimeoutMs: 20,
  });
  const res = await rt.syncOwnerFromCore(rt.orgConfigs[0]);
  assert.equal(res.changed, true);
  assert.equal(res.ownerMemberId, 'OWNER-CORE');
  assert.equal(res.ownerName, '');                                // cosmetic lookup timed out → empty
  assert.equal(readJSON(file).orgs['org-uuid-1'].owner.member_id, 'OWNER-CORE'); // still persisted
});

// ── Logic C: owner_changed handler ignores the pushed frame, re-pulls from core ─
test('onConfigEvent(owner_changed): IGNORES the forged owner in the frame and binds core\'s owner instead', async () => {
  const file = tmpFile();
  const calls = [];
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    // Core's authoritative owner is REAL-OWNER.
    httpClient: coreHttp({ ownerMemberId: 'REAL-OWNER', ownerName: 'Trusted', calls }),
  });

  // A pushed owner_changed frame claims the new owner is ATTACKER — this value
  // must be completely ignored; the handler re-pulls from core instead.
  await rt.callbacks.onConfigEvent(rt.orgConfigs[0], {
    event: 'agent.config.owner_changed',
    data: { new_owner_member_id: 'ATTACKER', old_owner_member_id: '', changed_by: 'spoofed' },
  });

  const disk = readJSON(file);
  assert.equal(disk.orgs['org-uuid-1'].owner.member_id, 'REAL-OWNER'); // pull-not-trust
  assert.notEqual(disk.orgs['org-uuid-1'].owner.member_id, 'ATTACKER');
  assert.equal(disk.orgs['org-uuid-1'].owner.name, 'Trusted');
  // Proof it re-pulled from core rather than reading the frame.
  assert.ok(calls.includes('/api/v1/members/SELF-1'));
});

test('onConfigEvent(owner_changed): does NOT write the frame owner into the access block', async () => {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const rt = buildRuntime({
    config, file, storage: storageStub, logger: silentLogger,
    httpClient: coreHttp({ ownerMemberId: '' }), // core has no owner → nothing to bind
  });
  rt.persist(); // baseline on disk (owner_changed with no core owner persists nothing)
  await rt.callbacks.onConfigEvent(rt.orgConfigs[0], {
    event: 'agent.config.owner_changed',
    data: { new_owner_member_id: 'ATTACKER', dmPolicy: 'open' }, // access field is a red herring here
  });
  const disk = readJSON(file);
  // owner_changed returns early BEFORE the access-mirror path, so dmPolicy stays put.
  assert.equal(disk.orgs['org-uuid-1'].access.dmPolicy, 'owner');
  assert.equal(disk.orgs['org-uuid-1'].owner.member_id, '');
});

// A non-owner config event still mirrors access fields (regression guard for the
// early-return added by owner_changed).
test('onConfigEvent(non-owner event): still mirrors access fields', async () => {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  await rt.callbacks.onConfigEvent(rt.orgConfigs[0], {
    event: 'agent.config.dm_policy_changed',
    data: { dmPolicy: 'open' },
  });
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.dmPolicy, 'open');
});

// ── periodic scheduler: reconciles every active org, then stops cleanly ────────
test('startOwnerSync: initial pass reconciles every active org via syncOwnerFromCore', async () => {
  const seen = [];
  const fakeRuntime = {
    orgConfigs: [{ org_id: 'a' }, { org_id: 'b' }],
    syncOwnerFromCore: async (orgConfig) => { seen.push(orgConfig.org_id); return { changed: false }; },
  };
  const handle = startOwnerSync({ runtime: fakeRuntime, logger: silentLogger, initialDelayMs: 0, intervalMs: 60_000 });
  // initialDelayMs:0 runs the first tick synchronously; let the async calls settle.
  await new Promise((r) => setImmediate(r));
  handle.stop();
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('startOwnerSync: stop() clears the interval (no further ticks)', async () => {
  let ticks = 0;
  const fakeRuntime = {
    orgConfigs: [{ org_id: 'a' }],
    syncOwnerFromCore: async () => { ticks += 1; return { changed: false }; },
  };
  const handle = startOwnerSync({ runtime: fakeRuntime, logger: silentLogger, initialDelayMs: 0, intervalMs: 5 });
  await new Promise((r) => setImmediate(r));
  const afterFirst = ticks;
  handle.stop();
  await new Promise((r) => setTimeout(r, 30)); // longer than the 5ms interval
  assert.equal(ticks, afterFirst); // no ticks after stop()
});
