/**
 * SessionStart-time agent auto-registration (idempotent) — the claude-openmax
 * analog of `zylos add`'s post-install auto-register.
 *
 * Claude Code has no literal install/upgrade hook, so this runs on SessionStart:
 * on the first session after install (or after an upgrade) it self-heals a config
 * that has no api_key yet; on every subsequent session it is a no-op.
 *
 * Behavior:
 *  - If the effective api_key is still blank/placeholder AND we have a bff_url,
 *    POST an empty body to `{bff_url}/auth/register/agent` and persist the
 *    returned identity_id + api_key back at 0600 — writing it where the runtime
 *    will actually read it (also `auth.apiKey` for OLD-shape configs). CF-Access
 *    creds (config's server/cf_access or env) are OPTIONAL: sent as headers when
 *    present (INT behind Cloudflare Access), omitted for public prod (openmax.com).
 *  - If the config carries an `invite` block (or COCO_INVITATION_ID/TOKEN env),
 *    accept the invitation. This is decoupled from registration and RETRIED on
 *    every session while the invite block remains, so a partial first-run failure
 *    self-heals; the block is cleared only after a confirmed accept.
 *
 * Discipline (same as the orientation hook): pure Node builtins (+ global fetch),
 * never throws, best-effort. All network work shares one total time budget
 * (opts.deadlineMs, default 8s) so it can't run past the SessionStart hook cap.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { scrubLine } from '../src/redact.js';

const PLACEHOLDER_API_KEYS = new Set(['', 'cwsk_replace_me']);
const DEFAULT_TOTAL_BUDGET_MS = 8000;
// Backoff between retries (ms) — only used when opts.retries > 0 (the one-shot
// onboard script). The SessionStart path keeps retries=0: it must fit the hook cap.
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

/** True when `key` is blank or the config.example.json placeholder. */
export function isPlaceholderKey(key) { return PLACEHOLDER_API_KEYS.has(key || ''); }

/** Resolve the config path the same way src/config.js does. */
export function resolveConfigPath() {
  if (process.env.CLAUDE_OPENMAX_CONFIG) return process.env.CLAUDE_OPENMAX_CONFIG;
  const dir = process.env.CLAUDE_OPENMAX_DATA_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-openmax');
  return path.join(dir, 'config.json');
}

/** True for an OLD-shape config (top-level http/auth or array orgs) — mirrors src/config.js. */
function isLegacyShape(raw) {
  return !!(raw && (raw.http || raw.auth || Array.isArray(raw.orgs)));
}

function log(msg) { try { process.stderr.write(`[claude-openmax auto-register] ${msg}\n`); } catch { /* ignore */ } }

/**
 * Build request headers. Always JSON; CF-Access headers are OPTIONAL — included
 * ONLY when BOTH `id` and `secret` are truthy (INT sits behind Cloudflare
 * Access; public prod like openmax.com is not and needs no CF headers).
 */
function authHeaders(id, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }
  return headers;
}

async function postJson(url, headers, body, signal) {
  const res = await fetch(url, { method: 'POST', headers, body: body ?? '{}', signal });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Human-readable cause of a failed fetch. undici reports every network-layer
 * failure as the bare message "fetch failed" and keeps the real reason
 * (ECONNREFUSED, ENOTFOUND, a TLS error, ...) in `e.cause` — print both so a
 * failure can actually be diagnosed. Never includes request headers or bodies.
 */
export function describeFetchError(e) {
  if (!e) return 'unknown error';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timed out';
  const cause = e.cause && (e.cause.code || e.cause.message);
  return cause ? `${e.message} (${cause})` : (e.message || String(e));
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * POST with optional retries. Retries ONLY transient failures — a network error
 * or an HTTP 5xx — never a 4xx (a rejected request will be rejected again).
 * `signal` is the caller's overall budget: once it fires, no further attempt is
 * made. Returns the last {ok,status,text,json}, or throws the last network error.
 */
async function postWithRetry(url, headers, body, signal, retries, backoff = RETRY_BACKOFF_MS) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await postJson(url, headers, body, signal);
    } catch (e) {
      if (signal?.aborted || attempt >= retries) throw e;
      log(`POST ${new URL(url).pathname} → ${describeFetchError(e)} — retrying (${attempt + 1}/${retries})`);
      await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
      continue;
    }
    if (res.status < 500 || signal?.aborted || attempt >= retries) return res;
    log(`POST ${new URL(url).pathname} → HTTP ${res.status} — retrying (${attempt + 1}/${retries})`);
    await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
  }
}

/** Short, secret-scrubbed excerpt of an error response body. */
function bodyExcerpt(text) { return scrubLine(String(text || '').slice(0, 200)); }

export function writeConfig0600(configPath, cfg) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, and the config
  // holds secrets (api_key, cf_access.client_secret) — force 0600.
  chmodSync(configPath, 0o600);
}

/**
 * Register the agent if needed, then accept an invitation if one is configured.
 * Never throws. Returns a structured outcome so callers can tell a genuine no-op
 * apart from a failure (the standalone CLI used to print "no-op" for both):
 *
 *   { status: 'changed' | 'unchanged' | 'failed',
 *     registered: boolean,         // new credentials were written this run
 *     inviteAccepted: boolean,     // an invitation was accepted this run
 *     invitePending: boolean,      // an invite block is still waiting to be accepted
 *     step?: string, reason?: string,   // on failure: e.g. 'POST /auth/register/agent', 'HTTP 503: ...'
 *     identityId?: string, configPath: string }
 *
 * 'failed' covers BOTH a failed registration and a failed invite accept; the
 * invite block is kept on failure so the next run retries it.
 *
 * @param {{deadlineMs?:number, retries?:number}} [opts]
 *   deadlineMs — total network budget (default 8s, sized for the SessionStart hook);
 *   retries    — extra attempts per request on network errors / 5xx (default 0);
 *   backoffMs  — TEST SEAM: delays between retries (default 1s, 2s, 4s).
 */
export async function registerAndAccept(opts = {}) {
  const configPath = resolveConfigPath();
  const out = { status: 'unchanged', registered: false, inviteAccepted: false, invitePending: false, configPath };
  const fail = (step, reason) => { log(`FAILED: ${step} → ${reason}`); return { ...out, status: 'failed', step, reason }; };

  let cfg = {};
  try {
    if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) { return fail('read config', `config unreadable (${configPath}): ${e.message}`); }

  const legacy = isLegacyShape(cfg);
  const server = cfg.server || {};
  const agent = cfg.agent || {};
  const auth = cfg.auth || {};
  const cf = cfg.cf_access || {};

  const bffUrl = (server.bff_url || cfg.http?.baseUrl || process.env.COCO_API_URL || '').replace(/\/+$/, '');
  // Effective api_key across BOTH config shapes + env, so legacy configs are
  // recognized as already-registered (idempotent) rather than re-registered.
  let apiKey = agent.api_key || auth.apiKey || process.env.COCO_API_KEY || '';
  const cfId = cf.client_id || process.env.COCO_CF_ACCESS_CLIENT_ID || '';
  const cfSecret = cf.client_secret || process.env.COCO_CF_ACCESS_CLIENT_SECRET || '';
  const retries = Number.isInteger(opts.retries) && opts.retries > 0 ? opts.retries : 0;
  const backoff = Array.isArray(opts.backoffMs) && opts.backoffMs.length ? opts.backoffMs : RETRY_BACKOFF_MS;

  const budgetMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEFAULT_TOTAL_BUDGET_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    // ---- register (only when there is no usable key yet) ----
    if (PLACEHOLDER_API_KEYS.has(apiKey)) {
      if (!bffUrl) {
        // Nothing to register against. Not an error for the SessionStart hook
        // (a config may simply not be set up yet), but nothing was done either.
        log('no bff_url (config.server.bff_url / COCO_API_URL) — skipping');
        return { ...out, status: 'failed', step: 'register', reason: 'no bff_url configured (config.server.bff_url / COCO_API_URL)' };
      }

      const step = 'POST /auth/register/agent';
      log(`registering agent: POST ${bffUrl}/auth/register/agent`);
      let reg;
      try { reg = await postWithRetry(`${bffUrl}/auth/register/agent`, authHeaders(cfId, cfSecret), '{}', ctrl.signal, retries, backoff); }
      catch (e) { return fail(step, describeFetchError(e)); }
      if (!reg.ok) return fail(step, `HTTP ${reg.status}: ${bodyExcerpt(reg.text)}`);

      const data = (reg.json && (reg.json.data || reg.json)) || {};
      const identityId = data.identity_id || '';
      const newKey = data.api_key || '';
      if (!identityId || !newKey) return fail(step, 'response missing identity_id/api_key');

      // Persist the key WHERE THE RUNTIME READS IT: new-shape agent.api_key always,
      // and legacy auth.apiKey too when the config is OLD-shape.
      cfg.agent = { ...(cfg.agent || {}), identity_id: identityId, api_key: newKey };
      if (legacy) cfg.auth = { ...(cfg.auth || {}), apiKey: newKey };
      // Persist cf_access only with BOTH creds (INT behind Cloudflare Access).
      // Without them, STRIP any existing empty/partial block (e.g. the blank
      // cf_access that config.example.json seeds) so it never lingers — a stale
      // empty block would otherwise make the runtime emit empty CF-Access headers
      // on public/prod.
      if (cfId && cfSecret) cfg.cf_access = { client_id: cfId, client_secret: cfSecret };
      else delete cfg.cf_access;
      cfg.server = { ...(cfg.server || {}), bff_url: cfg.server?.bff_url || bffUrl };
      try { writeConfig0600(configPath, cfg); }
      catch (e) { return fail('write config', `persist failed: ${e.message}`); }
      apiKey = newKey;
      out.registered = true;
      out.status = 'changed';
      out.identityId = identityId;
      log(`registered: identity_id=${identityId} — written to ${configPath} (0600)`);
    }

    // ---- accept invitation (decoupled + retryable across sessions) ----
    const acc = await maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal: ctrl.signal, retries, backoff });
    if (acc.accepted) { out.inviteAccepted = true; out.status = 'changed'; }
    if (acc.failed) { out.invitePending = true; return fail(acc.step, acc.reason); }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Back-compat wrapper (SessionStart hook + existing callers): register/accept
 * and return true iff new registration credentials were written. Never throws.
 * @param {{deadlineMs?:number, retries?:number}} [opts]
 */
export async function ensureRegistered(opts = {}) {
  const res = await registerAndAccept(opts);
  return res.registered;
}

async function maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal, retries = 0, backoff }) {
  const invite = cfg.invite || {};
  const invitationId = invite.invitation_id || process.env.COCO_INVITATION_ID || '';
  const inviteToken = invite.token || process.env.COCO_INVITATION_TOKEN || '';
  if (!invitationId || !inviteToken) return {}; // nothing to accept
  if (PLACEHOLDER_API_KEYS.has(apiKey)) return { failed: true, step: 'accept invitation', reason: 'no api_key yet — register first' };
  if (!bffUrl) return { failed: true, step: 'accept invitation', reason: 'invite present but missing bff_url' };

  log('invite supplied — exchanging token + accepting invitation');
  const tokStep = 'POST /auth/agent/token';
  let tok;
  try { tok = await postWithRetry(`${bffUrl}/auth/agent/token`, { ...authHeaders(cfId, cfSecret), Authorization: `Bearer ${apiKey}` }, '{}', signal, retries, backoff); }
  catch (e) { return { failed: true, step: tokStep, reason: `${describeFetchError(e)} (will retry)` }; }
  const accessToken = tok.json && (tok.json.data ? tok.json.data.access_token : tok.json.access_token);
  if (!tok.ok || !accessToken) return { failed: true, step: tokStep, reason: `HTTP ${tok.status}: no access_token (will retry)` };

  const accStep = 'POST /api/v1/invitations/<id>/accept';
  let acc;
  try {
    // accept is idempotent server-side for the same identity (a re-accept
    // replays the original membership with 200), so retrying it is safe.
    acc = await postWithRetry(
      `${bffUrl}/api/v1/invitations/${invitationId}/accept`,
      { ...authHeaders(cfId, cfSecret), Authorization: `Bearer ${accessToken}` },
      JSON.stringify({ token: inviteToken }),
      signal,
      retries,
      backoff,
    );
  } catch (e) { return { failed: true, step: accStep, reason: `${describeFetchError(e)} (will retry)` }; }
  if (!acc.ok) return { failed: true, step: accStep, reason: `HTTP ${acc.status}: ${bodyExcerpt(acc.text)} (will retry)` };

  // One-time: clear the invite block ONLY after a confirmed accept.
  try {
    delete cfg.invite;
    writeConfig0600(configPath, cfg);
    log(`invitation ${invitationId} accepted; invite block cleared`);
  } catch (e) { log(`could not clear invite block: ${e.message}`); }
  return { accepted: true };
}

// Standalone pre-register step: `node hooks/auto-register.js`. Lets onboarding
// register + accept the invitation BEFORE the first real Claude Code session, so
// the openmax MCP server comes up already-credentialed (no first-session bootstrap
// gap). Imported as a module (by session-hook.js) this block is a no-op.
//
// Exit status: 0 = registered/accepted, or a genuine no-op (already registered,
// no invite pending); 1 = FAILED (registration or invite accept did not succeed).
// The SessionStart hook does NOT go through here and always exits 0.
export function describeOutcome(res) {
  if (res.status === 'failed') return `FAILED: ${res.step} → ${res.reason}`;
  if (res.status === 'changed') {
    const parts = [];
    if (res.registered) parts.push('registered + config updated');
    if (res.inviteAccepted) parts.push('invitation accepted');
    return parts.join('; ');
  }
  return 'no-op (already registered, no invitation pending)';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerAndAccept({ deadlineMs: 45000, retries: 3 })
    .then((res) => {
      process.stderr.write(`[claude-openmax auto-register] ${describeOutcome(res)}\n`);
      process.exitCode = res.status === 'failed' ? 1 : 0;
    })
    .catch((e) => { process.stderr.write(`[claude-openmax auto-register] FAILED: ${e?.message || e}\n`); process.exitCode = 1; })
    .finally(() => process.exit());
}
