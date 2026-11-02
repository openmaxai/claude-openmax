// Smoke test for the SHIPPED bundle (dist/index.mjs) — the artifact the
// marketplace plugin actually runs. Unit tests exercise src/, but the plugin
// is installed from a bare clone with no node_modules and runs the esbuild
// bundle. A regression here (e.g. an ESM bundle whose bundled CommonJS deps
// call require() with no `require` defined) makes the plugin install cleanly
// yet crash on startup with zero tools. This test spawns the real bundle over
// stdio and asserts it initializes and lists its tools without crashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const EXPECTED_TOOLS = ['tm', 'kb', 'as', 'comm', 'core', 'conn', 'comm_send'];

/**
 * Spawn the bundle, send JSON-RPC init + tools/list, resolve with {tools, stderr, dataDir}
 * once the tool list arrived AND (when given) stderr matches `until`.
 */
function probeBundle(extraEnv = {}, { until = null, config = null } = {}) {
  // Hermetic: disabled + no orgs => the bridge has nothing to connect to;
  // bff_url points at a closed port so the best-effort /me fails fast instead of
  // reaching out. The api_key is a NON-placeholder on purpose: without one the
  // server waits for registration and never reaches the WS gate at all.
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-smoke-'));
  const cfgPath = path.join(dir, 'config.json');
  const dataDir = path.join(dir, 'data');
  writeFileSync(cfgPath, JSON.stringify(config || { enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: 'cwsk_smoke_fixture' }, orgs: {} }));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], {
      env: { ...process.env, CLAUDE_OPENMAX_CHANNEL: '', CLAUDE_OPENMAX_DATA_DIR: dataDir, CLAUDE_OPENMAX_CONFIG: cfgPath, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let tools = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout; stderr:\n${err}`)); }, 20000);
    const check = () => {
      if (tools && (!until || until.test(err))) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ tools, stderr: err, dataDir });
      }
    };

    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) tools = msg.result.tools.map((t) => t.name);
      }
      check();
    });
    child.stderr.on('data', (d) => { err += d; check(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); if (!tools) reject(new Error(`server exited before listing tools; stderr:\n${err}`)); });

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  });
}

test('shipped dist/index.mjs exists (run `npm run build`)', () => {
  assert.ok(existsSync(BUNDLE), `missing ${BUNDLE} — run npm run build`);
});

test('shipped bundle starts over stdio and lists all service tools (no dynamic-require crash)', async () => {
  const { tools, stderr } = await probeBundle();
  assert.ok(!/Dynamic require of/.test(stderr), `bundle crashed on a dynamic require:\n${stderr}`);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(tools.includes(name), `bundle did not expose the "${name}" tool; got: ${tools.join(', ')}`);
  }
});

test('bundle in a session WITHOUT the channel stays off the WS (tools only)', async () => {
  const { tools, stderr } = await probeBundle({ CLAUDE_OPENMAX_CHANNEL: '0' }, { until: /runtime ready/ });
  assert.ok(tools.includes('comm_send'));
  assert.match(stderr, /channel NOT active in this session/);
  assert.match(stderr, /runtime ready \(ws=off\)/, 'reached the WS gate with a real key and kept the WS off');
  assert.ok(!/bridge started/.test(stderr), 'must not start the bridge without the channel');
});

test('bundle with CLAUDE_OPENMAX_CHANNEL=1 takes the channel lock and starts the bridge', async () => {
  const { stderr } = await probeBundle({ CLAUDE_OPENMAX_CHANNEL: '1' }, { until: /bridge started/ });
  assert.match(stderr, /channel active \(source=env\); holding .*channel\.lock/);
  assert.match(stderr, /runtime ready \(ws=on\)/);
});

test('second channel-active bundle on the same data dir runs tools-only (lock busy)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-lock2-'));
  const dataDir = path.join(dir, 'data');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'channel.lock'), `${process.pid}\n`); // held by a live pid (this test)
  const { stderr } = await probeBundle({ CLAUDE_OPENMAX_CHANNEL: '1', CLAUDE_OPENMAX_DATA_DIR: dataDir }, { until: /runtime ready/ });
  assert.match(stderr, /channel active but .*held by pid/);
  assert.match(stderr, /runtime ready \(ws=off\)/);
});

test('key wait gives up → the channel lock is released for later sessions', async () => {
  const noKey = { enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: '' }, orgs: {} };
  const { stderr, dataDir } = await probeBundle({ CLAUDE_OPENMAX_CHANNEL: '1', CLAUDE_OPENMAX_KEY_WAIT_MS: '300' }, { until: /channel lock released/, config: noKey });
  assert.match(stderr, /holding .*channel\.lock/);
  assert.equal(existsSync(path.join(dataDir, 'channel.lock')), false, 'lock file removed on give-up');
});

// ── delivery wiring in the shipped bundle (channel-only /wake answers) ────────

/** Start the bundle in channel-only mode, return its /wake endpoint + helpers. */
async function startChannelOnly(extraEnv = {}, config = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-co-'));
  const cfgPath = path.join(dir, 'config.json');
  const dataDir = extraEnv.CLAUDE_OPENMAX_DATA_DIR || path.join(dir, 'data');
  writeFileSync(cfgPath, JSON.stringify(config || { enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: 'cwsk_smoke_fixture' }, orgs: {} }));
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, CLAUDE_OPENMAX_CHANNEL: '', CLAUDE_OPENMAX_MODE: 'channel-only', CLAUDE_OPENMAX_WAKE_PORT: '0', CLAUDE_OPENMAX_WAKE_TOKEN: '', CLAUDE_OPENMAX_DATA_DIR: dataDir, CLAUDE_OPENMAX_CONFIG: cfgPath, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}\n');
  const until = async (re, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = err.match(re); if (m) return m; await new Promise((r) => setTimeout(r, 25)); }
    child.kill('SIGKILL');
    throw new Error(`stderr never matched ${re}:\n${err}`);
  };
  const m = await until(/wake-server listening at (http:\/\/\S+\/wake)/);
  const wake = async () => {
    const res = await fetch(m[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'raft-channel-wake.v1', messageId: 'm1', conversationId: 'c1', contentPreview: 'hi' }) });
    return { status: res.status, body: await res.json() };
  };
  return { child, wake, until, dataDir, stderr: () => err };
}

test('channel-only, channel NOT active: /wake is refused (503 runtime_unavailable) — no false ack', async () => {
  const s = await startChannelOnly({ CLAUDE_OPENMAX_CHANNEL: '0' });
  try {
    const r = await s.wake();
    assert.equal(r.status, 503);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.failureClass, 'runtime_unavailable');
  } finally { s.child.kill('SIGTERM'); }
});

test('channel-only, channel active: takes the lock and accepts /wake (200 ok:true)', async () => {
  const s = await startChannelOnly({ CLAUDE_OPENMAX_CHANNEL: '1' });
  try {
    assert.match(s.stderr(), /holding .*channel\.lock/);
    const r = await s.wake();
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { s.child.kill('SIGTERM'); }
});

test('channel-only, channel active but lock held by a live process: /wake refused', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-co-busy-'));
  const dataDir = path.join(dir, 'data');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'channel.lock'), `${process.pid}\n`); // this test process: alive
  const s = await startChannelOnly({ CLAUDE_OPENMAX_CHANNEL: '1', CLAUDE_OPENMAX_DATA_DIR: dataDir });
  try {
    assert.match(s.stderr(), /channel active but .*held by pid/);
    const r = await s.wake();
    assert.equal(r.status, 503);
  } finally { s.child.kill('SIGTERM'); }
});

test('startup race: a key written after the server started is picked up (no restart needed)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-race-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: '' }, orgs: {} }));
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, CLAUDE_OPENMAX_CHANNEL: '0', CLAUDE_OPENMAX_DATA_DIR: path.join(dir, 'data'), CLAUDE_OPENMAX_CONFIG: cfgPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  let out = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"core","arguments":{"method":"me"}}}\n');
  try {
    await waitFor(() => /registration is still in progress/.test(out), 10000, () => `stdout:\n${out}\nstderr:\n${err}`);
    writeFileSync(cfgPath, JSON.stringify({ enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: 'cwsk_written_later' }, orgs: {} }));
    await waitFor(() => /agent\.api_key found — continuing startup/.test(err), 10000, () => err);
    await waitFor(() => /runtime ready/.test(err), 10000, () => err);
    // The real handler is now in place: the same call reaches the network
    // (closed port) instead of answering "registration in progress".
    child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"core","arguments":{"method":"me"}}}\n');
    await waitFor(() => out.split('\n').some((l) => l.includes('"id":3')), 15000, () => `stdout:\n${out}\nstderr:\n${err}`);
    const reply = out.split('\n').find((l) => l.includes('"id":3'));
    assert.ok(!/registration is still in progress/.test(reply), reply);
    assert.match(reply, /fetch failed: GET \/api\/v1\/me → \S/, `guarded fetch names path + cause: ${reply}`);
  } finally {
    child.kill('SIGTERM');
  }
});

async function waitFor(pred, ms, detail) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`condition not met in ${ms}ms\n${detail()}`);
}

test('channel-only, key wait gives up → lock released AND /wake refused afterwards', async () => {
  const noKey = { enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, agent: { api_key: '' }, orgs: {} };
  const s = await startChannelOnly({ CLAUDE_OPENMAX_CHANNEL: '1', CLAUDE_OPENMAX_KEY_WAIT_MS: '300' }, noKey);
  try {
    await s.until(/channel lock released/);
    assert.equal(existsSync(path.join(s.dataDir, 'channel.lock')), false);
    const r = await s.wake();
    assert.equal(r.status, 503, 'a session that gave up must not accept wakes');
    assert.equal(r.body.failureClass, 'runtime_unavailable');
  } finally { s.child.kill('SIGTERM'); }
});

test('channel-only with a key: wakes are accepted once the runtime is ready', async () => {
  const s = await startChannelOnly({ CLAUDE_OPENMAX_CHANNEL: '1' });
  try {
    await s.until(/runtime ready/);
    assert.equal((await s.wake()).status, 200);
  } finally { s.child.kill('SIGTERM'); }
});
