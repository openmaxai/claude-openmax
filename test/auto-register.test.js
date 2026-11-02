import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ensureRegistered, resolveConfigPath, registerAndAccept, describeOutcome, describeFetchError, isRetryable } from '../hooks/auto-register.js';

function seedConfig(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-openmax-reg-'));
  const cfgPath = path.join(dir, 'config.json');
  const cfg = {
    server: { bff_url: 'https://core.test' },
    agent: { api_key: '', identity_id: '', device_id: 'd1' },
    cf_access: { client_id: 'cf-id', client_secret: 'cf-secret' },
    ...overrides,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 }); // 644 on purpose
  return cfgPath;
}

/** Swap globalThis.fetch for the duration of `fn`, capturing the calls made. */
async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } });

async function runWith(cfgPath, fn) {
  const prev = process.env.CLAUDE_OPENMAX_CONFIG;
  process.env.CLAUDE_OPENMAX_CONFIG = cfgPath;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_OPENMAX_CONFIG; else process.env.CLAUDE_OPENMAX_CONFIG = prev;
  }
}

test('resolveConfigPath honors CLAUDE_OPENMAX_CONFIG', () => {
  const prev = process.env.CLAUDE_OPENMAX_CONFIG;
  process.env.CLAUDE_OPENMAX_CONFIG = '/tmp/x/config.json';
  assert.equal(resolveConfigPath(), '/tmp/x/config.json');
  if (prev === undefined) delete process.env.CLAUDE_OPENMAX_CONFIG; else process.env.CLAUDE_OPENMAX_CONFIG = prev;
});

test('registers when api_key is blank, persists creds, and forces 0600', async () => {
  const cfgPath = seedConfig();
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent')
      ? jsonRes(200, { identity_id: 'id-123', api_key: 'cwsk_real' })
      : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.agent.identity_id, 'id-123');
  assert.equal(cfg.agent.api_key, 'cwsk_real');
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'secret-bearing config must be 0600');
});

test('is idempotent — a real api_key present means no register call', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_already', identity_id: 'id-0' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    () => { throw new Error('fetch must not be called when already registered'); },
    (calls) => ensureRegistered().then((w) => { assert.equal(calls.length, 0); return w; }),
  ));
  assert.equal(wrote, false);
});

test('registers WITHOUT CF-Access creds (public/prod): no CF headers, no cf_access persisted', async () => {
  // openmax.com is public (not behind Cloudflare Access) — registration must proceed.
  // Seed a config with NO cf_access key at all (as a public/prod install would have).
  const cfgPath = seedConfig();
  const noCf = JSON.parse(readFileSync(cfgPath, 'utf8'));
  delete noCf.cf_access;
  writeFileSync(cfgPath, JSON.stringify(noCf, null, 2), { mode: 0o644 });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent')
      ? jsonRes(200, { identity_id: 'id-pub', api_key: 'cwsk_pub' })
      : jsonRes(404, {}),
    (calls) => ensureRegistered().then((w) => {
      const reg = calls.find((c) => c.url.endsWith('/auth/register/agent'));
      assert.ok(reg, 'should still POST /auth/register/agent without CF creds');
      const h = reg.opts.headers;
      assert.equal(h['Content-Type'], 'application/json');
      assert.equal(h['CF-Access-Client-Id'], undefined, 'no CF-Access-Client-Id without creds');
      assert.equal(h['CF-Access-Client-Secret'], undefined, 'no CF-Access-Client-Secret without creds');
      return w;
    }),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.agent.identity_id, 'id-pub');
  assert.equal(cfg.agent.api_key, 'cwsk_pub');
  assert.equal(cfg.cf_access, undefined, 'must NOT write an empty cf_access block');
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'secret-bearing config must be 0600');
});

test('strips a pre-existing EMPTY cf_access block on register (e.g. from config.example.json template)', async () => {
  // config.example.json seeds cf_access:{client_id:'',client_secret:''}. A public/prod
  // install derived from it must not keep that empty block — it would otherwise make the
  // runtime emit empty CF-Access headers. Registration must proceed AND drop the block.
  const cfgPath = seedConfig();
  const blankCf = JSON.parse(readFileSync(cfgPath, 'utf8'));
  blankCf.cf_access = { client_id: '', client_secret: '' };
  writeFileSync(cfgPath, JSON.stringify(blankCf, null, 2), { mode: 0o644 });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent')
      ? jsonRes(200, { identity_id: 'id-empty', api_key: 'cwsk_empty' })
      : jsonRes(404, {}),
    (calls) => ensureRegistered().then((w) => {
      const reg = calls.find((c) => c.url.endsWith('/auth/register/agent'));
      assert.ok(reg, 'should POST /auth/register/agent despite empty cf_access');
      const h = reg.opts.headers;
      assert.equal(h['CF-Access-Client-Id'], undefined, 'blank creds → no CF-Access-Client-Id');
      assert.equal(h['CF-Access-Client-Secret'], undefined, 'blank creds → no CF-Access-Client-Secret');
      return w;
    }),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.agent.api_key, 'cwsk_empty');
  assert.equal(cfg.cf_access, undefined, 'pre-existing empty cf_access must be STRIPPED, not kept');
});

test('registers WITH CF-Access creds present: sends CF headers (INT regression guard)', async () => {
  const cfgPath = seedConfig(); // seedConfig includes cf_access {cf-id, cf-secret}
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent')
      ? jsonRes(200, { identity_id: 'id-int', api_key: 'cwsk_int' })
      : jsonRes(404, {}),
    (calls) => ensureRegistered().then((w) => {
      const reg = calls.find((c) => c.url.endsWith('/auth/register/agent'));
      const h = reg.opts.headers;
      assert.equal(h['CF-Access-Client-Id'], 'cf-id');
      assert.equal(h['CF-Access-Client-Secret'], 'cf-secret');
      return w;
    }),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(cfg.cf_access, { client_id: 'cf-id', client_secret: 'cf-secret' }, 'cf_access persisted when present');
});

test('invite-accept proceeds WITHOUT CF creds: token-exchange + accept called, no CF headers', async () => {
  const cfgPath = seedConfig({
    cf_access: {},
    agent: { api_key: 'cwsk_have', identity_id: 'id-x' },
    invite: { invitation_id: 'inv-pub', token: 'tok-pub' },
  });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc-pub' });
    if (url.includes('/invitations/inv-pub/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then(() => {
    const tok = calls.find((c) => c.url.endsWith('/auth/agent/token'));
    const acc = calls.find((c) => c.url.includes('/invitations/inv-pub/accept'));
    assert.ok(tok, 'token exchange should be called without CF creds');
    assert.ok(acc, 'accept should be called without CF creds');
    assert.equal(tok.opts.headers['CF-Access-Client-Id'], undefined, 'no CF header on token exchange');
    assert.equal(acc.opts.headers['CF-Access-Client-Id'], undefined, 'no CF header on accept');
    assert.equal(tok.opts.headers.Authorization, 'Bearer cwsk_have', 'keeps API-key bearer on token exchange');
    assert.equal(acc.opts.headers.Authorization, 'Bearer acc-pub', 'keeps access-token bearer on accept');
  })));
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).invite, undefined, 'invite cleared after accept');
});

test('invite-accept WITH CF creds present still sends CF headers (regression guard)', async () => {
  const cfgPath = seedConfig({
    agent: { api_key: 'cwsk_have', identity_id: 'id-x' },
    invite: { invitation_id: 'inv-int', token: 'tok-int' },
  });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc-int' });
    if (url.includes('/invitations/inv-int/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then(() => {
    const tok = calls.find((c) => c.url.endsWith('/auth/agent/token'));
    const acc = calls.find((c) => c.url.includes('/invitations/inv-int/accept'));
    assert.equal(tok.opts.headers['CF-Access-Client-Id'], 'cf-id');
    assert.equal(acc.opts.headers['CF-Access-Client-Id'], 'cf-id');
  })));
});

test('placeholder api_key (cwsk_replace_me) is treated as unregistered', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_replace_me' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent') ? jsonRes(200, { identity_id: 'id-9', api_key: 'cwsk_new' }) : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).agent.api_key, 'cwsk_new');
});

test('when an invite block is present, also accepts the invitation and clears it', async () => {
  const cfgPath = seedConfig({ invite: { invitation_id: 'inv-1', token: 'tok-abc' } });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/register/agent')) return jsonRes(200, { identity_id: 'id-1', api_key: 'cwsk_k' });
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'access-xyz' });
    if (url.includes('/invitations/inv-1/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then(() => {
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes('/invitations/inv-1/accept')), 'should accept the invitation');
  })));
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.invite, undefined, 'one-time invite block should be cleared after accept');
  assert.equal(existsSync(cfgPath), true);
});

test('legacy-shape config: writes the key where the runtime reads it (auth.apiKey)', async () => {
  // Legacy marker: top-level `auth`. Runtime translateLegacy() reads api_key from auth.apiKey.
  const cfgPath = seedConfig({ auth: {}, agent: { identity_id: '', api_key: '' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    (url) => url.endsWith('/auth/register/agent') ? jsonRes(200, { identity_id: 'id-L', api_key: 'cwsk_legacy' }) : jsonRes(404, {}),
    () => ensureRegistered(),
  ));
  assert.equal(wrote, true);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.auth.apiKey, 'cwsk_legacy', 'legacy runtime reads auth.apiKey');
  assert.equal(cfg.agent.api_key, 'cwsk_legacy');
});

test('legacy-shape config already keyed in auth.apiKey is idempotent (no re-register)', async () => {
  const cfgPath = seedConfig({ auth: { apiKey: 'cwsk_existing' }, agent: { api_key: '' } });
  const wrote = await runWith(cfgPath, () => withFetch(
    () => { throw new Error('fetch must not be called — already registered via auth.apiKey'); },
    (calls) => ensureRegistered().then((w) => { assert.equal(calls.length, 0); return w; }),
  ));
  assert.equal(wrote, false);
});

test('accepts an invitation even when api_key already exists (retry across sessions)', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have', identity_id: 'id-x' }, invite: { invitation_id: 'inv-9', token: 'tok-9' } });
  const wrote = await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/register/agent')) throw new Error('must NOT register when key exists');
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc-9' });
    if (url.includes('/invitations/inv-9/accept')) return jsonRes(200, { ok: true });
    return jsonRes(404, {});
  }, (calls) => ensureRegistered().then((w) => {
    assert.ok(calls.some((c) => c.url.includes('/invitations/inv-9/accept')), 'should accept the invitation');
    assert.ok(!calls.some((c) => c.url.endsWith('/auth/register/agent')), 'should not re-register');
    return w;
  })));
  assert.equal(wrote, false, 'no new registration credentials were written');
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).invite, undefined, 'invite cleared after accept');
});

test('invite is NOT cleared when acceptance fails (so it retries next session)', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' }, invite: { invitation_id: 'inv-f', token: 'tok-f' } });
  await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/agent/token')) return jsonRes(200, { access_token: 'acc' });
    if (url.includes('/invitations/inv-f/accept')) return jsonRes(500, { error: 'boom' });
    return jsonRes(404, {});
  }, () => ensureRegistered()));
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).invite, { invitation_id: 'inv-f', token: 'tok-f' }, 'invite retained on failure');
});

// ── structured outcome + retries ─────────────────────────────────

test('registerAndAccept reports failed (not "no-op") when registration fails, with step + reason', async () => {
  const cfgPath = seedConfig();
  const res = await runWith(cfgPath, () => withFetch(() => jsonRes(500, { error: 'boom' }), () => registerAndAccept()));
  assert.equal(res.status, 'failed');
  assert.equal(res.step, 'POST /auth/register/agent');
  assert.match(res.reason, /^HTTP 500/);
  assert.match(describeOutcome(res), /^FAILED: POST \/auth\/register\/agent → HTTP 500/);
});

test('register retries only provably-unsent failures (connection refused, 503), then succeeds', async () => {
  const cfgPath = seedConfig();
  let n = 0;
  const res = await runWith(cfgPath, () => withFetch((url) => {
    n++;
    if (n === 1) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
    if (n === 2) return jsonRes(503, {});
    return jsonRes(200, { identity_id: 'id-r', api_key: 'cwsk_r' });
  }, () => registerAndAccept({ retries: 3, backoffMs: [1] })));
  assert.equal(n, 3);
  assert.equal(res.status, 'changed');
  assert.equal(res.registered, true);
});

test('registerAndAccept does NOT retry a 4xx', async () => {
  const cfgPath = seedConfig();
  let n = 0;
  const res = await runWith(cfgPath, () => withFetch(() => { n++; return jsonRes(403, {}); }, () => registerAndAccept({ retries: 3, backoffMs: [1] })));
  assert.equal(n, 1);
  assert.equal(res.status, 'failed');
});

test('registerAndAccept gives up after retries are exhausted and surfaces the network cause', async () => {
  const cfgPath = seedConfig();
  let n = 0;
  const res = await runWith(cfgPath, () => withFetch(() => { n++; const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; },
    () => registerAndAccept({ retries: 2, backoffMs: [1] })));
  assert.equal(n, 3);
  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'fetch failed (ECONNREFUSED)');
});

test('registerAndAccept: an already-registered config with no invite is a genuine no-op', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' } });
  const res = await runWith(cfgPath, () => withFetch(() => { throw new Error('no fetch expected'); }, () => registerAndAccept()));
  assert.equal(res.status, 'unchanged');
  assert.equal(describeOutcome(res), 'no-op (already registered, no invitation pending)');
});

test('registerAndAccept: failed invite accept is a failure with invitePending', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' }, invite: { invitation_id: 'i', token: 't' } });
  const res = await runWith(cfgPath, () => withFetch((url) => (url.endsWith('/auth/agent/token') ? jsonRes(401, {}) : jsonRes(404, {})), () => registerAndAccept()));
  assert.equal(res.status, 'failed');
  assert.equal(res.invitePending, true);
  assert.equal(res.step, 'POST /auth/agent/token');
});

test('error excerpts are secret-scrubbed', async () => {
  const cfgPath = seedConfig();
  const res = await runWith(cfgPath, () => withFetch(() => jsonRes(500, { api_key: 'cwsk_leaky' }), () => registerAndAccept()));
  assert.ok(!res.reason.includes('cwsk_leaky'), res.reason);
});

test('describeFetchError: per-request timeout, budget abort, cause code appended', () => {
  const abort = new Error('x'); abort.name = 'AbortError';
  assert.equal(describeFetchError(abort), 'timed out (total budget exhausted)');
  assert.equal(describeFetchError(Object.assign(new Error('timed out after 5ms'), { name: 'TimeoutError' })), 'timed out after 5ms');
  const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' };
  assert.equal(describeFetchError(e), 'fetch failed (ENOTFOUND)');
});

const AR = fileURLToPath(new URL('../hooks/auto-register.js', import.meta.url));
const runCli = (cfgPath) => spawnSync(process.execPath, [AR], { encoding: 'utf8', env: { ...process.env, CLAUDE_OPENMAX_CONFIG: cfgPath, COCO_API_URL: '', COCO_API_KEY: '' }, timeout: 20000 });

test('standalone CLI: exits 1 and prints FAILED when it cannot register', () => {
  const cfgPath = seedConfig({ server: {} }); // no bff_url → cannot register
  const r = runCli(cfgPath);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /FAILED: register → no bff_url/);
  assert.ok(!/no-op/.test(r.stderr));
});

test('standalone CLI: exits 0 with a real no-op message when already registered', () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' } });
  const r = runCli(cfgPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no-op \(already registered, no invitation pending\)/);
});

// ── register must never create an orphan identity; per-request timeouts ──────

const netErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('register: a dropped connection after the server may have created the identity is NOT retried', async () => {
  // Server-side: identity created, then the connection resets before the response.
  const cfgPath = seedConfig();
  let created = 0;
  const res = await runWith(cfgPath, () => withFetch((url) => {
    if (url.endsWith('/auth/register/agent')) { created++; throw netErr('ECONNRESET'); }
    return jsonRes(404, {});
  }, () => registerAndAccept({ retries: 3, backoffMs: [1] })));
  assert.equal(created, 1, 'exactly one register call — a retry would orphan the first identity');
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /ECONNRESET.*may already have created an identity/);
});

test('register: HTTP 500 / 502 / 504 are not retried (may have been processed)', async () => {
  for (const status of [500, 502, 504]) {
    const cfgPath = seedConfig();
    let n = 0;
    const res = await runWith(cfgPath, () => withFetch(() => { n++; return jsonRes(status, {}); }, () => registerAndAccept({ retries: 3, backoffMs: [1] })));
    assert.equal(n, 1, `HTTP ${status}`);
    assert.equal(res.status, 'failed');
  }
});

const hangUntilAbort = (url, opts) => new Promise((_r, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

test('register: a hung request times out per request (not the whole budget) and is not retried', async () => {
  const cfgPath = seedConfig();
  let n = 0;
  const t0 = Date.now();
  const res = await runWith(cfgPath, () => withFetch((url, opts) => { n++; return hangUntilAbort(url, opts); },
    () => registerAndAccept({ retries: 3, backoffMs: [1], requestTimeoutMs: 40, deadlineMs: 5000 })));
  assert.equal(n, 1);
  assert.ok(Date.now() - t0 < 2000, 'returned at the per-request timeout, long before the 5s budget');
  assert.match(res.reason, /^timed out after 40ms/);
});

test('token exchange: a hung first request times out per request and the retry succeeds within the budget', async () => {
  const cfgPath = seedConfig({ agent: { api_key: 'cwsk_have' }, invite: { invitation_id: 'inv-t', token: 'tok-t' } });
  let tokCalls = 0;
  const res = await runWith(cfgPath, () => withFetch((url, opts) => {
    if (url.endsWith('/auth/agent/token')) return ++tokCalls === 1 ? hangUntilAbort(url, opts) : jsonRes(200, { access_token: 'a' });
    if (url.includes('/invitations/inv-t/accept')) return jsonRes(200, {});
    return jsonRes(404, {});
  }, () => registerAndAccept({ retries: 3, backoffMs: [1], requestTimeoutMs: 40, deadlineMs: 5000 })));
  assert.equal(tokCalls, 2);
  assert.equal(res.status, 'changed');
  assert.equal(res.inviteAccepted, true);
});

test('isRetryable policy table', () => {
  assert.equal(isRetryable('not-idempotent', { error: netErr('ECONNREFUSED') }), true);
  assert.equal(isRetryable('not-idempotent', { error: netErr('ENOTFOUND') }), true);
  assert.equal(isRetryable('not-idempotent', { error: netErr('ECONNRESET') }), false);
  assert.equal(isRetryable('not-idempotent', { error: Object.assign(new Error('t'), { name: 'TimeoutError' }) }), false);
  assert.equal(isRetryable('not-idempotent', { status: 503 }), true);
  assert.equal(isRetryable('not-idempotent', { status: 429 }), true);
  assert.equal(isRetryable('not-idempotent', { status: 500 }), false);
  assert.equal(isRetryable('idempotent', { error: netErr('ECONNRESET') }), true);
  assert.equal(isRetryable('idempotent', { status: 502 }), true);
  assert.equal(isRetryable('idempotent', { status: 404 }), false);
  assert.equal(isRetryable('idempotent', { error: Object.assign(new Error('x'), { name: 'AbortError' }) }), false);
});
