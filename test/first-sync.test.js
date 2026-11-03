// First channel session after onboarding: messages sent between the onboarding
// and the first channel session must be delivered (1.3.2 sought to the inbox
// end and dropped them — "init sync_seq=1 (seeked to inbox end)").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { CwsAgentBridge } from '@openmaxai/openmax-agent-sdk';
import { normalizeConfig, buildRuntime } from '../src/config.js';
import { createFileStorage } from '../src/storage.js';
import { createBridge } from '../src/create-bridge.js';
import {
  FIRST_SYNC_KEY, inboxStartCursor, writeFirstSyncMarker, createFirstSync, ledgerAccessor,
} from '../src/first-sync.js';

const silent = { info() {}, log() {}, warn() {}, error() {}, debug() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openmax-first-sync-'));
const ORG = 'org-1';
const OWNER = 'owner-member';
const API_KEY = 'cwsk_new_identity_key';

// ── the cursor value ─────────────────────────────────────────────────────────

test('inboxStartCursor is truthy, compares and computes as 0, and serialises as the number 0', () => {
  const c = inboxStartCursor();
  assert.ok(c, 'truthy — the SDK must NOT take its seek-to-inbox-end path');
  assert.equal(c > 0, false, 'not > 0 — the SDK must NOT pre-seed the inbox ledger with it');
  assert.equal(Math.max(c, 0), 0);
  assert.equal(Math.min(c, 5), 0);
  assert.equal(JSON.stringify({ since_seq: c }), '{"since_seq":0}');
});

// ── marker lifecycle ─────────────────────────────────────────────────────────

test('marker: pending for the onboarded api_key + onboarded orgs only, retired per org once a real cursor is saved', async () => {
  const dir = tmpDir();
  assert.equal(writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, identityId: 'id-1', orgIds: [ORG, 'org-2'], now: 0 }), true);
  assert.equal(fs.statSync(path.join(dir, FIRST_SYNC_KEY)).mode & 0o777, 0o600);
  const storage = createFileStorage({ dataDir: dir });

  const other = createFirstSync({ storage, apiKey: 'cwsk_some_other_key', logger: silent });
  assert.equal(await other.initialCursor(ORG), null, 'a different identity ignores the marker');

  const fs1 = createFirstSync({ storage, apiKey: API_KEY, logger: silent });
  assert.ok(await fs1.initialCursor(ORG));
  assert.equal(await fs1.initialCursor('org-joined-later'), null, 'an org that was not onboarded keeps the SDK default');
  await fs1.cursorSaved(ORG, inboxStartCursor());   // not a real cursor
  await fs1.cursorSaved(ORG, 0);
  assert.ok(await fs1.initialCursor(ORG), 'still pending');
  await fs1.cursorSaved(ORG, 3);
  assert.equal(await fs1.initialCursor(ORG), null, 'spent for this org');
  assert.ok(await fs1.initialCursor('org-2'), 'other onboarded orgs keep theirs');
});

test('writeFirstSyncMarker refuses a marker that would apply to no org', () => {
  const dir = tmpDir();
  assert.equal(writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [] }), false);
  assert.equal(fs.existsSync(path.join(dir, FIRST_SYNC_KEY)), false);
});

test('cursorSaved advances the bound inbox ledger to the first real cursor (closes a gap below it)', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [ORG] });
  const fsx = createFirstSync({ storage: createFileStorage({ dataDir: dir }), apiKey: API_KEY, logger: silent });
  let acked = 0;
  const ledger = { getAckedSeq: () => acked, setAckedSeq: (n) => { if (n > acked) acked = n; } };
  fsx.bindLedgers((id) => (id === ORG ? ledger : null));
  await fsx.cursorSaved(ORG, 7);
  assert.equal(acked, 7);
  await fsx.cursorSaved(ORG, 9);   // marker spent → no more ledger writes
  assert.equal(acked, 7);
});

test('no marker → loadSession keeps the SDK default (empty session → seek to the inbox end)', async () => {
  const dir = tmpDir();
  const rt = runtime(dir);
  assert.deepEqual(await rt.callbacks.loadSession(ORG), {});
});

test('marker + an EXISTING session → the existing cursor wins (the marker is not consulted)', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [ORG] });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', `${ORG}.json`), JSON.stringify({ sync_seq: 4 }));
  const rt = runtime(dir);
  assert.deepEqual(await rt.callbacks.loadSession(ORG), { sync_seq: 4 });
});

test('marker, no session → start-of-inbox cursor; saveSession retires it; a purged session never replays again', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [ORG] });
  const rt = runtime(dir);
  const first = await rt.callbacks.loadSession(ORG);
  assert.ok(first.sync_seq && !(first.sync_seq > 0), 'start-of-inbox cursor');
  await rt.callbacks.saveSession(ORG, { sync_seq: 4 });
  assert.deepEqual(await rt.callbacks.loadSession(ORG), { sync_seq: 4 });
  fs.rmSync(path.join(dir, 'sessions', `${ORG}.json`));
  assert.deepEqual(await rt.callbacks.loadSession(ORG), {});
});

// ── end to end through the real SDK orchestrator ─────────────────────────────

function runtime(dataDir) {
  const config = normalizeConfig({
    server: { bff_url: 'https://core.example', ws_url: 'wss://comm.example/ws' },
    agent: { identity_id: 'agent-1', api_key: API_KEY, device_id: 'dev', app_version: 'claude-openmax/test' },
    orgs: { [ORG]: { org_id: ORG, owner: { member_id: OWNER, name: 'Owner' }, self: { member_id: 'self-member', name: 'Bot' }, access: {} } },
  }, { logger: silent });
  return buildRuntime({
    config, file: path.join(dataDir, 'config.json'), storage: createFileStorage({ dataDir }), logger: silent,
    httpClient: fakeHttp.current,
  });
}

// Default inbox: the owner's DM (seq 1) arrived after onboarding, before the first channel session.
const DM_ONLY = [{ seq: 1, conversation_id: 'C1', message_id: 'M1' }];
// The inbox starts with a seq that is not a deliverable message (no message_id).
const NON_MESSAGE_FIRST = [{ seq: 1, conversation_id: 'C1' }, { seq: 2, conversation_id: 'C1', message_id: 'M1' }];

function makeFakeHttp(inbox = DM_ONLY) {
  const calls = [];
  const http = {
    calls,
    apiPath: (p) => `/api/v1${p}`,
    async getForOrg(_org, p) {
      calls.push(['GET', p]);
      if (p.endsWith('/me')) return { identity_id: 'agent-1', display_name: 'Bot' };
      if (p === '/api/v1/conversations/C1/messages/M1') {
        const seq = inbox.find((e) => e.message_id === 'M1').seq;
        return { id: 'M1', conversation_id: 'C1', sender_id: OWNER, sender_type: 'HUMAN', type: 'TEXT', inbox_seq: seq, seq, content: { content_type: 'text', body: { text: 'hello?' } } };
      }
      if (p === '/api/v1/conversations/C1') return { id: 'C1', type: 'dm' };
      return {};
    },
    async postForOrg(_org, p, body) {
      calls.push(['POST', p, body]);
      if (p === '/api/v1/sync') {
        const events = inbox.filter((e) => e.seq > body.since_seq);
        return events.length
          ? { events, next_cursor: String(events.at(-1).seq), has_more: false }
          : { events: [], has_more: false };
      }
      return {};
    },
    async post(p, body) { calls.push(['POST', p, body]); return {}; },
    async putForOrg() { return {}; },
  };
  return http;
}
const fakeHttp = { current: null };

async function firstChannelSession(dataDir, { inbox, holdMs = 20, inspect } = {}) {
  fakeHttp.current = makeFakeHttp(inbox);
  const rt = runtime(dataDir);
  const delivered = [];
  const sock = new EventEmitter();
  sock.close = () => {};
  sock.send = () => {};
  const bridge = new CwsAgentBridge({
    http: fakeHttp.current,
    ws: { baseUrl: 'wss://comm.example/ws', urlProvider: async () => 'wss://comm.example/ws?ticket=t', wsFactory: () => { setImmediate(() => sock.emit('open')); return sock; } },
    orgConfigs: rt.orgConfigs,
    providers: { storage: createFileStorage({ dataDir }), logger: silent, inbound: { deliver: async (m) => { delivered.push(m.messageId); return { ok: true }; } } },
    callbacks: rt.callbacks,
    reporters: { metrics: false, frameMetrics: false, markReadOnDeliver: false },
  });
  rt.firstSync.bindLedgers(ledgerAccessor(bridge));   // what createBridge() does
  await bridge.start();
  for (let i = 0; i < 100 && !fakeHttp.current.calls.some(([m, p]) => m === 'POST' && p === '/api/v1/sync/ack'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, holdMs));
  const state = inspect ? inspect(bridge) : undefined;
  await bridge.stop();
  return { delivered, calls: fakeHttp.current.calls, state };
}

test('first channel session after onboarding delivers the DM sent before it started (real SDK pipeline)', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, identityId: 'agent-1', orgIds: [ORG] });
  const { delivered, calls } = await firstChannelSession(dir);
  const syncs = calls.filter(([m, p]) => m === 'POST' && p === '/api/v1/sync');
  assert.equal(Number(syncs[0][2].since_seq), 0, '/sync starts at the beginning of the inbox');
  assert.match(JSON.stringify(syncs[0][2]), /"since_seq":0[,}]/, 'sent on the wire as the number 0');
  assert.deepEqual(delivered, ['M1'], 'the owner DM reaches the session');
  const session = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${ORG}.json`), 'utf8'));
  assert.equal(session.sync_seq, 1, 'a real cursor is persisted');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, FIRST_SYNC_KEY), 'utf8')).done, [ORG], 'marker spent');

  // The next session resumes from the cursor and does not redeliver.
  const again = await firstChannelSession(dir);
  assert.deepEqual(again.delivered, []);
});

test('without the onboarding marker the SDK still seeks to the inbox end (no history replay for existing identities)', async () => {
  const dir = tmpDir();
  const { delivered, calls } = await firstChannelSession(dir);
  assert.deepEqual(delivered, [], 'old inbox content is not replayed');
  assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/sync'), 'the SDK init /sync ran');
});

const syncCount = (calls) => calls.filter(([m, p]) => m === 'POST' && p === '/api/v1/sync').length;
const ledgerState = (bridge) => {
  const l = bridge._orgs.get(ORG).ledger;
  return { acked: l.getAckedSeq(), pendingBelow: [1, 2].filter((n) => !l.has(n)) };
};

test('inbox starting with a non-message seq: the first catch-up advances the ledger past it (no gap left)', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [ORG] });
  const { delivered, calls, state } = await firstChannelSession(dir, { inbox: NON_MESSAGE_FIRST, holdMs: 100, inspect: ledgerState });
  assert.deepEqual(delivered, ['M1']);
  assert.equal(syncCount(calls), 1);
  assert.equal(state.acked, 2, 'watermark advanced to the swept cursor (1.3.3 first cut left it at 0)');
  assert.deepEqual(state.pendingBelow, [], 'no hole for the gap timer to chase');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, `inbox-${ORG}.json`), 'utf8'));
  assert.equal(persisted.acked_seq, 2);
});

test('inbox starting with a non-message seq: exactly ONE /sync over 22 s (the gap timer never re-sweeps from 0)', { timeout: 60000 }, async () => {
  // The ledger ticks every 5 s and re-syncs a gap older than 10 s, so a leftover
  // hole shows up as a second /sync at the ~20 s tick.
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, orgIds: [ORG] });
  const { delivered, calls, state } = await firstChannelSession(dir, { inbox: NON_MESSAGE_FIRST, holdMs: 22000, inspect: ledgerState });
  assert.deepEqual(delivered, ['M1']);
  assert.equal(syncCount(calls), 1, `expected a single /sync, saw ${syncCount(calls)}`);
  assert.equal(state.acked, 2);
});

test('createBridge binds the started bridge\'s inbox ledgers to first-sync', () => {
  let bound = null;
  const rt = runtime(tmpDir());
  rt.firstSync.bindLedgers = (fn) => { bound = fn; };
  const bridge = createBridge({ runtime: rt, inbound: { deliver: async () => ({ ok: true }) }, storage: createFileStorage({ dataDir: tmpDir() }), runtimeState: {}, logger: silent, wsConfig: rt.wsConfig });
  assert.equal(typeof bound, 'function');
  const fake = { setAckedSeq() {} };
  bridge._orgs.set(ORG, { ledger: fake });
  assert.equal(bound(ORG), fake, 'resolves the SDK per-org ledger');
  assert.equal(bound('nope'), null);
});
