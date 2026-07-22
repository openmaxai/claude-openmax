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

const PLACEHOLDER_API_KEYS = new Set(['', 'cwsk_replace_me']);
const DEFAULT_TOTAL_BUDGET_MS = 8000;

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

function writeConfig0600(configPath, cfg) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, and the config
  // holds secrets (api_key, cf_access.client_secret) — force 0600.
  chmodSync(configPath, 0o600);
}

/**
 * Register the agent if needed, then (retryable) accept an invitation if one is
 * configured. Returns true iff it wrote new registration credentials. Never throws.
 * @param {{deadlineMs?:number}} [opts]
 */
export async function ensureRegistered(opts = {}) {
  const configPath = resolveConfigPath();
  let cfg = {};
  try {
    if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) { log(`config unreadable (${configPath}): ${e.message}`); return false; }

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

  const budgetMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEFAULT_TOTAL_BUDGET_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  let wroteCreds = false;
  try {
    // ---- register (only when there is no usable key yet) ----
    if (PLACEHOLDER_API_KEYS.has(apiKey)) {
      if (!bffUrl) { log('no bff_url (config.server.bff_url / COCO_API_URL) — skipping'); return false; }

      log(`registering agent: POST ${bffUrl}/auth/register/agent`);
      let reg;
      try { reg = await postJson(`${bffUrl}/auth/register/agent`, authHeaders(cfId, cfSecret), '{}', ctrl.signal); }
      catch (e) { log(`register request failed: ${e.message}`); return false; }
      if (!reg.ok) { log(`register HTTP ${reg.status}: ${(reg.text || '').slice(0, 200)}`); return false; }

      const data = (reg.json && (reg.json.data || reg.json)) || {};
      const identityId = data.identity_id || '';
      const newKey = data.api_key || '';
      if (!identityId || !newKey) { log('register response missing identity_id/api_key'); return false; }

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
      catch (e) { log(`persist failed: ${e.message}`); return false; }
      apiKey = newKey;
      wroteCreds = true;
      log(`registered: identity_id=${identityId} — written to ${configPath} (0600)`);
    }

    // ---- accept invitation (decoupled + retryable across sessions) ----
    if (!PLACEHOLDER_API_KEYS.has(apiKey)) {
      await maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal: ctrl.signal });
    }
  } finally {
    clearTimeout(timer);
  }
  return wroteCreds;
}

async function maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret, signal }) {
  const invite = cfg.invite || {};
  const invitationId = invite.invitation_id || process.env.COCO_INVITATION_ID || '';
  const inviteToken = invite.token || process.env.COCO_INVITATION_TOKEN || '';
  if (!invitationId || !inviteToken) return; // nothing to accept
  if (!bffUrl) { log('invite present but missing bff_url — cannot accept, will retry'); return; }

  log('invite supplied — exchanging token + accepting invitation');
  let tok;
  try { tok = await postJson(`${bffUrl}/auth/agent/token`, { ...authHeaders(cfId, cfSecret), Authorization: `Bearer ${apiKey}` }, '{}', signal); }
  catch (e) { log(`token exchange failed (will retry next session): ${e.message}`); return; }
  const accessToken = tok.json && (tok.json.data ? tok.json.data.access_token : tok.json.access_token);
  if (!tok.ok || !accessToken) { log(`token exchange HTTP ${tok?.status}: no access_token (will retry)`); return; }

  let acc;
  try {
    acc = await postJson(
      `${bffUrl}/api/v1/invitations/${invitationId}/accept`,
      { ...authHeaders(cfId, cfSecret), Authorization: `Bearer ${accessToken}` },
      JSON.stringify({ token: inviteToken }),
      signal,
    );
  } catch (e) { log(`invitation accept failed (will retry next session): ${e.message}`); return; }
  if (!acc.ok) { log(`invitation accept HTTP ${acc.status}: ${(acc.text || '').slice(0, 200)} (will retry)`); return; }

  // One-time: clear the invite block ONLY after a confirmed accept.
  try {
    delete cfg.invite;
    writeConfig0600(configPath, cfg);
    log(`invitation ${invitationId} accepted; invite block cleared`);
  } catch (e) { log(`could not clear invite block: ${e.message}`); }
}

// Standalone pre-register step: `node hooks/auto-register.js`. Lets onboarding
// register + accept the invitation BEFORE the first real Claude Code session, so
// the openmax MCP server comes up already-credentialed (no first-session bootstrap
// gap). Imported as a module (by session-hook.js) this block is a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureRegistered()
    .then((wrote) => process.stderr.write(`[claude-openmax auto-register] ${wrote ? 'registered + config updated' : 'no-op (already registered / nothing to do)'}\n`))
    .catch((e) => process.stderr.write(`[claude-openmax auto-register] error: ${e?.message || e}\n`))
    .finally(() => process.exit(0));
}
