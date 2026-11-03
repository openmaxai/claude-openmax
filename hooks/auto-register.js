/**
 * SessionStart-time agent auto-registration (idempotent) — the claude-openmax
 * analog of `zylos add`'s post-install auto-register.
 *
 * Two callers:
 *  - the onboarding (scripts/onboard.js, or `node hooks/auto-register.js`
 *    standalone) — registers and accepts, with a 45 s budget;
 *  - the SessionStart hook — ONLY accepts a still-pending invitation (idempotent).
 *    It does NOT register: its 8 s budget is shorter than a slow registration, and
 *    a registration aborted after it reached the server leaves an identity whose
 *    key is lost, so every later session would mint another one. Registration
 *    therefore only runs where it has the time to finish (opts.register=false
 *    for the hook).
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
import { describeCause } from '../src/fetch-guard.js';

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

// Per-request timeouts (each request also stops when the overall budget runs out).
// A hung first request must not eat the whole budget and leave no room for a retry.
export const REQUEST_TIMEOUT_MS = { register: 15000, token: 10000, accept: 15000 };

/**
 * POST with a per-request timeout under the caller's overall budget `signal`.
 * A timeout rejects with name 'TimeoutError'; an overall-budget abort with
 * name 'AbortError'.
 */
async function postJson(url, headers, body, signal, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: body ?? '{}', signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) {
    if (timedOut) throw Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: 'TimeoutError', cause: e });
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Human-readable cause of a failed fetch. undici reports every network-layer
 * failure as the bare message "fetch failed" and keeps the real reason
 * (ECONNREFUSED, ENOTFOUND, a TLS error, ...) in `e.cause` — print both so a
 * failure can actually be diagnosed. Never includes request headers or bodies.
 */
export function describeFetchError(e) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError') return e.message || 'timed out';
  if (e.name === 'AbortError') return 'timed out (total budget exhausted)';
  const cause = describeCause(e.cause);
  return cause && cause !== e.message ? `${e.message} (${cause})` : (e.message || String(e));
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Network errors that prove the request never reached the server (no TCP
// connection was made / name did not resolve). Only these are safe to retry for
// a NON-idempotent request.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Retry policy.
 *  - 'idempotent' (token exchange; accept — the server replays an existing
 *    accept for the same identity): any network error, timeout or 5xx.
 *  - 'not-idempotent' (register — every successful call creates a new identity
 *    and the key is shown only once, with no idempotency key and no lookup):
 *    only failures that prove nothing was created — a connection that was never
 *    established, or HTTP 503/429 (refused before processing). A timeout, a reset
 *    connection or another 5xx may mean the identity WAS created, so it is
 *    reported instead of risking an orphan identity.
 */
export function isRetryable(kind, { error, status } = {}) {
  if (error) {
    if (error.name === 'AbortError') return false; // overall budget gone
    if (kind === 'idempotent') return true;
    const code = error.cause?.code || error.code;
    return NOT_SENT_CODES.has(code);
  }
  if (kind === 'idempotent') return status >= 500;
  return status === 503 || status === 429;
}

/**
 * POST with optional retries per `kind` (see isRetryable). Never retries a 4xx
 * other than 429. `signal` is the caller's overall budget: once it fires, no
 * further attempt is made. Returns the last {ok,status,text,json}, or throws the
 * last network error.
 */
async function postWithRetry(url, headers, body, { signal, retries, backoff = RETRY_BACKOFF_MS, timeoutMs, kind }) {
  const p = new URL(url).pathname;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await postJson(url, headers, body, signal, timeoutMs);
    } catch (e) {
      if (signal?.aborted || attempt >= retries || !isRetryable(kind, { error: e })) throw e;
      log(`POST ${p} → ${describeFetchError(e)} — retrying (${attempt + 1}/${retries})`);
      await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
      continue;
    }
    if (res.ok || signal?.aborted || attempt >= retries || !isRetryable(kind, { status: res.status })) return res;
    log(`POST ${p} → HTTP ${res.status} — retrying (${attempt + 1}/${retries})`);
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
 *   backoffMs  — TEST SEAM: delays between retries (default 1s, 2s, 4s);
 *   register   — false: never register (SessionStart hook); only accept a pending
 *                invite when a key already exists. Default true.
 *   requestTimeoutMs — TEST SEAM: per-request timeout for every step
 *                (default REQUEST_TIMEOUT_MS per step, always within deadlineMs).
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
  const tmo = (step) => (Number.isFinite(opts.requestTimeoutMs) ? opts.requestTimeoutMs : REQUEST_TIMEOUT_MS[step]);

  const budgetMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEFAULT_TOTAL_BUDGET_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    // ---- register (only when there is no usable key yet) ----
    if (PLACEHOLDER_API_KEYS.has(apiKey) && opts.register === false) {
      log('no api_key yet — not registering from the SessionStart hook; run the OpenMax onboarding command');
      return { ...out, status: 'unchanged', notRegistered: true };
    }
    if (PLACEHOLDER_API_KEYS.has(apiKey)) {
      if (!bffUrl) {
        // Nothing to register against. Not an error for the SessionStart hook
        // (a config may simply not be set up yet), but nothing was done either.
        log('no bff_url (config.server.bff_url / COCO_API_URL) — skipping');
        return { ...out, status: 'failed', step: 'register', reason: 'no bff_url configured (config.server.bff_url / COCO_API_URL)' };
      }

      const step = 'POST /auth/register/agent';
      if (ctrl.signal.aborted) return fail(step, 'time budget exhausted before registering (nothing was sent)');
      log(`registering agent: POST ${bffUrl}/auth/register/agent`);
      let reg;
      try {
        reg = await postWithRetry(`${bffUrl}/auth/register/agent`, authHeaders(cfId, cfSecret), '{}',
          { signal: ctrl.signal, retries, backoff, timeoutMs: tmo('register'), kind: 'not-idempotent' });
      } catch (e) {
        // Anything other than "provably never sent" — a timeout, the overall
        // budget aborting the in-flight request, a reset — may have created an
        // identity server-side.
        const unsure = !isRetryable('not-idempotent', { error: e });
        return fail(step, `${describeFetchError(e)}${unsure ? maybeCreatedHint(bffUrl) : ''}`);
      }
      if (!reg.ok) return fail(step, `HTTP ${reg.status}: ${bodyExcerpt(reg.text)}${reg.status === 502 || reg.status === 504 ? maybeCreatedHint(bffUrl) : ''}`);

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
    const acc = await maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal: ctrl.signal, retries, backoff, tmo });
    if (acc.accepted) { out.inviteAccepted = true; out.status = 'changed'; }
    if (acc.failed) { out.invitePending = true; return fail(acc.step, acc.reason); }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * What to tell the user when a registration may have been processed but its
 * answer was lost. Such an identity exists only as a bare registration: the
 * invitation is accepted only AFTER a successful registration, so it never
 * joined the workspace — it does not show up there and nothing needs removing.
 */
export function maybeCreatedHint(bffUrl) {
  return ' — NOT retried automatically: the server may already have created an agent identity whose key never '
    + 'reached this machine. That identity never joined the workspace (the invitation is accepted only after a '
    + 'successful registration), so nothing appears in the workspace and nothing needs cleaning up. '
    + `Check that this machine can reach ${bffUrl || 'the workspace server'} reliably, then re-run the same onboarding command `
    + '(it registers a fresh identity and accepts the invitation).';
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

async function maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal, retries = 0, backoff, tmo = (k) => REQUEST_TIMEOUT_MS[k] }) {
  const invite = cfg.invite || {};
  const invitationId = invite.invitation_id || process.env.COCO_INVITATION_ID || '';
  const inviteToken = invite.token || process.env.COCO_INVITATION_TOKEN || '';
  if (!invitationId || !inviteToken) return {}; // nothing to accept
  if (PLACEHOLDER_API_KEYS.has(apiKey)) return { failed: true, step: 'accept invitation', reason: 'no api_key yet — register first' };
  if (!bffUrl) return { failed: true, step: 'accept invitation', reason: 'invite present but missing bff_url' };

  log('invite supplied — exchanging token + accepting invitation');
  const tokStep = 'POST /auth/agent/token';
  let tok;
  try {
    tok = await postWithRetry(`${bffUrl}/auth/agent/token`, { ...authHeaders(cfId, cfSecret), Authorization: `Bearer ${apiKey}` }, '{}',
      { signal, retries, backoff, timeoutMs: tmo('token'), kind: 'idempotent' });
  }
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
      { signal, retries, backoff, timeoutMs: tmo('accept'), kind: 'idempotent' },
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
