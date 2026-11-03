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
import {
  FIRST_SYNC_KEY, inboxStartCursor, writeFirstSyncMarker, createFirstSync,
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

test('marker: pending for the onboarded api_key only, retired per org once a real cursor is saved', async () => {
  const dir = tmpDir();
  assert.equal(writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, identityId: 'id-1', now: 0 }), true);
  assert.equal(fs.statSync(path.join(dir, FIRST_SYNC_KEY)).mode & 0o777, 0o600);
  const storage = createFileStorage({ dataDir: dir });

  const other = createFirstSync({ storage, apiKey: 'cwsk_some_other_key', logger: silent });
  assert.equal(await other.initialCursor(ORG), null, 'a different identity ignores the marker');

  const fs1 = createFirstSync({ storage, apiKey: API_KEY, logger: silent });
  assert.ok(await fs1.initialCursor(ORG));
  await fs1.cursorSaved(ORG, inboxStartCursor());   // not a real cursor
  await fs1.cursorSaved(ORG, 0);
  assert.ok(await fs1.initialCursor(ORG), 'still pending');
  await fs1.cursorSaved(ORG, 3);
  assert.equal(await fs1.initialCursor(ORG), null, 'spent for this org');
  assert.ok(await fs1.initialCursor('org-2'), 'other orgs keep theirs');
});

test('no marker → loadSession keeps the SDK default (empty session → seek to the inbox end)', async () => {
  const dir = tmpDir();
  const rt = runtime(dir);
  assert.deepEqual(await rt.callbacks.loadSession(ORG), {});
});

test('marker + existing session → the existing cursor wins; saveSession retires the marker', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY });
  const rt = runtime(dir);
  const first = await rt.callbacks.loadSession(ORG);
  assert.ok(first.sync_seq && !(first.sync_seq > 0), 'start-of-inbox cursor');
  await rt.callbacks.saveSession(ORG, { sync_seq: 4 });
  assert.deepEqual(await rt.callbacks.loadSession(ORG), { sync_seq: 4 });
  // Even after the local session is purged, the spent marker never replays the inbox again.
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

// The inbox: the owner's DM (seq 1) arrived after onboarding, before the first channel session.
function makeFakeHttp() {
  const calls = [];
  const http = {
    calls,
    apiPath: (p) => `/api/v1${p}`,
    async getForOrg(_org, p) {
      calls.push(['GET', p]);
      if (p.endsWith('/me')) return { identity_id: 'agent-1', display_name: 'Bot' };
      if (p === '/api/v1/conversations/C1/messages/M1') {
        return { id: 'M1', conversation_id: 'C1', sender_id: OWNER, sender_type: 'HUMAN', type: 'TEXT', inbox_seq: 1, seq: 1, content: { content_type: 'text', body: { text: 'hello?' } } };
      }
      if (p === '/api/v1/conversations/C1') return { id: 'C1', type: 'dm' };
      return {};
    },
    async postForOrg(_org, p, body) {
      calls.push(['POST', p, body]);
      if (p === '/api/v1/sync') {
        return body.since_seq < 1
          ? { events: [{ seq: 1, conversation_id: 'C1', message_id: 'M1' }], next_cursor: '1', has_more: false }
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

async function firstChannelSession(dataDir) {
  fakeHttp.current = makeFakeHttp();
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
  await bridge.start();
  for (let i = 0; i < 100 && !fakeHttp.current.calls.some(([m, p]) => m === 'POST' && p === '/api/v1/sync/ack'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));
  await bridge.stop();
  return { delivered, calls: fakeHttp.current.calls };
}

test('first channel session after onboarding delivers the DM sent before it started (real SDK pipeline)', async () => {
  const dir = tmpDir();
  writeFirstSyncMarker({ dataDir: dir, apiKey: API_KEY, identityId: 'agent-1' });
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
