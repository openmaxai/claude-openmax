/**
 * SessionStart-time agent auto-registration (idempotent) — the claude-openmax
 * analog of `zylos add`'s post-install auto-register.
 *
 * Claude Code has no literal install/upgrade hook, so this runs on SessionStart:
 * on the first session after install (or after an upgrade) it self-heals a config
 * that has no api_key yet; on every subsequent session it is a no-op.
 *
 * Behavior: if the config's agent.api_key is still blank/placeholder AND we have a
 * bff_url + CF-Access credentials (from the config's own server/cf_access, or from
 * env), POST an empty body to `{bff_url}/auth/register/agent` and persist the
 * returned identity_id + api_key back into the config at 0600. Optionally, if the
 * config carries an `invite` block (or COCO_INVITATION_ID/COCO_INVITATION_TOKEN
 * env), also exchange the api_key for a token and accept the invitation, then drop
 * the one-time invite block.
 *
 * Discipline (same as the orientation hook): pure Node builtins (+ global fetch),
 * never throws, best-effort — a failure logs to stderr and degrades silently so it
 * can never perturb the session.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLACEHOLDER_API_KEYS = new Set(['', 'cwsk_replace_me']);
const REQUEST_TIMEOUT_MS = 6000;

/** Resolve the config path the same way src/config.js does. */
export function resolveConfigPath() {
  if (process.env.CLAUDE_OPENMAX_CONFIG) return process.env.CLAUDE_OPENMAX_CONFIG;
  const dir = process.env.CLAUDE_OPENMAX_DATA_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-openmax');
  return path.join(dir, 'config.json');
}

function log(msg) { try { process.stderr.write(`[claude-openmax auto-register] ${msg}\n`); } catch { /* ignore */ } }

function cfHeaders(id, secret) {
  return { 'Content-Type': 'application/json', 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}

async function postJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: body ?? '{}', signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { ok: res.ok, status: res.status, text, json };
  } finally { clearTimeout(timer); }
}

/**
 * Register the agent if needed and persist creds. Returns true if it wrote new
 * credentials, false if it was a no-op / could not proceed. Never throws.
 */
export async function ensureRegistered() {
  const configPath = resolveConfigPath();
  let cfg = {};
  try {
    if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) { log(`config unreadable (${configPath}): ${e.message}`); return false; }

  const server = cfg.server || {};
  const agent = cfg.agent || {};
  const cf = cfg.cf_access || {};

  const bffUrl = (server.bff_url || process.env.COCO_API_URL || '').replace(/\/+$/, '');
  const apiKey = agent.api_key || process.env.COCO_API_KEY || '';
  const cfId = cf.client_id || process.env.COCO_CF_ACCESS_CLIENT_ID || '';
  const cfSecret = cf.client_secret || process.env.COCO_CF_ACCESS_CLIENT_SECRET || '';

  // Idempotent: a real api_key is already present → nothing to do.
  if (!PLACEHOLDER_API_KEYS.has(apiKey)) return false;
  if (!bffUrl) { log('no bff_url (config.server.bff_url / COCO_API_URL) — skipping'); return false; }
  if (!cfId || !cfSecret) { log('no CF-Access credentials — skipping'); return false; }

  log(`registering agent: POST ${bffUrl}/auth/register/agent`);
  let reg;
  try { reg = await postJson(`${bffUrl}/auth/register/agent`, cfHeaders(cfId, cfSecret), '{}'); }
  catch (e) { log(`register request failed: ${e.message}`); return false; }
  if (!reg.ok) { log(`register HTTP ${reg.status}: ${(reg.text || '').slice(0, 200)}`); return false; }

  const data = (reg.json && (reg.json.data || reg.json)) || {};
  const identityId = data.identity_id || '';
  const newKey = data.api_key || '';
  if (!identityId || !newKey) { log('register response missing identity_id/api_key'); return false; }

  // Persist creds back into the config, merging with what's there, at 0600.
  try {
    cfg.agent = { ...(cfg.agent || {}), identity_id: identityId, api_key: newKey };
    cfg.cf_access = { client_id: cfId, client_secret: cfSecret };
    if (!cfg.server) cfg.server = {};
    if (!cfg.server.bff_url) cfg.server.bff_url = bffUrl;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    // writeFileSync's mode is ignored when the file already exists — the config
    // holds secrets (api_key, cf_access.client_secret), so force 0600.
    chmodSync(configPath, 0o600);
    log(`registered: identity_id=${identityId} — written to ${configPath} (0600)`);
  } catch (e) { log(`persist failed: ${e.message}`); return false; }

  // Optional turnkey step: accept an invitation if one was supplied.
  await maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey: newKey, cfId, cfSecret });
  return true;
}

async function maybeAcceptInvite({ cfg, configPath, bffUrl, apiKey, cfId, cfSecret }) {
  const invite = cfg.invite || {};
  const invitationId = invite.invitation_id || process.env.COCO_INVITATION_ID || '';
  const inviteToken = invite.token || process.env.COCO_INVITATION_TOKEN || '';
  if (!invitationId || !inviteToken) return; // nothing to accept

  log('invite supplied — exchanging token + accepting invitation');
  let tok;
  try { tok = await postJson(`${bffUrl}/auth/agent/token`, { ...cfHeaders(cfId, cfSecret), Authorization: `Bearer ${apiKey}` }, '{}'); }
  catch (e) { log(`token exchange failed: ${e.message}`); return; }
  const accessToken = tok.json && (tok.json.data ? tok.json.data.access_token : tok.json.access_token);
  if (!tok.ok || !accessToken) { log(`token exchange HTTP ${tok?.status}: no access_token`); return; }

  let acc;
  try {
    acc = await postJson(
      `${bffUrl}/api/v1/invitations/${invitationId}/accept`,
      { ...cfHeaders(cfId, cfSecret), Authorization: `Bearer ${accessToken}` },
      JSON.stringify({ token: inviteToken }),
    );
  } catch (e) { log(`invitation accept failed: ${e.message}`); return; }
  if (!acc.ok) { log(`invitation accept HTTP ${acc.status}: ${(acc.text || '').slice(0, 200)}`); return; }

  // One-time: drop the invite block so we don't re-accept on later sessions.
  try {
    delete cfg.invite;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    chmodSync(configPath, 0o600);
    log(`invitation ${invitationId} accepted; invite block cleared`);
  } catch (e) { log(`could not clear invite block: ${e.message}`); }
}
