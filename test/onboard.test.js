import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  ALLOW_RULES, CHANNEL_REF, GREETING_PROMPT,
  mergePermissions, checkSettingsEditable, mergeIncomingConfig, parseIncomingConfig,
  buildLaunchCommand, chooseLaunchMode, launchInTmux, cleanEnv, shellQuote, runOnboard, writeFileAtomic,
} from '../scripts/onboard.js';
import { symlinkSync, lstatSync, chmodSync } from 'node:fs';
import { registerAndAccept } from '../hooks/auto-register.js';

const tmp = (p = 'claude-openmax-onboard-') => mkdtempSync(path.join(tmpdir(), p));

// ── permission rules ──────────────────────────────────────────────────────

test('ALLOW_RULES is exactly comm/comm_send/tm/kb/core under the plugin MCP prefix (no as/conn)', () => {
  assert.deepEqual(ALLOW_RULES, [
    'mcp__plugin_openmax-channel_openmax__comm',
    'mcp__plugin_openmax-channel_openmax__comm_send',
    'mcp__plugin_openmax-channel_openmax__tm',
    'mcp__plugin_openmax-channel_openmax__kb',
    'mcp__plugin_openmax-channel_openmax__core',
  ]);
  assert.ok(!ALLOW_RULES.some((r) => /__(as|conn)$/.test(r)));
});

test('rule names match the real plugin/server/tool names', async () => {
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const server = Object.keys(plugin.mcpServers)[0];
  const { createMcpTools } = await import('../src/mcp-tools.js');
  const stub = Object.fromEntries(['tm', 'kb', 'as', 'comm', 'core', 'conn'].map((k) => [k, {}]));
  const toolNames = createMcpTools({ services: stub }).defs.map((d) => d.name);
  for (const rule of ALLOW_RULES) {
    const m = rule.match(/^mcp__plugin_(.+?)_(.+?)__(.+)$/);
    assert.equal(m[1], plugin.name);
    assert.equal(m[2], server);
    assert.ok(toolNames.includes(m[3]), `${m[3]} is a real tool`);
  }
});

test('mergePermissions creates settings.json when absent (no backup needed)', () => {
  const file = path.join(tmp(), 'nested', 'settings.json');
  const r = mergePermissions(file, ALLOW_RULES, 0);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ALLOW_RULES } });
});

test('mergePermissions is append-only: keeps other keys + existing rules order, backs up first, no duplicates', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const original = { model: 'opus', permissions: { allow: ['Bash(ls:*)', ALLOW_RULES[1]], deny: ['Read(.env)'] }, hooks: { x: 1 } };
  writeFileSync(file, JSON.stringify(original));
  const r = mergePermissions(file, ALLOW_RULES, Date.UTC(2026, 10, 2, 12, 0, 0));
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ALLOW_RULES.filter((x) => x !== ALLOW_RULES[1]));
  const out = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.hooks, { x: 1 });
  assert.deepEqual(out.permissions.deny, ['Read(.env)']);
  assert.deepEqual(out.permissions.allow.slice(0, 2), ['Bash(ls:*)', ALLOW_RULES[1]]);
  assert.equal(out.permissions.allow.length, 2 + 4);
  assert.ok(r.backup.endsWith('settings.json.bak-openmax-20261102T120000Z'));
  assert.deepEqual(JSON.parse(readFileSync(r.backup, 'utf8')), original);

  // idempotent: second run changes nothing and makes no second backup
  const r2 = mergePermissions(file, ALLOW_RULES, Date.UTC(2026, 10, 2, 13, 0, 0));
  assert.equal(r2.changed, false);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-openmax-')).length, 1);
});

test('mergePermissions refuses a corrupt settings.json and leaves it untouched', () => {
  const file = path.join(tmp(), 'settings.json');
  writeFileSync(file, '{ "permissions": { "allow": [ ');
  assert.throws(() => mergePermissions(file), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ "permissions": { "allow": [ ');
});

test('checkSettingsEditable refuses a non-array permissions.allow', () => {
  const file = path.join(tmp(), 'settings.json');
  writeFileSync(file, JSON.stringify({ permissions: { allow: 'mcp__x' } }));
  assert.throws(() => checkSettingsEditable(file), /permissions\.allow" is not an array/);
});

// ── config merge ──────────────────────────────────────────────────────────────

const incoming = () => ({
  server: { bff_url: 'https://core.test', ws_url: 'wss://ws.test' },
  agent: { identity_id: '', api_key: '', device_id: 'dev-1' },
  orgs: { o1: { org_id: 'o1', owner: { member_id: 'own', name: 'Gavin' } } },
  invite: { invitation_id: 'inv-1', token: 'tok-1' },
});

test('mergeIncomingConfig keeps an existing registration for the same server + org (re-run)', () => {
  const existing = { server: { bff_url: 'https://core.test/' }, agent: { identity_id: 'id-1', api_key: 'cwsk_live' }, orgs: { o1: { org_id: 'o1', self: { member_id: 'm1' } } } };
  const { config, preserved } = mergeIncomingConfig(existing, incoming());
  assert.equal(preserved, true);
  assert.equal(config.agent.api_key, 'cwsk_live');
  assert.equal(config.orgs.o1.self.member_id, 'm1');
  assert.deepEqual(config.invite, { invitation_id: 'inv-1', token: 'tok-1' });
  assert.equal(config.server.ws_url, 'wss://ws.test');
});

test('mergeIncomingConfig replaces the config for a different server, a new org, or no key', () => {
  const base = { server: { bff_url: 'https://core.test' }, agent: { api_key: 'cwsk_live' }, orgs: { o1: {} } };
  assert.equal(mergeIncomingConfig({ ...base, server: { bff_url: 'https://other' } }, incoming()).preserved, false);
  assert.equal(mergeIncomingConfig({ ...base, orgs: { o2: {} } }, incoming()).preserved, false);
  assert.equal(mergeIncomingConfig({ ...base, agent: { api_key: 'cwsk_replace_me' } }, incoming()).preserved, false);
  assert.equal(mergeIncomingConfig(undefined, incoming()).preserved, false);
});

test('parseIncomingConfig rejects non-JSON and configs without bff_url/orgs (exit code 2)', () => {
  assert.throws(() => parseIncomingConfig('nope'), (e) => e.code === 2);
  assert.throws(() => parseIncomingConfig('{"orgs":{"a":{}}}'), (e) => e.code === 2 && /bff_url/.test(e.reason));
  assert.throws(() => parseIncomingConfig('{"server":{"bff_url":"x"},"orgs":{}}'), (e) => e.code === 2 && /orgs/.test(e.reason));
});

// ── launch command + mode ────────────────────────────────────────────────────

test('buildLaunchCommand: channel env + flag + plugin ref + quoted greeting, no resume', () => {
  const cmd = buildLaunchCommand({ env: {} });
  assert.ok(cmd.startsWith('CLAUDE_OPENMAX_CHANNEL=1 claude --dangerously-load-development-channels plugin:openmax-channel@openmax '));
  assert.ok(cmd.endsWith(shellQuote(GREETING_PROMPT)));
  assert.ok(!/--continue|--resume/.test(cmd), 'the new session does not resume the old conversation');
  assert.equal(CHANNEL_REF, 'plugin:openmax-channel@openmax');
});

test('buildLaunchCommand(stripEnv) unsets the "already running" markers and forwards location overrides', () => {
  const cmd = buildLaunchCommand({ claudeBin: '/opt/bin/claude', stripEnv: true, env: { CLAUDE_CONFIG_DIR: '/h/my dir', CLAUDECODE: '1' } });
  assert.ok(cmd.startsWith('env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT '));
  assert.ok(cmd.includes("CLAUDE_CONFIG_DIR='/h/my dir'"));
  assert.ok(cmd.includes('CLAUDE_OPENMAX_CHANNEL=1 /opt/bin/claude --dangerously-load-development-channels'));
});

test('shellQuote survives single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('cleanEnv strips CLAUDECODE + CLAUDE_CODE_ENTRYPOINT only', () => {
  assert.deepEqual(cleanEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/bin' }), { PATH: '/bin' });
});

test('chooseLaunchMode: tmux window inside tmux, detached session outside, manual otherwise', () => {
  assert.equal(chooseLaunchMode({ env: { TMUX: '/tmp/t,1,0' }, platform: 'linux', tmuxAvailable: true }).mode, 'tmux-window');
  assert.equal(chooseLaunchMode({ env: {}, platform: 'darwin', tmuxAvailable: true }).mode, 'tmux-session');
  assert.equal(chooseLaunchMode({ env: {}, platform: 'darwin', tmuxAvailable: false }).mode, 'manual');
  assert.equal(chooseLaunchMode({ env: {}, platform: 'win32', tmuxAvailable: true }).mode, 'manual');
  assert.equal(chooseLaunchMode({ env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, platform: 'linux', tmuxAvailable: true }).mode, 'manual');
  assert.equal(chooseLaunchMode({ env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, platform: 'linux', tmuxAvailable: true }).mode, 'tmux-session');
});

const NO_SETTLE = { settleMs: 0, delay: async () => {} };

function fakeExec(responses = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = `${cmd} ${args[0] || ''}`;
    const r = responses[key];
    return typeof r === 'function' ? r(args) : (r || { status: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

test('launchInTmux inside tmux opens a new window running the channel command (env cleaned, no send-keys)', async () => {
  const { exec, calls } = fakeExec({ 'tmux list-windows': { status: 0, stdout: 'main\n' } });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-window', cwd: '/work', env: { TMUX: 'x', CLAUDECODE: '1' }, exec, claudeBin: 'claude' });
  assert.deepEqual(r, { launched: true, mode: 'tmux-window', reused: false });
  const nw = calls.find((c) => c.args[0] === 'new-window');
  assert.deepEqual(nw.args.slice(0, 8), ['new-window', '-P', '-F', '#{window_id}', '-n', 'openmax', '-c', '/work']);
  assert.ok(nw.args[8].includes('CLAUDE_OPENMAX_CHANNEL=1'));
  assert.equal(nw.env.CLAUDECODE, undefined);
  assert.ok(!calls.some((c) => c.args.includes('send-keys')));
});

test('launchInTmux reuses an existing "openmax" window instead of starting a second session', async () => {
  const { exec, calls } = fakeExec({ 'tmux list-windows': { status: 0, stdout: 'main\nopenmax\n' } });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-window', cwd: '/w', env: { TMUX: 'x' }, exec });
  assert.equal(r.reused, true);
  assert.ok(calls.some((c) => c.args[0] === 'select-window'));
  assert.ok(!calls.some((c) => c.args[0] === 'new-window'));
});

test('launchInTmux outside tmux starts a detached "openmax" session and returns the attach command', async () => {
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 1 } });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-session', cwd: '/w', env: {}, exec });
  assert.equal(r.launched, true);
  assert.equal(r.attach, 'tmux attach -t openmax');
  assert.deepEqual(calls.find((c) => c.args[0] === 'new-session').args.slice(0, 6), ['new-session', '-d', '-s', 'openmax', '-c', '/w']);
});

test('launchInTmux reuses an existing detached session', async () => {
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 0 } });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-session', cwd: '/w', env: {}, exec });
  assert.equal(r.reused, true);
  assert.ok(!calls.some((c) => c.args[0] === 'new-session'));
});

// ── end-to-end runOnboard (real registerAndAccept, mocked fetch) ───────────────

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } });

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}

const happyServer = (url) => {
  if (url.endsWith('/auth/register/agent')) return jsonRes(200, { data: { identity_id: 'id-new', api_key: 'cwsk_secret_value' } });
  if (url.endsWith('/auth/agent/token')) return jsonRes(200, { data: { access_token: 'acc-tok' } });
  if (url.includes('/invitations/inv-1/accept')) return jsonRes(200, { data: { member_id: 'm1' } });
  return jsonRes(404, {});
};

function setup() {
  const dir = tmp();
  const cfgPath = path.join(dir, 'cfg', 'config.json');
  const claudeDir = path.join(dir, 'claude');
  return { dir, cfgPath, claudeDir, env: { HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, PATH: '/usr/bin' } };
}

async function onboard(s, { argv = ['--launch'], stdinText = JSON.stringify(incoming()), env = s.env, exec, register, fetchImpl = happyServer } = {}) {
  const lines = [];
  const fx = exec || fakeExec({ 'tmux has-session': { status: 1 }, 'claude --version': { status: 0, stdout: '2.1.308 (Claude Code)\n' } }).exec;
  const code = await withEnv({ CLAUDE_OPENMAX_CONFIG: s.cfgPath }, () => withFetch(fetchImpl, (calls) => runOnboard({
    argv, stdinText, env, cwd: s.dir, platform: 'linux', print: (l) => lines.push(l), exec: fx,
    register: register || ((o) => registerAndAccept({ ...o, backoffMs: [1] })),
    now: Date.UTC(2026, 10, 2), launchOpts: NO_SETTLE,
  }).then((c) => { lines.fetchCalls = calls; return c; })));
  return { code, lines, out: lines.join('\n') };
}

test('runOnboard happy path: 0600 config, registered + accepted, rules merged, tmux session, ONBOARD OK then RESTART_COMMAND last', async () => {
  const s = setup();
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 1 }, 'claude --version': { status: 0, stdout: '2.1.308\n' } });
  const { code, lines, out } = await onboard(s, { exec });
  assert.equal(code, 0, out);
  assert.equal(statSync(s.cfgPath).mode & 0o777, 0o600);
  const cfg = JSON.parse(readFileSync(s.cfgPath, 'utf8'));
  assert.equal(cfg.agent.api_key, 'cwsk_secret_value');
  assert.equal(cfg.invite, undefined, 'invite cleared after accept');
  const settings = JSON.parse(readFileSync(path.join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ALLOW_RULES);
  const okIdx = lines.indexOf('ONBOARD OK');
  assert.ok(okIdx > 0);
  assert.equal(lines[okIdx + 1], 'LAUNCH: tmux-session');
  assert.ok(lines[okIdx + 2].startsWith('NEXT: Run `tmux attach -t openmax`'));
  assert.ok(lines.at(-1).startsWith('RESTART_COMMAND: '));
  assert.ok(lines.at(-1).includes('CLAUDE_OPENMAX_CHANNEL=1 claude --dangerously-load-development-channels plugin:openmax-channel@openmax'));
  assert.ok(calls.some((c) => c.cmd === 'tmux' && c.args[0] === 'new-session'));
  assert.ok(!out.includes('cwsk_secret_value'), 'never prints the api_key');
  assert.ok(!out.includes('tok-1'), 'never prints the invitation token');
});

test('runOnboard without --launch prints the restart command and launches nothing', async () => {
  const s = setup();
  const { exec, calls } = fakeExec();
  const { code, lines } = await onboard(s, { argv: [], exec });
  assert.equal(code, 0);
  assert.ok(lines.includes('LAUNCH: none'));
  assert.ok(!calls.some((c) => c.cmd === 'tmux'));
});

test('runOnboard without tmux falls back to LAUNCH: manual with the exact command', async () => {
  const s = setup();
  const { exec } = fakeExec({ 'tmux -V': { status: null, error: new Error('ENOENT') } });
  const { code, lines } = await onboard(s, { exec });
  assert.equal(code, 0);
  assert.ok(lines.includes('LAUNCH: manual'));
  assert.ok(lines.at(-1).includes('--dangerously-load-development-channels plugin:openmax-channel@openmax'));
});

test('runOnboard: register failure → ONBOARD FAILED, exit 1, nothing launched, settings untouched', async () => {
  const s = setup();
  const { exec, calls } = fakeExec();
  const { code, lines } = await onboard(s, { exec, fetchImpl: () => jsonRes(503, { error: 'down' }) });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), 'ONBOARD FAILED: POST /auth/register/agent: HTTP 503: {"error":"down"}');
  assert.ok(!lines.includes('ONBOARD OK'));
  assert.ok(!calls.some((c) => c.cmd === 'tmux'));
  assert.equal(existsSync(path.join(s.claudeDir, 'settings.json')), false);
});

test('runOnboard: register is retried within the budget (transient 503 then success)', async () => {
  const s = setup();
  let n = 0;
  const flaky = (url) => (url.endsWith('/auth/register/agent') && n++ < 2 ? jsonRes(503, {}) : happyServer(url));
  const { code, out } = await onboard(s, { fetchImpl: flaky });
  assert.equal(code, 0, out);
  assert.equal(n, 3);
});

test('runOnboard: accept failure → FAILED and the invite is kept for retry', async () => {
  const s = setup();
  const fetchImpl = (url) => (url.includes('/accept') ? jsonRes(410, { error: { detail: 'expired' } }) : happyServer(url));
  const { code, lines } = await onboard(s, { fetchImpl });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /^ONBOARD FAILED: POST \/api\/v1\/invitations\/<id>\/accept: HTTP 410/);
  assert.ok(JSON.parse(readFileSync(s.cfgPath, 'utf8')).invite);
});

test('runOnboard: corrupt settings.json fails in preflight BEFORE any network call', async () => {
  const s = setup();
  mkdirSync(s.claudeDir, { recursive: true });
  writeFileSync(path.join(s.claudeDir, 'settings.json'), '{broken');
  let registered = false;
  const { code, lines } = await onboard(s, { register: async () => { registered = true; return { status: 'changed' }; } });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /^ONBOARD FAILED: preflight: .*not valid JSON/);
  assert.equal(registered, false);
  assert.equal(existsSync(s.cfgPath), false, 'config not written either');
});

test('runOnboard: invalid stdin JSON → exit 2', async () => {
  const s = setup();
  const { code, lines } = await onboard(s, { stdinText: '{nope' });
  assert.equal(code, 2);
  assert.match(lines.at(-1), /^ONBOARD FAILED: config: stdin is not valid JSON/);
});

test('runOnboard re-run of the same invitation is idempotent: key kept, no re-register, no duplicate rules', async () => {
  const s = setup();
  assert.equal((await onboard(s)).code, 0);
  const key1 = JSON.parse(readFileSync(s.cfgPath, 'utf8')).agent.api_key;
  const second = await onboard(s);
  assert.equal(second.code, 0, second.out);
  assert.ok(second.lines.includes('[onboard] already onboarded'), second.out);
  assert.ok(!second.lines.fetchCalls.some((c) => c.url.endsWith('/auth/register/agent')), 'must not register a second identity');
  assert.equal(JSON.parse(readFileSync(s.cfgPath, 'utf8')).agent.api_key, key1);
  const settings = JSON.parse(readFileSync(path.join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.permissions.allow.length, ALLOW_RULES.length);
});

test('runOnboard replacing a registered config for a different server backs the old one up (0600)', async () => {
  const s = setup();
  mkdirSync(path.dirname(s.cfgPath), { recursive: true });
  writeFileSync(s.cfgPath, JSON.stringify({ server: { bff_url: 'https://old' }, agent: { api_key: 'cwsk_old' }, orgs: { z: {} } }));
  const { code } = await onboard(s);
  assert.equal(code, 0);
  const bak = readdirSync(path.dirname(s.cfgPath)).find((f) => f.startsWith('config.json.bak-openmax-'));
  assert.ok(bak);
  assert.equal(statSync(path.join(path.dirname(s.cfgPath), bak)).mode & 0o777, 0o600);
});

test('runOnboard --no-stdin with no existing config → exit 2', async () => {
  const s = setup();
  const { code, lines } = await onboard(s, { argv: ['--no-stdin'], stdinText: '' });
  assert.equal(code, 2);
  assert.match(lines.at(-1), /no config on stdin/);
});

test('runOnboard warns (does not fail) on Bedrock', async () => {
  const s = setup();
  const { code, out } = await onboard(s, { env: { ...s.env, CLAUDE_CODE_USE_BEDROCK: '1' } });
  assert.equal(code, 0);
  assert.match(out, /not available on Amazon Bedrock/);
});

// ── never reuse a running session that holds an old identity ─────────────────

test('launchInTmux(allowReuse=false) reports an existing session as stale and starts/kills nothing', async () => {
  for (const [mode, key, env] of [['tmux-session', 'tmux has-session', {}], ['tmux-window', 'tmux list-windows', { TMUX: 'x' }]]) {
    const { exec, calls } = fakeExec({ [key]: { status: 0, stdout: 'openmax\n' } });
    const r = await launchInTmux({ ...NO_SETTLE, mode, cwd: '/w', env, exec, allowReuse: false });
    assert.equal(r.launched, false);
    assert.equal(r.stale, true);
    assert.ok(!calls.some((c) => /^(new-|select-|kill-|send-keys)/.test(c.args[0])), `${mode}: ${calls.map((c) => c.args[0])}`);
  }
});

test('runOnboard: new registration + existing openmax session → LAUNCH: manual, NEXT says close the old one first', async () => {
  const s = setup();
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 0 } });
  const { code, lines } = await onboard(s, { exec });
  assert.equal(code, 0);
  const i = lines.indexOf('ONBOARD OK');
  assert.equal(lines[i + 1], 'LAUNCH: manual');
  assert.match(lines[i + 2], /^NEXT: First close the old OpenMax session in tmux session "openmax"/);
  assert.ok(!calls.some((c) => c.cmd === 'tmux' && /^(new-session|kill-)/.test(c.args[0])));
});

test('runOnboard: replaced config (different server) + existing openmax window → not reused', async () => {
  const s = setup();
  mkdirSync(path.dirname(s.cfgPath), { recursive: true });
  writeFileSync(s.cfgPath, JSON.stringify({ server: { bff_url: 'https://old' }, agent: { api_key: 'cwsk_old' }, orgs: { z: {} } }));
  const { exec } = fakeExec({ 'tmux list-windows': { status: 0, stdout: 'openmax\n' } });
  const { lines } = await onboard(s, { exec, env: { ...s.env, TMUX: 'x' } });
  assert.ok(lines.includes('LAUNCH: manual'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('NEXT: First close the old OpenMax session in tmux window "openmax"')));
});

test('runOnboard: re-run with the same identity still reuses the running session', async () => {
  const s = setup();
  assert.equal((await onboard(s)).code, 0);
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 0 } });
  const { lines } = await onboard(s, { exec });
  assert.ok(lines.includes('LAUNCH: tmux-session'));
  assert.ok(lines.some((l) => l.includes('reusing the existing tmux session')));
  assert.ok(!calls.some((c) => c.args[0] === 'new-session'));
});

// ── atomic settings write ────────────────────────────────────────────────────

test('writeFileAtomic keeps the mode, leaves no temp file, and keeps a symlinked settings file a symlink', () => {
  const dir = tmp();
  const real = path.join(dir, 'real-settings.json');
  writeFileSync(real, '{}');
  chmodSync(real, 0o640);
  const link = path.join(dir, 'settings.json');
  symlinkSync(real, link);
  writeFileAtomic(link, '{"a":1}\n');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, 'utf8'), '{"a":1}\n');
  assert.equal(statSync(real).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  const fresh = path.join(dir, 'new.json');
  writeFileAtomic(fresh, 'x');
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
});

test('mergePermissions backup is 0600', () => {
  const file = path.join(tmp(), 'settings.json');
  writeFileSync(file, '{}', { mode: 0o644 });
  const r = mergePermissions(file, ALLOW_RULES, 0);
  assert.equal(statSync(r.backup).mode & 0o777, 0o600);
});

test('runOnboard: unchanged config but a NEW registration (earlier run failed before registering) → running session not reused', async () => {
  const s = setup();
  // A previous attempt wrote this exact config and then failed to register.
  mkdirSync(path.dirname(s.cfgPath), { recursive: true });
  writeFileSync(s.cfgPath, JSON.stringify(incoming(), null, 2) + '\n');
  const { exec, calls } = fakeExec({ 'tmux has-session': { status: 0 } });
  const { code, lines } = await onboard(s, { exec });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /config: .* unchanged/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('LAUNCH: manual'), lines.join('\n'));
  assert.ok(!calls.some((c) => c.cmd === 'tmux' && /^(new-session|kill-)/.test(c.args[0])));
});

test('runOnboard --no-stdin with a blank-key config registers and does not reuse the running session', async () => {
  const s = setup();
  mkdirSync(path.dirname(s.cfgPath), { recursive: true });
  writeFileSync(s.cfgPath, JSON.stringify(incoming()));
  const { exec } = fakeExec({ 'tmux has-session': { status: 0 } });
  const { lines } = await onboard(s, { exec, argv: ['--launch', '--no-stdin'], stdinText: '' });
  assert.ok(lines.includes('LAUNCH: manual'), lines.join('\n'));
});

// ── 1.3.3: launch order + truthful launch report ──────────────────────────────


// A stand-in for `claude` that parses its argv the way Claude Code 2.1.x does:
// `--dangerously-load-development-channels` is VARIADIC (it takes every following
// argument up to the next option or `--`), and each entry must be tagged.
const FAKE_CLAUDE = `#!/usr/bin/env node
const a = process.argv.slice(2); const channels = []; let prompt = null;
for (let i = 0; i < a.length; i++) {
  if (a[i] === '--') { prompt = a.slice(i + 1).join(' '); break; }
  if (a[i] === '--dangerously-load-development-channels') {
    while (i + 1 < a.length && !a[i + 1].startsWith('-')) channels.push(a[++i]);
    continue;
  }
  if (!a[i].startsWith('-')) prompt = a[i];
}
const bad = channels.find((c) => !/^(plugin:[^@]+@.+|server:.+)$/.test(c));
if (bad) { console.error('--dangerously-load-development-channels entries must be tagged: ' + bad); process.exit(1); }
if (process.env.FAKE_CLAUDE_STAY) setTimeout(() => {}, Number(process.env.FAKE_CLAUDE_STAY));
else console.log(JSON.stringify({ channels, prompt }));
`;

function writeFakeClaude() {
  const bin = path.join(tmp('claude-openmax-fake-claude-'), 'claude');
  writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  return bin;
}

test('buildLaunchCommand puts `--` between the variadic channel flag and the greeting prompt', () => {
  const cmd = buildLaunchCommand({ env: {} });
  assert.ok(cmd.endsWith(`${CHANNEL_REF} -- ${shellQuote(GREETING_PROMPT)}`), cmd);
  assert.ok(!buildLaunchCommand({ env: {}, prompt: '' }).includes(' -- '), 'no prompt → no separator');
});

test('the launch command parses as ONE channel entry + the greeting prompt (variadic-flag parser, through sh)', () => {
  const bin = writeFakeClaude();
  const cmd = buildLaunchCommand({ claudeBin: bin, env: {}, stripEnv: true });
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, `the launch command must not be rejected: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.channels, [CHANNEL_REF]);
  assert.equal(parsed.prompt, GREETING_PROMPT);
});

test('launchInTmux: a new session that exits at once is reported as exited (status + output), removed, not launched', async () => {
  const { exec, calls } = fakeExec({
    'tmux has-session': { status: 1 },
    'tmux display-message': { status: 0, stdout: '1 1\n' },
    'tmux capture-pane': { status: 0, stdout: "Error: --dangerously-load-development-channels entries must be tagged: OpenMax onboarding\n  plugin:<name>@<marketplace>\n\nPane is dead (status 1, Tue Nov  3 14:35:34 2026)\n" },
  });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-session', cwd: '/w', env: {}, exec });
  assert.equal(r.launched, false);
  assert.equal(r.exited, true);
  assert.equal(r.exitStatus, '1');
  assert.match(r.reason, /exited right after starting \(exit status 1\): Error: --dangerously-load-development-channels entries must be tagged/);
  assert.ok(!r.reason.includes('Pane is dead'));
  const ns = calls.find((c) => c.args[0] === 'new-session');
  assert.deepEqual(ns.args.slice(-5), [';', 'set-option', '-w', 'remain-on-exit', 'on'], 'dead pane kept for inspection');
  assert.deepEqual(calls.find((c) => c.args[0] === 'kill-session').args, ['kill-session', '-t', '=openmax']);
});

test('launchInTmux: a new window that is gone after the settle delay is not reported as launched', async () => {
  let waited = 0;
  const { exec, calls } = fakeExec({
    'tmux list-windows': { status: 0, stdout: 'main\n' },
    'tmux new-window': { status: 0, stdout: '@7\n' },
    'tmux display-message': { status: 1, stderr: "can't find window: @7" },
  });
  const r = await launchInTmux({ mode: 'tmux-window', cwd: '/w', env: { TMUX: 'x' }, exec, settleMs: 2500, delay: async (ms) => { waited = ms; } });
  assert.equal(waited, 2500, 'waits before checking');
  assert.equal(r.launched, false);
  assert.equal(r.exited, true);
  assert.match(r.reason, /no output captured/);
  assert.equal(calls.find((c) => c.args[0] === 'display-message').args[3], '@7', 'checks the window it created');
});

test('launchInTmux: a live new window is launched and remain-on-exit is reset to the default', async () => {
  const { exec, calls } = fakeExec({
    'tmux list-windows': { status: 0, stdout: 'main\n' },
    'tmux new-window': { status: 0, stdout: '@3\n' },
    'tmux display-message': { status: 0, stdout: '0 \n' },
  });
  const r = await launchInTmux({ ...NO_SETTLE, mode: 'tmux-window', cwd: '/w', env: { TMUX: 'x' }, exec });
  assert.deepEqual(r, { launched: true, mode: 'tmux-window', reused: false });
  assert.deepEqual(calls.find((c) => c.args[0] === 'set-option').args, ['set-option', '-w', '-u', '-t', '@3', 'remain-on-exit']);
  assert.ok(!calls.some((c) => /^kill-/.test(c.args[0])));
});

test('runOnboard: a launched session that dies at once → LAUNCH: manual + FAILED with the reason, never tmux-session', async () => {
  const s = setup();
  const { exec } = fakeExec({
    'tmux has-session': { status: 1 },
    'tmux display-message': { status: 0, stdout: '1 1\n' },
    'tmux capture-pane': { status: 0, stdout: 'Error: something broke\n' },
  });
  const { code, lines, out } = await onboard(s, { exec });
  assert.equal(code, 0, out);
  const i = lines.indexOf('ONBOARD OK');
  assert.equal(lines[i + 1], 'LAUNCH: manual');
  assert.ok(lines.includes('[onboard] launch: FAILED the channel session exited right after starting (exit status 1): Error: something broke'), out);
  assert.match(lines[i + 2], /^NEXT: The new Claude Code session did not start: .*Error: something broke/);
  assert.ok(!lines.some((l) => /started a detached tmux session/.test(l)));
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('launchInTmux with real tmux: the fixed command stays up, a failing one is detected (private tmux server)', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const sock = `claude-openmax-test-${process.pid}`;
  const bin = writeFakeClaude();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_STAY: '20000' };
  const exec = (cmd, args, opts) => {
    const r = spawnSync(cmd, ['-L', sock, ...args], { encoding: 'utf8', timeout: 10000, ...opts });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
  };
  try {
    const ok = await launchInTmux({ mode: 'tmux-session', cwd: tmpdir(), env, exec, claudeBin: bin, settleMs: 1500 });
    assert.equal(ok.launched, true, ok.reason);
    exec('tmux', ['kill-server']);

    const failing = path.join(tmp('claude-openmax-fake-claude-'), 'claude');
    writeFileSync(failing, '#!/bin/sh\necho "Error: --dangerously-load-development-channels entries must be tagged: hello" >&2\nexit 1\n', { mode: 0o755 });
    const bad = await launchInTmux({ mode: 'tmux-session', cwd: tmpdir(), env, exec, claudeBin: failing, settleMs: 1500 });
    assert.equal(bad.launched, false);
    assert.equal(bad.exited, true);
    assert.match(bad.reason, /entries must be tagged/);
    assert.notEqual(exec('tmux', ['has-session', '-t', '=openmax']).status, 0, 'the dead session was removed');
  } finally {
    exec('tmux', ['kill-server']);
  }
});

// ── 1.3.3: first-sync marker ──────────────────────────────────────────────────

test('runOnboard: a NEW registration leaves the first-sync marker in the data dir; a re-run does not rewrite it', async () => {
  const s = setup();
  const dataDir = path.join(s.dir, 'data');
  const env = { ...s.env, CLAUDE_OPENMAX_DATA_DIR: dataDir };
  const first = await onboard(s, { env });
  assert.equal(first.code, 0, first.out);
  const marker = path.join(dataDir, 'first-sync.json');
  const m = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(m.identity_id, 'id-new');
  assert.match(m.fp, /^[0-9a-f]{8}$/);
  assert.ok(!readFileSync(marker, 'utf8').includes('cwsk_secret_value'), 'no api_key in the marker');
  assert.ok(first.lines.some((l) => l.startsWith('[onboard] first-sync: ')));
  writeFileSync(marker, JSON.stringify({ ...m, done: ['o1'] }));
  const second = await onboard(s, { env });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')).done, ['o1'], 'kept registration → marker untouched');
});
