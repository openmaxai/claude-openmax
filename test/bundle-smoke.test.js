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

/** Spawn the bundle, send JSON-RPC init + tools/list, resolve with {tools, stderr}. */
function probeBundle() {
  // Hermetic: disabled + no orgs => no workspace WS; bff_url points at a
  // closed port so the best-effort /me fails fast instead of reaching out.
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-smoke-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ enabled: false, server: { bff_url: 'http://127.0.0.1:9' }, orgs: {} }));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], {
      env: { ...process.env, CLAUDE_OPENMAX_CONFIG: cfgPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout; stderr:\n${err}`)); }, 20000);

    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          resolve({ tools: msg.result.tools.map((t) => t.name), stderr: err });
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); if (!out.includes('"tools"')) reject(new Error(`server exited before listing tools; stderr:\n${err}`)); });

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
