import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decideInbound } from '@openmaxai/openmax-agent-sdk';

import { normalizeConfig, buildRuntime } from '../src/config.js';
import { startOwnerSync } from '../src/owner-sync.js';
import { accessFromServerPolicy, buildReportedPolicy } from '../src/policy-sync.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-owner-'));
  return path.join(dir, 'config.json');
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const storageStub = { get: async () => null, set: async () => {} };

// In-memory StorageProvider. The policy reconcile writes its marker
// ({fp, serverUpdatedAt}) through this seam and READS IT BACK on the next pass to
// tell "the server changed" from "we changed" — with a get()->null stub every
// pass would look like the very first one, so the write-vs-adopt branches could
// not be tested at all. One instance per runtime: the org id is the same in
// every test here, so a shared map would leak markers between them.
function memStorage() {
  const files = new Map();
  return {
    files,
    get: async (key) => (files.has(key) ? files.get(key) : null),
    set: async (key, value) => { files.set(key, String(value)); },
  };
}
const POLICY_MARKER_KEY = path.join('policy', 'org-uuid-1.json');
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
// early-return added by owner_changed). dm_policy_changed carries the REAL field
// `policy` (not a literal `dmPolicy`) — the whole point of the event-type mapping.
test('onConfigEvent(non-owner event): still mirrors access fields', async () => {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const rt = buildRuntime({ config, file, storage: storageStub, logger: silentLogger, httpClient: {} });
  await rt.callbacks.onConfigEvent(rt.orgConfigs[0], {
    event: 'agent.config.dm_policy_changed',
    data: { policy: 'open' },
  });
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.dmPolicy, 'open');
});

// ── event-type-aware access mapping (regression: pickAccess dropped real fields) ─
// Each case sends the WIRE payload the OpenMax workspace UI actually emits and
// asserts the org's access block + the SDK's live orgConfig.access both change and
// are persisted. Uses an httpClient:{} stub so no network is touched.
function accessRuntime() {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  // Memory storage + a 1ms debounce so the policy reconcile the onConfigEvent
  // tail schedules actually runs inside the test — with the bare `httpClient: {}`
  // stub these cases double as the regression guard for the capability probe.
  const storage = memStorage();
  const rt = buildRuntime({ config, file, storage, logger: silentLogger, httpClient: {}, policyDebounceMs: 1 });
  return { file, rt, org: rt.orgConfigs[0], storage };
}

test('onConfigEvent(group_scope_changed): sets groupPolicy (the live bug repro)', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_scope_changed',
    data: { scope: 'allowlist' },
  });
  assert.equal(org.access.groupPolicy, 'allowlist');            // live SDK gate sees it
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.groupPolicy, 'allowlist'); // persisted
});

test('onConfigEvent(group_scope_changed): rejects an invalid scope (nothing applied)', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_scope_changed',
    data: { scope: 'bogus' },
  });
  assert.equal(org.access.groupPolicy, 'allowlist');            // unchanged from shapeWithSelf default
  // An invalid event applies nothing and never calls persist() → no file written.
  assert.equal(fs.existsSync(file), false);
});

test('onConfigEvent(group_allowlist_changed add): adds group entries with defaults', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_allowlist_changed',
    data: { action: 'add', conversation_ids: ['conv-A', 'conv-B'] },
  });
  assert.deepEqual(org.access.groups['conv-A'], { mode: 'mention', allowFrom: ['*'] });
  assert.deepEqual(org.access.groups['conv-B'], { mode: 'mention', allowFrom: ['*'] });
  assert.deepEqual(readJSON(file).orgs['org-uuid-1'].access.groups['conv-A'], { mode: 'mention', allowFrom: ['*'] });
});

test('onConfigEvent(group_allowlist_changed remove): deletes group entries', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_allowlist_changed',
    data: { action: 'add', conversation_ids: ['conv-A', 'conv-B'] },
  });
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_allowlist_changed',
    data: { action: 'remove', conversation_ids: ['conv-A'] },
  });
  assert.equal(org.access.groups['conv-A'], undefined);
  assert.ok(org.access.groups['conv-B']);
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.groups['conv-A'], undefined);
});

test('onConfigEvent(group_allowlist_changed set): replaces the whole allowlist, preserving existing entry settings', async () => {
  const { file, rt, org } = accessRuntime();
  // seed conv-A with a non-default mode, then `set` to [conv-A, conv-C]
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_mode_changed',
    data: { mode: 'smart', conversation_id: 'conv-A' },
  });
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_allowlist_changed',
    data: { action: 'set', conversation_ids: ['conv-A', 'conv-C'] },
  });
  assert.deepEqual(Object.keys(org.access.groups).sort(), ['conv-A', 'conv-C']);
  assert.equal(org.access.groups['conv-A'].mode, 'smart');        // preserved existing settings
  assert.deepEqual(org.access.groups['conv-C'], { mode: 'mention', allowFrom: ['*'] }); // fresh default
  assert.deepEqual(Object.keys(readJSON(file).orgs['org-uuid-1'].access.groups).sort(), ['conv-A', 'conv-C']);
});

test('onConfigEvent(dm_policy_changed): sets dmPolicy and validates', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_policy_changed', data: { policy: 'allowlist' } });
  assert.equal(org.access.dmPolicy, 'allowlist');
  // invalid policy is rejected — value stays
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_policy_changed', data: { policy: 'nope' } });
  assert.equal(org.access.dmPolicy, 'allowlist');
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.dmPolicy, 'allowlist');
});

test('onConfigEvent(dm_allowlist_changed): add / remove / set on dmAllowFrom', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_allowlist_changed', data: { action: 'add', member_ids: ['m1', 'm2'] } });
  assert.deepEqual(org.access.dmAllowFrom, ['m1', 'm2']);
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_allowlist_changed', data: { action: 'add', member_ids: ['m2', 'm3'] } }); // dedupe m2
  assert.deepEqual(org.access.dmAllowFrom, ['m1', 'm2', 'm3']);
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_allowlist_changed', data: { action: 'remove', member_ids: ['m1'] } });
  assert.deepEqual(org.access.dmAllowFrom, ['m2', 'm3']);
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.dm_allowlist_changed', data: { action: 'set', member_ids: ['x'] } });
  assert.deepEqual(org.access.dmAllowFrom, ['x']);
  assert.deepEqual(readJSON(file).orgs['org-uuid-1'].access.dmAllowFrom, ['x']);
});

test('onConfigEvent(group_mode_changed): sets a mode, silent deletes the group entry', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_mode_changed', data: { mode: 'smart', conversation_id: 'conv-X' } });
  assert.deepEqual(org.access.groups['conv-X'], { allowFrom: ['*'], mode: 'smart' });
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_mode_changed', data: { mode: 'silent', conversation_id: 'conv-X' } });
  assert.equal(org.access.groups['conv-X'], undefined);
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.groups['conv-X'], undefined);
});

test('onConfigEvent(group_allowfrom_changed): sets allowFrom, creating a mention entry when absent', async () => {
  const { file, rt, org } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_allowfrom_changed', data: { conversation_id: 'conv-Y', allow_from: ['m9'] } });
  assert.deepEqual(org.access.groups['conv-Y'], { mode: 'mention', allowFrom: ['m9'] });
  // updating an existing entry replaces allowFrom but keeps mode
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_mode_changed', data: { mode: 'smart', conversation_id: 'conv-Y' } });
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_allowfrom_changed', data: { conversation_id: 'conv-Y', allow_from: ['*'] } });
  assert.deepEqual(org.access.groups['conv-Y'], { mode: 'smart', allowFrom: ['*'] });
  assert.deepEqual(readJSON(file).orgs['org-uuid-1'].access.groups['conv-Y'], { mode: 'smart', allowFrom: ['*'] });
});

test('onConfigEvent(unknown event): warns and applies nothing', async () => {
  const { file, rt, org } = accessRuntime();
  const before = JSON.stringify(org.access);
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.something_new', data: { foo: 'bar' } });
  assert.equal(JSON.stringify(org.access), before);
  // Unknown event applies nothing → persist() not called → no file written.
  assert.equal(fs.existsSync(file), false);
});

test('onConfigEvent: skips an event addressed to a DIFFERENT agent_member_id', async () => {
  const { rt, org } = accessRuntime(); // shapeWithSelf → self.member_id = SELF-1
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_scope_changed',
    data: { scope: 'open', agent_member_id: 'SOMEONE-ELSE' },
  });
  assert.equal(org.access.groupPolicy, 'allowlist'); // unchanged — not for us
  // ...but an event targeting US (or with no target) IS applied
  await rt.callbacks.onConfigEvent(org, {
    event: 'agent.config.group_scope_changed',
    data: { scope: 'open', agent_member_id: 'SELF-1' },
  });
  assert.equal(org.access.groupPolicy, 'open');
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

// ── policy reconcile: local access block ⇄ server reported-policy ─────────────
// The reconcile is pull-first: it reads GET /agents/<self>/policy and only PUTs
// /reported-policy when that read proved there is nothing to overwrite. Every
// case below therefore asserts the NUMBER of PUTs, not just their content — an
// upload that should not have happened is the failure mode that erases a policy a
// human set in the workspace UI.
function policyRuntime(opts = {}) {
  const file = tmpFile();
  const raw = shapeWithSelf();
  if (opts.access) raw.orgs['org-uuid-1'].access = opts.access;
  if (opts.selfMemberId !== undefined) raw.orgs['org-uuid-1'].self.member_id = opts.selfMemberId;
  const config = normalizeConfig(raw, { logger: silentLogger });
  const storage = memStorage();
  const calls = [];
  const puts = [];
  const httpClient = {
    apiPath: (p) => `/api/v1${p}`,
    getForOrg: async (_orgId, p) => {
      calls.push(p);
      if (p === '/api/v1/agents/SELF-1/policy') {
        if (opts.getError) throw opts.getError;
        if (opts.getHangs) return new Promise((resolve) => { setTimeout(() => resolve({ updated_at: 9 }), 200); });
        return typeof opts.policy === 'function' ? opts.policy() : (opts.policy || {});
      }
      return {};
    },
    putForOrg: async (_orgId, p, body) => {
      puts.push({ path: p, body });
      const err = opts.putError?.(puts.length, body);
      if (err) throw err;
      return {};
    },
  };
  const rt = buildRuntime({
    config, file, storage, logger: silentLogger, httpClient,
    policySyncTimeoutMs: opts.policySyncTimeoutMs ?? 50,
    policyDebounceMs: opts.policyDebounceMs ?? 1,
  });
  return { file, rt, org: rt.orgConfigs[0], storage, calls, puts };
}
const readMarker = async (storage) => JSON.parse(await storage.get(POLICY_MARKER_KEY));

test('reconcilePolicyWithServer: seeds the server when the snapshot has no policy row (updated_at absent)', async () => {
  const { rt, org, puts, storage } = policyRuntime({
    access: {
      dmPolicy: 'allowlist', dmAllowFrom: ['m1'], groupPolicy: 'allowlist',
      groups: { 'conv-A': { mode: 'smart', allowFrom: ['m7'] } },
    },
    // What cws-core synthesizes when no policy row exists: defaults everywhere,
    // no updated_at. The "open" group scope here is NOT an owner's decision.
    policy: { dm_policy: 'owner', dm_allowlist: [], group_scope: 'open', group_allowlist: [], groups: [] },
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/api/v1/agents/SELF-1/reported-policy');
  assert.deepEqual(puts[0].body, {
    dm_policy: 'allowlist',
    dm_allowlist: ['m1'],
    group_scope: 'allowlist',
    group_allowlist: ['conv-A'],
    groups: [{ conversation_id: 'conv-A', mode: 'smart', allow_from: ['m7'] }],
  });
  assert.equal(res.direction, 'reported-local');
  assert.equal(typeof (await readMarker(storage)).fp, 'string');
});

test('reconcilePolicyWithServer: updated_at absent but the snapshot HAS group state → reports nothing', async () => {
  // Reachable server state: per-group rows live in their own table and can exist
  // while the policy row does not. That group state is real human input, and a
  // report replaces it wholesale, so a zero timestamp alone must not authorize an
  // upload.
  const { rt, org, puts } = policyRuntime({
    access: { dmPolicy: 'open' },
    policy: { dm_policy: 'owner', group_scope: 'open', group_allowlist: [], groups: [{ conversation_id: 'conv-Z', mode: 'mention', allow_from: ['*'] }] },
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /updated_at=0/);
});

test('reconcilePolicyWithServer: a server copy newer than our marker is ADOPTED, never overwritten', async () => {
  const { rt, org, file, puts, storage } = policyRuntime({
    access: { dmPolicy: 'owner', dmAllowFrom: [], groupPolicy: 'allowlist', groups: {} },
    policy: {
      dm_policy: 'open', dm_allowlist: ['m5'], group_scope: 'allowlist',
      group_allowlist: ['conv-B', 'conv-C'],
      groups: [{ conversation_id: 'conv-B', mode: 'smart', allow_from: ['*'] }],
      updated_at: 1700,
    },
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);                                  // the server wins — no upload
  assert.equal(res.direction, 'adopted-server');
  assert.equal(org.access.dmPolicy, 'open');                      // live gate sees it
  assert.deepEqual(org.access.dmAllowFrom, ['m5']);
  assert.equal(org.access.groupPolicy, 'allowlist');
  assert.deepEqual(org.access.groups['conv-B'], { mode: 'smart', allowFrom: ['*'] });
  // Allowlisted with no per-group row → local entry on the SDK's own defaults,
  // otherwise the allowlist gate would reject a group the page shows as allowed.
  assert.deepEqual(org.access.groups['conv-C'], { mode: 'mention', allowFrom: ['*'] });
  assert.equal(readJSON(file).orgs['org-uuid-1'].access.dmPolicy, 'open'); // persisted
  assert.equal((await readMarker(storage)).serverUpdatedAt, 1700);
});

test('reconcilePolicyWithServer: adopting also repoints the SDK\'s live orgConfig.access when it is a different object', async () => {
  const { rt, puts } = policyRuntime({
    policy: { dm_policy: 'open', dm_allowlist: [], group_scope: 'open', group_allowlist: [], groups: [], updated_at: 42 },
  });
  // The SDK hands us ITS orgConfig; in this adapter it is normally the same
  // object as the internal record, but the code does not assume that.
  const sdkView = { org_id: 'org-uuid-1', self: { member_id: 'SELF-1' }, access: { dmPolicy: 'owner' } };
  const res = await rt.reconcilePolicyWithServer(sdkView);
  assert.equal(res.direction, 'adopted-server');
  assert.equal(puts.length, 0);
  assert.equal(sdkView.access.dmPolicy, 'open');
  assert.equal(rt.orgConfigs[0].access.dmPolicy, 'open');
});

test('reconcilePolicyWithServer: server unchanged since the marker + local changed → reports once', async () => {
  const { rt, org, puts } = policyRuntime({
    policy: { dm_policy: 'owner', dm_allowlist: [], group_scope: 'allowlist', group_allowlist: [], groups: [], updated_at: 1700 },
  });
  await rt.reconcilePolicyWithServer(org);      // first pass: adopt + record the marker
  assert.equal(puts.length, 0);
  org.access.dmPolicy = 'allowlist';            // a local change (SDK dm tools land here)
  org.access.dmAllowFrom = ['m9'];
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 1);
  assert.equal(res.direction, 'reported-local');
  assert.equal(puts[0].body.dm_policy, 'allowlist');
  assert.deepEqual(puts[0].body.dm_allowlist, ['m9']);
  // ...and a third pass with nothing changed is a no-op (no upload, no re-adopt).
  const res3 = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 1);
  assert.equal(res3.changed, false);
  assert.equal(res3.reason, 'in sync');
});

test('reconcilePolicyWithServer: a FAILED policy read never uploads (the anti-erasure invariant)', async () => {
  const { rt, org, puts, storage } = policyRuntime({
    access: { dmPolicy: 'open', groupPolicy: 'open' },
    getError: Object.assign(new Error('bad gateway'), { status: 502 }),
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /policy fetch failed/);
  assert.equal(await storage.get(POLICY_MARKER_KEY), null); // no marker either
});

test('reconcilePolicyWithServer: a policy read that TIMES OUT never uploads', async () => {
  const { rt, org, puts } = policyRuntime({
    access: { dmPolicy: 'open' }, getHangs: true, policySyncTimeoutMs: 20,
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /timed out/);
});

test('reconcilePolicyWithServer: a 404 on the policy read never uploads (endpoint missing on older deployments)', async () => {
  const { rt, org, puts } = policyRuntime({
    access: { dmPolicy: 'open' },
    getError: Object.assign(new Error('not found'), { status: 404 }),
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /policy fetch failed/);
});

test('reconcilePolicyWithServer: a policy read with no object body never uploads', async () => {
  const { rt, org, puts } = policyRuntime({ access: { dmPolicy: 'open' }, policy: () => null });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /no object body/);
});

test('reconcilePolicyWithServer: short-circuits with no HTTP at all when self.member_id is unknown', async () => {
  const { rt, org, calls, puts } = policyRuntime({ selfMemberId: '' });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(calls.length, 0);
  assert.equal(puts.length, 0);
  assert.match(res.reason, /member_id not available/);
});

test('reconcilePolicyWithServer: a 4xx naming one of our groups drops THAT group and retries once (local config untouched)', async () => {
  // cws-comm answers 404 both when the endpoint is absent and when a reported
  // group is no longer ours (verifyAgentGroupMember). Collapsing the two into
  // "endpoint missing" — as the zylos-openmax reference does — silences all
  // policy reporting for the rest of the session.
  const { rt, org, puts, file } = policyRuntime({
    access: {
      dmPolicy: 'owner', groupPolicy: 'allowlist',
      groups: { 'conv-GONE': { mode: 'smart', allowFrom: ['*'] }, 'conv-OK': { mode: 'mention', allowFrom: ['*'] } },
    },
    policy: { dm_policy: 'owner', group_scope: 'allowlist', group_allowlist: [], groups: [] },
    putError: (n) => (n === 1
      ? Object.assign(new Error('group conv-GONE: not found'), { status: 404, body: { error: { detail: 'group conv-GONE: not found' } } })
      : null),
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 2);                                    // rejected, then retried
  assert.deepEqual(puts[1].body.group_allowlist, ['conv-OK']);
  assert.deepEqual(puts[1].body.groups.map((g) => g.conversation_id), ['conv-OK']);
  assert.equal(res.direction, 'reported-local');
  // The rejected group stays in local config: a membership blip must not delete
  // an owner's setting, and re-adding the agent restores the report by itself.
  assert.ok(org.access.groups['conv-GONE']);
  // And a report-only pass never rewrites config.json — it holds credentials, so
  // the periodic steady state must stay off the disk entirely.
  assert.equal(fs.existsSync(file), false);
});

test('reconcilePolicyWithServer: a 404 naming NONE of our groups is treated as a missing endpoint (no retry)', async () => {
  const { rt, org, puts } = policyRuntime({
    access: { dmPolicy: 'owner', groupPolicy: 'allowlist', groups: { 'conv-OK': { mode: 'mention', allowFrom: ['*'] } } },
    policy: { dm_policy: 'owner', group_scope: 'allowlist', group_allowlist: [], groups: [] },
    putError: () => Object.assign(new Error('404 page not found'), { status: 404 }),
  });
  const res = await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 1);
  assert.match(res.reason, /endpoint unavailable/);
});

test('reconcilePolicyWithServer: a silent group is excluded from BOTH groups[] and group_allowlist', async () => {
  // The server's mode enum is smart|mention and it validates the whole report
  // before writing: one silent entry would 400 the ENTIRE upload.
  const { rt, org, puts } = policyRuntime({
    access: {
      dmPolicy: 'owner', groupPolicy: 'allowlist',
      groups: { c1: { mode: 'silent', allowFrom: ['*'] }, c2: { mode: 'mention', allowFrom: ['*'] } },
    },
    policy: {},
  });
  await rt.reconcilePolicyWithServer(org);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body.group_allowlist, ['c2']);
  assert.deepEqual(puts[0].body.groups.map((g) => g.conversation_id), ['c2']);
});

test('reconcilePolicyWithServer: an empty local allowFrom is reported as the explicit wildcard', async () => {
  // Locally [] means "any member may trigger me"; on the wire an empty list reads
  // as "nobody". `[] || ['*']` does not fix this — [] is truthy in JS.
  const { rt, org, puts } = policyRuntime({
    access: { groupPolicy: 'allowlist', groups: { c3: { mode: 'mention', allowFrom: [] } } },
    policy: {},
  });
  await rt.reconcilePolicyWithServer(org);
  assert.deepEqual(puts[0].body.groups, [{ conversation_id: 'c3', mode: 'mention', allow_from: ['*'] }]);
});

test('onConfigEvent with a bare httpClient: the scheduled reconcile is skipped, not thrown', async () => {
  // accessRuntime uses `httpClient: {}` — the capability probe is what keeps the
  // twelve onConfigEvent cases above from turning into twelve TypeErrors.
  const { rt, org, storage } = accessRuntime();
  await rt.callbacks.onConfigEvent(org, { event: 'agent.config.group_scope_changed', data: { scope: 'open' } });
  await new Promise((r) => setTimeout(r, 30)); // let the debounced reconcile run
  assert.equal(org.access.groupPolicy, 'open');             // the event still applied
  assert.equal(await storage.get(POLICY_MARKER_KEY), null); // nothing reported, no marker
});

test('reconcilePolicyWithServer: a bare httpClient reports nothing and never throws', async () => {
  const file = tmpFile();
  const config = normalizeConfig(shapeWithSelf(), { logger: silentLogger });
  const storage = memStorage();
  const rt = buildRuntime({ config, file, storage, logger: silentLogger, httpClient: {} });
  const res = await rt.reconcilePolicyWithServer(rt.orgConfigs[0]);
  assert.match(res.reason, /getForOrg\/putForOrg\/apiPath/);
  assert.equal(await storage.get(POLICY_MARKER_KEY), null);
});

// ── the mapper invariant: a round trip must not change a single verdict ────────
// buildReportedPolicy + accessFromServerPolicy are only correct if the SDK's real
// decideInbound cannot tell a local access block apart from the same block sent to
// the server and read back. Any fallback that drifts from access-policy.js (say
// `|| 'open'` where the SDK says `|| 'allowlist'`) flips at least one verdict in
// this matrix.
//
// `mode: 'silent'` is deliberately absent from the matrix: it is the one lossy
// case by design (the server enum cannot express it, so the group is dropped from
// the report) and it has its own test above.
test('accessFromServerPolicy(buildReportedPolicy(a)): decideInbound returns the same verdict for every access shape', async () => {
  const accessMatrix = [
    {},                                                       // nothing configured at all
    { dmPolicy: 'open' },
    { dmPolicy: 'owner' },
    { dmPolicy: 'allowlist', dmAllowFrom: [] },
    { dmPolicy: 'allowlist', dmAllowFrom: ['M-ALLOWED'] },
    { groupPolicy: 'open' },
    { groupPolicy: 'disabled' },
    { groupPolicy: 'allowlist' },
    { groupPolicy: 'allowlist', groups: {} },
    { groupPolicy: 'allowlist', groups: { 'CONV-G': { mode: 'mention', allowFrom: ['*'] } } },
    { groupPolicy: 'allowlist', groups: { 'CONV-G': { mode: 'smart', allowFrom: [] } } },
    { groupPolicy: 'allowlist', groups: { 'CONV-G': { mode: 'smart', allowFrom: ['M-ALLOWED'] } } },
    { groupPolicy: 'allowlist', groups: { 'CONV-G': { mode: 'mention' } } },      // no allowFrom key
    { groupPolicy: 'allowlist', groups: { 'CONV-G': {} } },                       // neither key set
    { groupPolicy: 'open', groups: { 'CONV-G': { allowFrom: ['M-ALLOWED'] } } },  // no mode key
    { groupPolicy: 'open', groups: { 'CONV-G': { mode: 'mention', allowFrom: ['M-ALLOWED'] } } },
    { groupPolicy: 'open', groups: { 'CONV-OTHER': { mode: 'smart', allowFrom: ['*'] } } },
    { dmPolicy: 'allowlist', dmAllowFrom: ['M-ALLOWED'], groupPolicy: 'allowlist', groups: { 'CONV-G': { mode: 'smart', allowFrom: ['*'] } } },
  ];

  const probes = [];
  for (const sender of ['M-OWNER', 'M-ALLOWED', 'M-STRANGER']) {
    probes.push({ label: `dm/${sender}`, conv: { type: 'dm' }, msg: { sender_id: sender, conversation_id: 'CONV-DM', content: 'hello' } });
    for (const convId of ['CONV-G', 'CONV-OTHER']) {
      probes.push({
        label: `group ${convId} @me /${sender}`,
        conv: { type: 'group' },
        msg: { sender_id: sender, conversation_id: convId, content: '@Claude ping', mentions: ['SELF-1'] },
      });
      probes.push({
        label: `group ${convId} plain /${sender}`,
        conv: { type: 'group' },
        msg: { sender_id: sender, conversation_id: convId, content: 'ping' },
      });
    }
  }

  const orgBase = {
    org_id: 'ORG-1',
    self: { member_id: 'SELF-1', name: 'Claude', display_name: 'Claude' },
    owner: { member_id: 'M-OWNER', name: 'Ownie' },
  };
  const verdicts = new Set();
  for (const access of accessMatrix) {
    // `updated_at: 1` marks the snapshot as a real server row, exactly as the
    // reconcile's adopt path sees it.
    const roundTripped = accessFromServerPolicy({ ...buildReportedPolicy(access), updated_at: 1 });
    for (const { label, msg, conv } of probes) {
      const before = await decideInbound(msg, conv, { ...orgBase, access });
      const after = await decideInbound(msg, conv, { ...orgBase, access: roundTripped });
      const where = `${label} | access=${JSON.stringify(access)}`;
      assert.equal(after.handle, before.handle, `handle changed: ${where}`);
      assert.equal(after.reason, before.reason, `reason changed: ${where}`);
      verdicts.add(`${before.handle}:${before.reason}`);
    }
  }
  // Coverage guard: without it a matrix that (say) never reached the group branch
  // would pass by never disagreeing about anything.
  assert.ok(verdicts.size >= 10, `matrix exercised only ${verdicts.size} distinct verdicts: ${[...verdicts].join(' / ')}`);
  assert.ok([...verdicts].some((v) => v.startsWith('true:')), 'no accepted message in the matrix');
  assert.ok([...verdicts].some((v) => v.startsWith('false:')), 'no rejected message in the matrix');
});

test('accessFromServerPolicy({}): a response missing fields falls back to the SDK\'s defaults, not the server\'s', async () => {
  // Only reachable from a server response that omits the fields (current cws-core
  // always sends them), so the round-trip matrix cannot see this fallback —
  // guessing the server's "open" here would widen group access on a partial
  // response. Pinned directly.
  const access = accessFromServerPolicy({});
  assert.equal(access.groupPolicy, 'allowlist');
  assert.equal(access.dmPolicy, 'owner');
  assert.deepEqual(access.dmAllowFrom, []);
  assert.deepEqual(access.groups, {});
  assert.deepEqual(accessFromServerPolicy(undefined), access);
});

test('buildReportedPolicy({}): the empty-access defaults are the SDK\'s, not the server\'s', async () => {
  // Hard-pinned because these two are where a wrong default is invisible: the
  // server substitutes "open" for a missing group_scope, and its no-row snapshot
  // reads "open" too, so `|| 'open'` here would look plausible and silently
  // report an unconfigured agent as reachable in every group.
  const payload = buildReportedPolicy({});
  assert.equal(payload.group_scope, 'allowlist');
  assert.equal(payload.dm_policy, 'owner');
  assert.deepEqual(payload.dm_allowlist, []);
  assert.deepEqual(payload.group_allowlist, []);
  assert.deepEqual(payload.groups, []);
});
