import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';
import { utimesSync, readdirSync } from 'node:fs';

import { resolveChannelActivation, argvLoadsChannel, acquireChannelLock, decideChannelRole } from '../src/channel-gate.js';
import { ClaudeChannel } from '../src/channel.js';
import { createInboundDelivery } from '../src/inbound-delivery.js';

const noArgv = () => [];

test('CLAUDE_OPENMAX_CHANNEL=1 activates the channel', () => {
  assert.deepEqual(resolveChannelActivation({ env: { CLAUDE_OPENMAX_CHANNEL: '1' }, parentArgv: noArgv }), { active: true, source: 'env' });
});

test('unset env and no channel flag on the parent → inactive (plain claude / claude -p)', () => {
  assert.deepEqual(resolveChannelActivation({ env: {}, parentArgv: () => ['claude', '-p', 'hi'] }), { active: false, source: 'none' });
});

test('CLAUDE_OPENMAX_CHANNEL=0 forces inactive even with the flag on the parent', () => {
  const argv = () => ['claude', '--dangerously-load-development-channels', 'plugin:openmax-channel@openmax'];
  assert.equal(resolveChannelActivation({ env: { CLAUDE_OPENMAX_CHANNEL: '0' }, parentArgv: argv }).active, false);
});

test('fallback: env unset but parent argv loads this plugin channel → active (source parent-argv)', () => {
  const argv = () => ['node', '/x/claude', '--dangerously-load-development-channels', 'plugin:openmax-channel@openmax'];
  assert.deepEqual(resolveChannelActivation({ env: {}, parentArgv: argv }), { active: true, source: 'parent-argv' });
});

test('argvLoadsChannel only matches a channel flag naming openmax-channel', () => {
  assert.equal(argvLoadsChannel(['claude', '--channels', 'plugin:openmax-channel@openmax']), true);
  assert.equal(argvLoadsChannel(['claude', '--channels=plugin:openmax-channel@openmax']), true);
  assert.equal(argvLoadsChannel(['claude', '--dangerously-load-development-channels', 'plugin:other@x']), false);
  assert.equal(argvLoadsChannel(['claude', 'openmax-channel']), false);
  assert.equal(argvLoadsChannel(null), false);
});

const tmp = () => mkdtempSync(path.join(tmpdir(), 'claude-openmax-lock-'));

test('channel lock: first acquirer wins, a live second one is refused with the holder pid', () => {
  const dataDir = tmp();
  const a = acquireChannelLock({ dataDir, pid: 1111, isAlive: () => true });
  assert.equal(a.acquired, true);
  assert.equal(readFileSync(a.path, 'utf8').trim(), '1111');
  const b = acquireChannelLock({ dataDir, pid: 2222, isAlive: (p) => p === 1111 });
  assert.equal(b.acquired, false);
  assert.equal(b.holderPid, 1111);
  a.release();
  assert.equal(existsSync(a.path), false);
  const c = acquireChannelLock({ dataDir, pid: 2222, isAlive: () => true });
  assert.equal(c.acquired, true);
});

test('channel lock: a stale lock (holder pid gone) is taken over', () => {
  const dataDir = tmp();
  writeFileSync(path.join(dataDir, 'channel.lock'), '999999\n');
  const r = acquireChannelLock({ dataDir, pid: 3333, isAlive: () => false });
  assert.equal(r.acquired, true);
  assert.equal(readFileSync(r.path, 'utf8').trim(), '3333');
});

test('channel lock: release never deletes a successor\'s lock', () => {
  const dataDir = tmp();
  const a = acquireChannelLock({ dataDir, pid: 4444, isAlive: () => false });
  writeFileSync(a.path, '5555\n'); // someone else took it over
  a.release();
  assert.equal(readFileSync(a.path, 'utf8').trim(), '5555');
});

test('channel lock with the real pid check: our own live pid blocks a different pid', () => {
  const dataDir = tmp();
  const a = acquireChannelLock({ dataDir });
  assert.equal(a.acquired, true);
  const b = acquireChannelLock({ dataDir, pid: process.pid + 100000 });
  assert.equal(b.acquired, false);
  assert.equal(b.holderPid, process.pid);
  a.release();
});

test('delivery disabled → notifyWake throws runtime_unavailable → InboundDelivery returns ok:false (no ack)', async () => {
  const ch = new ClaudeChannel({ name: 'openmax' });
  ch._connected = true; // pretend stdio is up: the gate must still refuse
  let sent = 0;
  ch.server.notification = async () => { sent++; };
  ch.setDeliveryEnabled(false, 'channel not active in this session');
  await assert.rejects(() => ch.notifyWake([{ messageId: 'm', conversationId: 'c', contentPreview: 'x' }]),
    (e) => e.failureClass === 'runtime_unavailable' && /channel not active/.test(e.message));
  assert.equal(sent, 0);

  const del = createInboundDelivery({ wake: (req) => ch.notifyWake(req) });
  const res = await del.deliver({ messageId: 'm', conversationId: 'c', text: 'hi' });
  assert.equal(res.ok, false);
  assert.equal(res.failureClass, 'runtime_unavailable');

  ch.setDeliveryEnabled(true);
  await ch.notifyWake([{ messageId: 'm', conversationId: 'c', contentPreview: 'x' }]);
  assert.equal(sent, 1);
});

test('a young lock file without a pid is treated as held (never stolen mid-write)', () => {
  const dataDir = tmp();
  writeFileSync(path.join(dataDir, 'channel.lock'), '');
  const r = acquireChannelLock({ dataDir, pid: 7777, isAlive: () => false });
  assert.equal(r.acquired, false);
  assert.match(r.reason, /being written/);
});

test('an OLD lock file without a pid is debris and is taken over', () => {
  const dataDir = tmp();
  const f = path.join(dataDir, 'channel.lock');
  writeFileSync(f, '');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(f, old, old);
  const r = acquireChannelLock({ dataDir, pid: 7778, isAlive: () => false });
  assert.equal(r.acquired, true);
  assert.equal(readFileSync(f, 'utf8').trim(), '7778');
});

test('lock file is never left without a pid and no temp/stale files linger', () => {
  const dataDir = tmp();
  const a = acquireChannelLock({ dataDir, pid: 8001, isAlive: () => false });
  assert.equal(readFileSync(a.path, 'utf8'), '8001\n');
  writeFileSync(a.path, '8001\n');
  const b = acquireChannelLock({ dataDir, pid: 8002, isAlive: () => false }); // 8001 "dead" → takeover
  assert.equal(b.acquired, true);
  assert.deepEqual(readdirSync(dataDir).sort(), ['channel.lock']);
});

const GATE = new URL('../src/channel-gate.js', import.meta.url).href;

test('race: 8 processes contending (over a stale lock) → exactly one holder', async () => {
  const dataDir = tmp();
  writeFileSync(path.join(dataDir, 'channel.lock'), '999999\n'); // stale holder
  // Every child keeps running (so a winner's pid stays alive) until the parent
  // has collected ALL answers and closes their stdin — a slow-starting child can
  // therefore never see the winner already gone and legitimately win "later".
  const script = `import { acquireChannelLock } from ${JSON.stringify(GATE)};
    const go = Number(process.argv[1]); while (Date.now() < go) {}
    const r = acquireChannelLock({ dataDir: ${JSON.stringify(dataDir)} });
    process.stdout.write(r.acquired ? 'WIN\\n' : 'LOSE\\n');
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const go = Date.now() + 1500;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, String(go)], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const answers = await Promise.all(children.map((c) => new Promise((resolve) => {
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
    c.on('exit', () => resolve(out.trim() || 'EXIT'));
  })));
  for (const c of children) c.stdin.end();
  assert.equal(answers.filter((r) => r === 'WIN').length, 1, answers.join(','));
});

test('decideChannelRole: inactive or lock busy → no WS and no delivery, in BOTH modes', () => {
  for (const mode of ['inproc', 'channel-only']) {
    assert.deepEqual(
      { ...decideChannelRole({ mode, active: false, lockAcquired: true }), reason: undefined },
      { wsEnabled: false, deliveryEnabled: false, reason: undefined }, `${mode} inactive`);
    const busy = decideChannelRole({ mode, active: true, lockAcquired: false });
    assert.equal(busy.deliveryEnabled, false, `${mode} lock busy`);
    assert.equal(busy.wsEnabled, false);
  }
});

test('decideChannelRole: active + lock → inproc opens the WS; channel-only only accepts wakes', () => {
  assert.deepEqual(decideChannelRole({ mode: 'inproc', active: true, lockAcquired: true }), { wsEnabled: true, deliveryEnabled: true, reason: '' });
  assert.deepEqual(decideChannelRole({ mode: 'channel-only', active: true, lockAcquired: true }), { wsEnabled: false, deliveryEnabled: true, reason: '' });
});
