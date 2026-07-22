/**
 * Adapter configuration + SDK client assembly.
 *
 * Loads the adapter's own config (local JSON file / env), builds the shared
 * TokenManager + CwsHttpClient, instantiates the six service clients, and
 * exposes the callback seams the SDK CwsAgentBridge needs (loadConfig,
 * loadSession/saveSession, onMemberId, owner/config persistence).
 *
 * ── On-disk config shape (openmax-mirrored, v0.2) ───────────────────────────
 * The on-disk config is now a 1:1 STRUCTURAL MIRROR of the OpenMax
 * (zylos-openmax) component's config, so a config.json is drop-in portable
 * between the two sibling adapters (both consume @openmaxai/openmax-agent-sdk):
 *
 * {
 *   "enabled": true,                                       // optional
 *   "server": {
 *     "bff_url":  "https://.../ (COCO_API_URL)",
 *     "ws_url":   "wss://.../cws-comm (COCO_WS_URL)",
 *     "frontend_base_path": "/workspace (COCO_FRONTEND_BASE_PATH)"
 *   },
 *   "agent": {
 *     "identity_id": "",                                   // resolved from /me if empty
 *     "api_key":     "cwsk_... (COCO_API_KEY)",
 *     "device_id":   "... (COCO_DEVICE_ID)",
 *     "app_version": "claude-openmax/0.1.0 (COCO_CLIENT_VERSION)"
 *   },
 *   "cf_access": { "client_id": "", "client_secret": "" }, // test env only
 *   "orgs": {                                              // KEYED BY org_id (openmax-style)
 *     "<org_id>": {
 *       "enabled":  true,
 *       "org_id":   "<org_id>",
 *       "org_name": "Acme",                                // display label only
 *       "owner":    { "member_id": "", "name": "" },
 *       "self":     { "member_id": "", "name": "", "display_name": "" },
 *       "access":   { "dmPolicy": "owner", "dmAllowFrom": [],
 *                     "groupPolicy": "allowlist",
 *                     "groups": { "<convId>": { "mode": "mention", "allowFrom": ["*"] } } }
 *     }
 *   },
 *   "wake": { "endpoint": "http://127.0.0.1:47600/wake" }, // claude-openmax ONLY (openmax has none)
 *   "metricsReport": { "dashboardApiKey": "" },            // RESERVED / forward-compat — INERT here
 *   "ws": { "reconnectMaxMs": 0, "heartbeatIntervalMs": 0, "pingIntervalMs": 0 } // WS tuning knobs
 * }
 *
 * ── keyed by org_id, end to end ─────────────────────────────────────────────
 * The on-disk `orgs` map is keyed by org_id (openmax-style) and so is every
 * in-memory view handed to the SDK: `loadConfig().orgs` is keyed by org_id and
 * each `orgConfig` carries its `org_id`. The SDK orchestrator keys its per-org
 * runtime records by `orgConfig.org_id` too, so there is no separate per-org
 * key to derive — org_id (a required UUID) is the single identity everywhere.
 * Every write-back (member_id via onMemberId, self.name via syncSelf, owner
 * bind) resolves the org by org_id and persists via persist().
 *
 * The old shape (top-level `http`/`auth` + array `orgs`) is still accepted:
 * normalizeConfig translates it to the new shape with a one-time warning.
 */

import fs from 'node:fs';
import path from 'node:path';

import { identityIdFromMe, purgeOrgTokenCache } from './token-guard.js';
import { safeJson, redactSecretsDeep } from './redact.js';

import {
  CwsHttpClient,
  TokenManager,
  resolveAgentIdentityId,
  createTmService,
  createKbService,
  createAsService,
  createCommService,
  createCoreService,
  createConnService,
} from '@openmaxai/openmax-agent-sdk';

const DEFAULT_APP_VERSION = 'claude-openmax/1.1.1';
const DEFAULT_FRONTEND_BASE_PATH = '/workspace';

// Hard cap on how long a single owner-sync core HTTP call may block the caller
// (the periodic owner-sync task and the owner_changed handler). Hardcoded on
// purpose — no config knob. The SDK's CwsHttpClient uses native fetch with NO
// timeout and accepts NO AbortSignal, so a hung core connection would otherwise
// stall these calls forever; see withTimeout().
const OWNER_SYNC_HTTP_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a timeout so the caller can never block indefinitely.
 *
 * NOTE: CwsHttpClient.getForOrg() cannot be hard-aborted (native fetch, no
 * AbortSignal), so this does NOT cancel the underlying request — it only stops
 * the CALLER from waiting. On timeout we reject; the dangling fetch keeps running
 * and its eventual result is simply discarded (harmless — the caller has already
 * moved on and will retry on the next tick). Scoped to owner-sync deliberately:
 * we do NOT wrap the shared CwsHttpClient or global fetch (that would also affect
 * artifact downloads etc.).
 *
 * @param {Promise<any>} promise
 * @param {number}       ms
 * @param {string}       label   included in the timeout error message
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.(); // never keep the process alive for this guard timer alone
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * MIGRATION-ONLY slugify. Before the org_id-keying refactor, per-org session
 * files were keyed by a derived slug (`explicit slug || slugify(org_name) ||
 * org_id`). This reproduces that derivation solely so `loadSession` can migrate
 * a legacy `sessions/<slug>.json` forward to `sessions/<org_id>.json` — it is NOT
 * used for any live keying (org_id is the only runtime key now).
 */
function legacySlugify(s) {
  return String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function resolveConfigPath(explicit) {
  return explicit
    || process.env.CLAUDE_OPENMAX_CONFIG
    || path.join(process.env.CLAUDE_OPENMAX_DATA_DIR
      || path.join(process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`, 'claude-openmax'),
    'config.json');
}

/**
 * Resolve the diagnostic log-file path. File logging is OPT-IN: it is enabled
 * ONLY when `CLAUDE_OPENMAX_LOG_FILE` is set, and returns `null` otherwise
 * (stderr-only — the default for a released plugin, so no unbounded file grows
 * on every user's machine). Returning a path here does not itself open a file;
 * the entry points pass it to the logger only when non-null.
 *
 * @returns {string|null} absolute log-file path, or null when file logging is off.
 */
export function resolveLogFilePath() {
  return process.env.CLAUDE_OPENMAX_LOG_FILE || null;
}

export function loadAdapterConfig(explicitPath) {
  const file = resolveConfigPath(explicitPath);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`failed to read config ${file}: ${e.message}`);
    // Absent config is allowed — fall back entirely to env (useful for tests/CI).
  }
  const config = normalizeConfig(raw);
  return { config, file };
}

/** True when `raw` is an OLD-shape config (top-level http/auth or array orgs). */
function isLegacyShape(raw) {
  return !!(raw && (raw.http || raw.auth || Array.isArray(raw.orgs)));
}

/**
 * Translate an OLD-shape config (http/auth + array orgs) into the new
 * openmax-mirrored shape. Best-effort field mapping; logs a one-time warning.
 */
function translateLegacy(raw) {
  const http = raw.http || {};
  const ws = raw.ws || {};
  const auth = raw.auth || {};
  const orgsMap = {};
  for (const o of (Array.isArray(raw.orgs) ? raw.orgs : [])) {
    if (!o || !o.org_id) continue;
    orgsMap[o.org_id] = {
      ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
      org_id: o.org_id,
      ...(o.org_name ? { org_name: o.org_name } : {}),
      owner: o.owner || { member_id: '', name: '' },
      self: o.self || { member_id: '', name: '', display_name: '' },
      access: o.access || {},
    };
  }
  return {
    ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
    server: {
      bff_url: http.baseUrl || '',
      ws_url: ws.baseUrl || '',
      frontend_base_path: raw.server?.frontend_base_path || DEFAULT_FRONTEND_BASE_PATH,
    },
    agent: {
      identity_id: raw.agent?.identity_id || '',
      api_key: auth.apiKey || '',
      device_id: ws.deviceId || '',
      app_version: ws.clientVersion || DEFAULT_APP_VERSION,
    },
    cf_access: raw.cf_access,
    orgs: orgsMap,
    wake: raw.wake || {},
    metricsReport: raw.metricsReport,
    ws: {
      reconnectMaxMs: ws.reconnectMaxMs,
      heartbeatIntervalMs: ws.heartbeatIntervalMs,
      pingIntervalMs: ws.pingIntervalMs,
    },
  };
}

/**
 * Normalize a raw on-disk config into the internal runtime shape. Applies env
 * fallbacks. Internally `orgs` is an ARRAY of records (each keyed/identified by
 * its `org_id`); persist() serializes it back to the org_id-keyed on-disk map.
 *
 * @param {object} raw   parsed config.json (may be new-shape, old-shape, or {})
 * @param {object} [opts]
 * @param {{warn?:Function}} [opts.logger]
 */
export function normalizeConfig(raw, { logger } = {}) {
  let src = raw || {};
  if (isLegacyShape(src)) {
    (logger?.warn || ((m) => process.stderr.write(`${m}\n`)))(
      '[config] OLD-shape config detected (top-level http/auth or array orgs) — '
      + 'translating to the openmax-mirrored shape. Please migrate config.json; '
      + 'see config.example.json / README "Migrating from the openmax component".',
    );
    src = translateLegacy(src);
  }

  const server = src.server || {};
  const agent = src.agent || {};
  const wsTuning = src.ws || {};

  const orgsRaw = (src.orgs && typeof src.orgs === 'object' && !Array.isArray(src.orgs)) ? src.orgs : {};
  const orgs = [];
  for (const [orgIdKey, org] of Object.entries(orgsRaw)) {
    if (!org || typeof org !== 'object') continue;
    const org_id = org.org_id || orgIdKey;
    if (!org_id) continue;
    orgs.push({
      enabled: org.enabled,
      org_id,
      org_name: org.org_name || '',
      owner: org.owner || { member_id: '', name: '' },
      self: org.self || { member_id: '', name: '', display_name: '' },
      access: org.access || {},
      // Migration hint only (NOT persisted — serializeOrg omits it): the explicit
      // pre-refactor slug, used by loadSession to find a legacy session file.
      ...(org.slug ? { _legacySlug: String(org.slug) } : {}),
    });
  }

  return {
    enabled: src.enabled,
    server: {
      bff_url: server.bff_url || process.env.COCO_API_URL || '',
      ws_url: server.ws_url || process.env.COCO_WS_URL || '',
      frontend_base_path: server.frontend_base_path
        || process.env.COCO_FRONTEND_BASE_PATH
        || DEFAULT_FRONTEND_BASE_PATH,
    },
    agent: {
      identity_id: agent.identity_id || '',
      api_key: agent.api_key || process.env.COCO_API_KEY || '',
      device_id: agent.device_id || process.env.COCO_DEVICE_ID || '',
      app_version: agent.app_version || process.env.COCO_CLIENT_VERSION || DEFAULT_APP_VERSION,
    },
    cf_access: src.cf_access,
    orgs,
    wake: src.wake || {},
    // RESERVED / forward-compat: claude-openmax has no metrics reporter yet, so
    // this is accepted and persisted but otherwise INERT.
    metricsReport: src.metricsReport,
    // claude-openmax-specific WS tuning knobs (openmax lacks these); baseUrl /
    // deviceId / clientVersion now live under server.* / agent.*.
    ws: {
      reconnectMaxMs: wsTuning.reconnectMaxMs,
      heartbeatIntervalMs: wsTuning.heartbeatIntervalMs,
      pingIntervalMs: wsTuning.pingIntervalMs,
    },
  };
}

/**
 * Resolve the agent's global identity_id and cache it back into the config.
 * Prefers `agent.identity_id` when already set (no network); otherwise reads it
 * from cws-core `GET /me` via the SDK's resolveAgentIdentityId and persists it.
 * Best-effort: never throws — returns '' on failure.
 *
 * `leadAgentId` for the guided-autonomy flow (tm issueCreate) == this value.
 *
 * @param {object}   params
 * @param {object}   params.http       CwsHttpClient (or { get, apiPath } stub)
 * @param {object}   params.agent      the mutable agent config record (gets identity_id cached in)
 * @param {Function} params.persist    persist() to write the cache back to disk
 * @param {object}   [params.logger]
 * @returns {Promise<string>}          identity_id (or '' when unresolved)
 */
export async function resolveAndCacheIdentityId({ http, agent, persist, logger }) {
  if (agent?.identity_id) return agent.identity_id;
  try {
    const id = await resolveAgentIdentityId({ http, config: { agent } });
    if (id) {
      agent.identity_id = String(id);
      persist?.();
      logger?.info?.(`identity_id resolved from /me and cached: ${id}`);
    }
    return id || '';
  } catch (e) {
    logger?.warn?.(`identity_id resolution failed: ${e.message}`);
    return '';
  }
}

/**
 * Build the SDK clients + callback seams from a normalized config.
 *
 * @param {object} params
 * @param {object} params.config    normalized adapter config (from normalizeConfig)
 * @param {string} params.file      config file path (for persistence)
 * @param {object} params.storage   StorageProvider
 * @param {object} params.logger
 * @param {object} [params.httpClient]  test seam: inject a CwsHttpClient stub
 *        (defaults to a real CwsHttpClient wired to server.* / agent.* / cf_access).
 * @param {number} [params.ownerSyncTimeoutMs]  TEST SEAM ONLY — per-call timeout for
 *        the owner-sync core fetches. Production always uses the hardcoded
 *        OWNER_SYNC_HTTP_TIMEOUT_MS (no config.json knob); tests override it to
 *        keep a hanging-stub timeout test fast.
 */
export function buildRuntime({ config, file, storage, logger, httpClient, ownerSyncTimeoutMs = OWNER_SYNC_HTTP_TIMEOUT_MS }) {
  // Mutable in-memory config mirror; persisted back to `file` (in the
  // openmax-mirrored, org_id-keyed on-disk shape) on writes so the SDK's
  // member_id write-back / owner bind / self.name / identity_id / agent.config.*
  // events survive a restart (the SDK never writes config itself — that is the
  // adapter's job).
  const state = {
    enabled: config.enabled,
    server: { ...config.server },
    agent: { ...config.agent },
    cf_access: config.cf_access,
    orgs: cloneOrgs(config.orgs),
    wake: config.wake,
    metricsReport: config.metricsReport,
    ws: { ...config.ws },
  };

  // Serialize one internal org record back to its on-disk (openmax) form.
  const serializeOrg = (o) => ({
    ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
    org_id: o.org_id,
    ...(o.org_name ? { org_name: o.org_name } : {}),
    owner: o.owner || { member_id: '', name: '' },
    self: o.self || { member_id: '', name: '', display_name: '' },
    access: o.access || {},
  });

  const persist = () => {
    try {
      const out = {
        ...(state.enabled !== undefined ? { enabled: state.enabled } : {}),
        server: state.server,
        agent: state.agent,
        ...(state.cf_access !== undefined ? { cf_access: state.cf_access } : {}),
        // orgs: org_id-keyed map (openmax shape)
        orgs: Object.fromEntries(state.orgs.map((o) => [o.org_id, serializeOrg(o)])),
        ...(state.wake !== undefined ? { wake: state.wake } : {}),
        ...(state.metricsReport !== undefined ? { metricsReport: state.metricsReport } : {}),
        ...(hasWsTuning(state.ws) ? { ws: state.ws } : {}),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      // 0o600: the config holds secrets (agent.api_key, cf_access.client_secret).
      // A plain writeFileSync defaults to 0o644 and would rewrite the file
      // world-readable on every self-healing write-back (member_id / owner bind /
      // identity_id cache / config events) — a credential-exposure regression.
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      logger?.info?.(`config persisted to ${file}`);
    } catch (e) {
      // Observability: a swallowed warn hid persist failures. Surface it at ERROR
      // with the target path + the error (behavior unchanged — still non-fatal).
      logger?.error?.(`config persist FAILED to ${file}: ${e.message}`);
    }
  };

  const orgByOrgId = (id) => state.orgs.find((o) => o.org_id === id);
  // Orgs the runtime should actually connect to: `enabled: false` opts an org out
  // (mirrors the openmax component). `state.orgs` keeps ALL orgs so persist() never
  // drops a disabled one from disk; only the SDK-facing views are filtered.
  const activeOrgs = () => state.orgs.filter((o) => o.enabled !== false);
  const resolveDefaultOrgId = () => activeOrgs()[0]?.org_id || process.env.COCO_ORG_ID || '';

  // Self-healing member_id write-back: when the SDK resolves the agent's per-org
  // member_id (from the JWT claim), stash it into the org's `self` block and
  // persist — into the org_id-keyed on-disk structure. Reachable for tests.
  const applyMemberId = (orgId, memberId) => {
    const org = orgByOrgId(orgId);
    if (org && memberId && org.self?.member_id !== memberId) {
      org.self = { ...(org.self || {}), member_id: memberId };
      persist();
      logger?.info?.(`member_id resolved for org=${org.org_id}: ${memberId}`);
      return true;
    }
    return false;
  };

  // The SDK's cfAccessHeaders() reads `cfAccess.cf_access.{client_id,client_secret}`
  // (WRAPPED). `state.cf_access` is the bare { client_id, client_secret } block,
  // so it must be wrapped as { cf_access: ... } — passing it bare makes the SDK
  // read `.cf_access` off the wrong object and emit EMPTY CF-Access headers.
  const cfAccessWrapped = state.cf_access ? { cf_access: state.cf_access } : undefined;

  const tokenManager = new TokenManager({
    apiKey: state.agent.api_key,
    coreUrl: state.server.bff_url,
    cfAccess: cfAccessWrapped,
    storage,
    resolveDefaultOrgId,
    onMemberId: applyMemberId,
    logger,
  });

  const http = httpClient || new CwsHttpClient({
    baseUrl: state.server.bff_url,
    apiKey: state.agent.api_key,
    deviceId: state.agent.device_id,
    clientVersion: state.agent.app_version,
    cfAccess: cfAccessWrapped,
    // Wire the SDK's built-in frontend-link builder (frontendUrl(p)) to the
    // configured SPA mount point — enables clickable /workspace links.
    frontendBasePath: state.server.frontend_base_path,
    tokenManager,
    resolveDefaultOrgId,
    logger,
  });

  // Config provider for the config-coupled service methods (comm dm_* / owner).
  const configProvider = {
    enabledOrgs: () => activeOrgs(),
    getOrgByOrgId: orgByOrgId,
    updateConfig: (fn) => {
      const cfg = { orgs: Object.fromEntries(state.orgs.map((o) => [o.org_id, o])) };
      fn(cfg);
      // reflect back mutations keyed by org_id into the array
      state.orgs = Object.values(cfg.orgs);
      persist();
      return cfg;
    },
    setOwner: (orgId, memberId, name) => {
      const org = orgByOrgId(orgId);
      if (org) { org.owner = { member_id: memberId, name: name || '' }; persist(); }
    },
  };

  const services = {
    tm: createTmService(http),
    kb: createKbService(http),
    as: createAsService(http, storage),
    comm: createCommService(http, configProvider),
    core: createCoreService(http, configProvider),
    conn: createConnService(http, storage, () => orgByOrgId(resolveDefaultOrgId())?.self?.member_id || ''),
  };

  // ── SDK callbacks ─────────────────────────────────────────────────────────
  // The SDK keys per-org runtime records by org_id — hand it the same
  // org_id-keyed view of the on-disk store (enabled orgs only).
  const loadConfig = () => ({ orgs: Object.fromEntries(activeOrgs().map((o) => [o.org_id, o])) });

  // Legacy per-org session keys (pre org_id-keying): explicit slug, else
  // slugify(org_name). org_id itself is excluded (that's the new key).
  const legacySessionKeys = (orgId) => {
    const org = orgByOrgId(orgId);
    if (!org) return [];
    return [org._legacySlug, legacySlugify(org.org_name)].filter((k) => k && k !== orgId);
  };

  const loadSession = async (orgId) => {
    try {
      const raw = await storage.get(path.join('sessions', `${orgId}.json`));
      if (raw) return JSON.parse(raw);
      // One-time forward-migration: before the org_id-keying refactor, sessions
      // were stored as `sessions/<slug>.json`. If a legacy-keyed session exists,
      // copy it to the org_id key so the `/sync` cursor survives the upgrade —
      // otherwise the cursor resets and already-delivered messages get re-fetched
      // (duplicate delivery). Copy-forward only; the old file is left in place.
      for (const legacy of legacySessionKeys(orgId)) {
        const old = await storage.get(path.join('sessions', `${legacy}.json`));
        if (old != null) {
          await storage.set(path.join('sessions', `${orgId}.json`), old);
          logger?.info?.(`migrated session sessions/${legacy}.json → sessions/${orgId}.json`);
          return JSON.parse(old);
        }
      }
      return {};
    } catch { return {}; }
  };
  const saveSession = async (orgId, partial) => {
    const cur = await loadSession(orgId);
    await storage.set(path.join('sessions', `${orgId}.json`), JSON.stringify({ ...cur, ...partial }));
  };

  const syncSelf = async (orgConfig) => {
    // Hydrate the authoritative self display_name from cws-core (/me).
    try {
      const me = await http.getForOrg(orgConfig.org_id, http.apiPath('/me'));
      // ── identity mismatch guard (belt-and-suspenders) ─────────────────────
      // If a specific identity is configured and /me comes back as a DIFFERENT
      // identity, the org-keyed token cache handed us a STALE JWT (minted with a
      // previous api_key) — we are connected as the WRONG identity. Warn LOUDLY
      // and purge this org's cached token/session/inbox so the next bootstrap
      // re-exchanges a fresh JWT for the correct identity.
      const wanted = state.agent.identity_id;
      const got = identityIdFromMe(me);
      if (wanted && got && wanted !== got) {
        logger?.error?.(
          `[IDENTITY MISMATCH] org=${orgConfig.org_id}: configured agent.identity_id=${wanted} `
          + `but /me reports ${got}. A STALE org-keyed JWT (minted with a previous api_key) is in `
          + 'use — the agent is running as the WRONG identity. Purging cached token/session/inbox for '
          + 'this org; restart to re-exchange a fresh JWT for the correct identity.',
        );
        await purgeOrgTokenCache({ storage, orgId: orgConfig.org_id, logger, reason: 'identity_id mismatch vs /me' });
      }
      const name = me?.display_name || me?.username || '';
      if (name) {
        const org = orgByOrgId(orgConfig.org_id);
        if (org) { org.self = { ...(org.self || {}), name }; persist(); }
        return { nameReady: true, displayName: name, source: 'core' };
      }
    } catch (e) {
      logger?.warn?.(`syncSelf(${orgConfig.org_id}) failed: ${e.message}`);
    }
    return { nameReady: false, reason: 'core returned no display_name' };
  };

  // Pull-based owner reconciliation. cws-core is the authoritative source of an
  // org's owner binding, so we resolve OUR OWN member record from core, read its
  // `owner_member_id`, and reconcile that into local config (setOwner + persist).
  // This is the single trust anchor for owner changes: the periodic sync
  // (owner-sync.js) and the owner_changed config event (onConfigEvent below) both
  // route through here — we NEVER trust an owner value handed to us in a frame.
  // Best-effort: swallows its own errors and returns a {changed} result; a core
  // outage leaves the local owner untouched rather than clearing it.
  const syncOwnerFromCore = async (orgConfig) => {
    const org = orgByOrgId(orgConfig.org_id);
    const selfMemberId = org?.self?.member_id || orgConfig.self?.member_id || '';
    if (!selfMemberId) {
      // member_id is written back by the token exchange (applyMemberId); until it
      // lands we cannot identify our own member record — retry on the next tick.
      return { changed: false, reason: 'self.member_id not available yet' };
    }
    let member;
    try {
      // Timeout-guarded so a hung core connection can never block the periodic
      // task / owner_changed handler. A timeout lands here exactly like any other
      // fetch failure: keep the local owner, return {changed:false}, retry next tick.
      member = await withTimeout(
        http.getForOrg(orgConfig.org_id, http.apiPath(`/members/${encodeURIComponent(selfMemberId)}`)),
        ownerSyncTimeoutMs,
        `syncOwnerFromCore self-member fetch (org=${orgConfig.org_id})`,
      );
    } catch (e) {
      logger?.warn?.(`syncOwnerFromCore(${orgConfig.org_id}) fetch self member failed: ${e.message} — keeping local owner`);
      return { changed: false, reason: `fetch self member failed: ${e.message}` };
    }

    const coreOwnerId = member?.owner_member_id || '';
    // Core has no authoritative owner → leave the local binding as-is so the
    // first-DM auto-bind fallback keeps working. We never CLEAR a local owner here.
    if (!coreOwnerId) return { changed: false, reason: 'core has no owner bound' };

    const localOwnerId = org?.owner?.member_id || '';
    const localOwnerName = org?.owner?.name || '';
    // Fully in sync (id matches AND we already have a name) → nothing to do.
    // We deliberately do NOT early-return when the id matches but the local name
    // is EMPTY: a prior owner-name fetch may have timed out/failed and persisted
    // an empty name, and this is the path that backfills it on a later tick.
    if (coreOwnerId === localOwnerId && localOwnerName) {
      return { changed: false, ownerMemberId: coreOwnerId };
    }

    // Owner display name is cosmetic — a lookup failure (incl. timeout) must not
    // block the bind; we proceed with an empty name and let a later sync fill it.
    let ownerName = '';
    try {
      const ownerMember = await withTimeout(
        http.getForOrg(orgConfig.org_id, http.apiPath(`/members/${encodeURIComponent(coreOwnerId)}`)),
        ownerSyncTimeoutMs,
        `syncOwnerFromCore owner-name fetch (org=${orgConfig.org_id})`,
      );
      ownerName = ownerMember?.display_name || ownerMember?.username || '';
    } catch { /* display name is cosmetic */ }

    // Only write when something ACTUALLY changed — a new owner id, or a non-empty
    // fetched name that differs from the local one (the backfill case). If core
    // still returns no name for an already-bound owner, we skip the write so a
    // steady state does not re-persist an empty name on every periodic tick.
    const idChanged = coreOwnerId !== localOwnerId;
    const nameChanged = !!ownerName && ownerName !== localOwnerName;
    if (!idChanged && !nameChanged) {
      return { changed: false, ownerMemberId: coreOwnerId };
    }

    // Persist to config.json AND mutate the live captured orgConfig in place so
    // the SDK's owner-gated access decisions see the new owner without a restart.
    // (For a same-id name backfill, ownerName is guaranteed non-empty here; for an
    // owner change we bind whatever name we resolved — possibly '' if it failed.)
    configProvider.setOwner(orgConfig.org_id, coreOwnerId, ownerName);
    orgConfig.owner = { member_id: coreOwnerId, name: ownerName };
    logger?.info?.(`owner synced from core for org=${orgConfig.org_id}: ${localOwnerId || '(none)'} → ${coreOwnerId}${ownerName ? ` (${ownerName})` : ''}${idChanged ? '' : ' (name backfill)'}`);
    return { changed: true, ownerMemberId: coreOwnerId, ownerName, previousOwnerMemberId: localOwnerId };
  };

  const callbacks = {
    loadConfig,
    loadSession,
    saveSession,
    syncSelf,
    onOwnerBind: (orgId, memberId, displayName) => configProvider.setOwner(orgId, memberId, displayName),
    onOwnerNameHint: (orgId, name) => {
      const org = orgByOrgId(orgId);
      if (org) { org.owner = { ...(org.owner || {}), name }; persist(); }
    },
    onConfigEvent: async (orgConfig, { event, data }) => {
      // ── DIAGNOSTIC LOGGING (logging-only; control flow + mutations unchanged) ──
      // Purpose: from the log alone, tell exactly which step of applying a
      // workspace policy/access change failed / why it "doesn't take effect".
      const dataKeys = (data && typeof data === 'object') ? Object.keys(data) : [];
      logger?.info?.(`[onConfigEvent] event=${event} org=${orgConfig.org_id} dataKeys=${safeJson(dataKeys)} data=${safeJson(redactSecretsDeep(data))}`);

      // owner_changed is SECURITY-SENSITIVE. The frame carries a
      // new_owner_member_id, but owner is the DM-access trust anchor, so a forged
      // or replayed frame must never be able to rebind us to an attacker. We do
      // NOT read the owner out of `data`; instead we treat the event purely as a
      // signal to RE-PULL the authoritative owner from cws-core and ignore the
      // frame's owner fields entirely (pull-not-trust — parity with the openmax
      // component's owner_changed handling).
      if (event === 'agent.config.owner_changed') {
        logger?.info?.(`[onConfigEvent] ${event} → routing to syncOwnerFromCore (pull-not-trust; frame owner ignored) org=${orgConfig.org_id}`);
        const res = await syncOwnerFromCore(orgConfig); // never throws; result is best-effort
        logger?.info?.(`[onConfigEvent] owner_changed syncOwnerFromCore result org=${orgConfig.org_id}: ${safeJson(res)}`);
        return;
      }
      // Other agent.config.* → map the event's REAL payload fields into the org's
      // access block (event-type-aware; see applyConfigAccessEvent). The old code
      // ran a generic pickAccess that only copied literal dmPolicy/dmAllowFrom/
      // groupPolicy keys and DROPPED policy/scope/action/conversation_ids/… — so a
      // workspace group/DM policy change arrived, picked {}, and never took effect.
      const org = orgByOrgId(orgConfig.org_id);
      if (!org) {
        logger?.warn?.(`[onConfigEvent] org NOT resolved by orgByOrgId(${orgConfig.org_id}) — access change is NOT applied/persisted (event effectively dropped). Known state.orgs ids=${safeJson(state.orgs.map((o) => o.org_id))}`);
        return;
      }
      if (!data || typeof data !== 'object') {
        logger?.warn?.(`[onConfigEvent] data missing or not an object (data=${safeJson(data)}) — nothing to apply org=${orgConfig.org_id}`);
        return;
      }

      // "Not for us" guard (parity with zylos-openmax handleConfigUpdate): a config
      // event may carry a target agent_member_id; if it names a DIFFERENT member than
      // us, skip it. Only enforced when we actually know our own member_id — before
      // the token exchange writes it back (applyMemberId) self.member_id is '' and we
      // must not drop events on an empty comparison.
      const selfMemberId = org.self?.member_id || orgConfig.self?.member_id || '';
      if (data.agent_member_id && selfMemberId && data.agent_member_id !== selfMemberId) {
        logger?.info?.(`[onConfigEvent] event=${event} not for us (target=${data.agent_member_id}, self=${selfMemberId}) — skip org=${orgConfig.org_id}`);
        return;
      }

      // The SDK hands us ITS orgConfig object; we mutate the INTERNAL state.orgs
      // record resolved here (that is what persist() serializes). In this adapter
      // they are normally the SAME object (loadConfig/orgConfigs hand out the live
      // state.orgs refs), but we do not assume it: after mutating org.access we also
      // point orgConfig.access at it when they differ, so the SDK's live access gate
      // reflects the change immediately without a reload (mirrors zylos-openmax's
      // "sync the live reference directly" epilogue).
      const sameRef = org === orgConfig;
      org.access = org.access || {};
      logger?.info?.(`[onConfigEvent] resolved internal org=${orgConfig.org_id}; sameObjectAsSdkOrgConfig=${sameRef}`);
      logger?.info?.(`[onConfigEvent] org.access BEFORE=${safeJson(org.access)} | sdk orgConfig.access=${safeJson(orgConfig.access)}`);

      const result = applyConfigAccessEvent(org.access, event, data);
      if (!result.applied) {
        logger?.warn?.(`[onConfigEvent] ${result.unknown ? '' : `${event}: `}${result.reason} — nothing applied org=${orgConfig.org_id} (org.access unchanged=${safeJson(org.access)})`);
        return;
      }

      // Sync the SDK's live access reference when it is a different object.
      if (!sameRef) orgConfig.access = org.access;

      logger?.info?.(`[onConfigEvent] applied: ${result.summary} (by ${data.changed_by || '?'}) org=${orgConfig.org_id}`);
      logger?.info?.(`[onConfigEvent] org.access AFTER=${safeJson(org.access)}${sameRef ? '' : ' | sdk orgConfig.access synced to internal record → live gate updated immediately'}`);
      persist();
    },
    onConnectionEvent: (orgConfig) => logger?.info?.(`connection event for org=${orgConfig.org_id} (Cat.B no-op)`),
    onChannelEvent: (orgConfig) => logger?.info?.(`channel event for org=${orgConfig.org_id} (Cat.B no-op)`),
    onOrgTerminated: (orgConfig, code, reason) =>
      logger?.error?.(`org ${orgConfig.org_id} terminated code=${code} reason="${reason || ''}"`),
    onAllOrgsTerminated: () => logger?.error?.('all orgs terminated'),
  };

  // WS connection config for CwsAgentBridge: baseUrl/deviceId/clientVersion now
  // come from server.* / agent.*, tuning knobs from the `ws` block. cf_access is
  // threaded so the WS handshake gets CF-Access headers from config.json too
  // (env COCO_CF_ACCESS_* still takes precedence inside the SDK).
  const wsConfig = {
    baseUrl: state.server.ws_url,
    deviceId: state.agent.device_id,
    clientVersion: state.agent.app_version,
    cf_access: state.cf_access,
    reconnectMaxMs: state.ws.reconnectMaxMs,
    heartbeatIntervalMs: state.ws.heartbeatIntervalMs,
    pingIntervalMs: state.ws.pingIntervalMs,
  };

  return {
    http,
    tokenManager,
    services,
    // enabled orgs only — the SDK connects to what's here; `enabled:false` opts out.
    orgConfigs: activeOrgs(),
    callbacks,
    persist,
    resolveDefaultOrgId,
    configProvider,
    wsConfig,
    applyMemberId,
    // Pull-based owner reconciliation against cws-core. Exposed so the periodic
    // owner-sync task (owner-sync.js) can reconcile every active org on an
    // interval; the owner_changed config event routes through the same path.
    syncOwnerFromCore,
    // Current cached identity_id (may be '' until resolveIdentityId() runs). The
    // guided-autonomy flow's leadAgentId (tm issueCreate lead agent = self) is
    // exactly this value.
    get identityId() { return state.agent.identity_id || ''; },
    // Resolve identity_id from /me (if not configured) and cache it back to disk.
    resolveIdentityId: () => resolveAndCacheIdentityId({ http, agent: state.agent, persist, logger }),
  };
}

function cloneOrgs(orgs) {
  return orgs.map((o) => ({ ...o }));
}

function hasWsTuning(ws) {
  return !!ws && (ws.reconnectMaxMs != null || ws.heartbeatIntervalMs != null || ws.pingIntervalMs != null);
}

// Validation sets, mirrored 1:1 from the proven zylos-openmax comm-bridge
// handleConfigUpdate. Values outside these sets are rejected (event dropped
// with a warning) rather than written into the access block.
const VALID_DM_POLICIES = new Set(['open', 'allowlist', 'owner']);
const VALID_GROUP_SCOPES = new Set(['open', 'allowlist', 'disabled']);
const VALID_GROUP_MODES = new Set(['smart', 'mention', 'silent']);

/**
 * Apply ONE `agent.config.*` policy/access event to an `access` block IN PLACE,
 * mapping each event type's REAL payload fields onto the claude-openmax access
 * shape ({dmPolicy, dmAllowFrom, groupPolicy, groups:{<convId>:{mode,allowFrom}}}).
 *
 * This replaces the old generic `pickAccess` (which only copied literal
 * dmPolicy/dmAllowFrom/groupPolicy keys and silently DROPPED the real event
 * fields — policy/scope/action/member_ids/conversation_id(s)/allow_from/mode —
 * so a workspace policy change never took effect). It is an event-type-aware
 * switch mirroring zylos-openmax's handleConfigUpdate.
 *
 * Does NOT persist and does NOT touch the SDK's live orgConfig — the caller owns
 * both (so the mutation, the live-gate sync, and persist() stay together and the
 * diagnostic logging can wrap them). owner_changed is handled separately by the
 * caller (pull-not-trust) and is intentionally NOT a case here.
 *
 * @param {object} access  the org's access block, mutated in place (caller ensures it exists)
 * @param {string} event   the agent.config.* event name
 * @param {object} data    the event payload (already known to be a non-null object)
 * @returns {{applied:boolean, summary?:string, reason?:string, unknown?:boolean}}
 *   applied:true + a human summary when a change was written; applied:false with a
 *   reason (and unknown:true for an unrecognized event) when nothing was applied.
 */
function applyConfigAccessEvent(access, event, data) {
  switch (event) {
    case 'agent.config.dm_policy_changed': {
      const { policy } = data;
      if (!VALID_DM_POLICIES.has(policy)) return { applied: false, reason: `invalid dm policy "${policy}"` };
      access.dmPolicy = policy;
      return { applied: true, summary: `dmPolicy → ${policy}` };
    }

    case 'agent.config.dm_allowlist_changed': {
      const { action, member_ids: memberIds } = data;
      if (!Array.isArray(memberIds) || !memberIds.length) return { applied: false, reason: 'missing or empty member_ids' };
      access.dmAllowFrom = access.dmAllowFrom || [];
      if (action === 'add') {
        const existing = new Set(access.dmAllowFrom);
        for (const id of memberIds) if (!existing.has(id)) access.dmAllowFrom.push(id);
      } else if (action === 'remove') {
        const toRemove = new Set(memberIds);
        access.dmAllowFrom = access.dmAllowFrom.filter((id) => !toRemove.has(id));
      } else if (action === 'set') {
        access.dmAllowFrom = [...memberIds];
      } else {
        return { applied: false, reason: `unknown action "${action}"` };
      }
      return { applied: true, summary: `dmAllowFrom ${action} ${memberIds.length} member(s)` };
    }

    case 'agent.config.group_mode_changed': {
      const { mode, conversation_id: convId } = data;
      if (!VALID_GROUP_MODES.has(mode)) return { applied: false, reason: `invalid mode "${mode}"` };
      if (!convId) return { applied: false, reason: 'missing conversation_id' };
      access.groups = access.groups || {};
      if (mode === 'silent') {
        delete access.groups[convId];
      } else {
        access.groups[convId] = access.groups[convId] || { allowFrom: ['*'] };
        access.groups[convId].mode = mode;
      }
      return { applied: true, summary: `group ${convId} mode → ${mode}` };
    }

    case 'agent.config.group_allowfrom_changed': {
      const { allow_from: allowFrom, conversation_id: convId } = data;
      if (!convId) return { applied: false, reason: 'missing conversation_id' };
      if (!Array.isArray(allowFrom)) return { applied: false, reason: 'allow_from is not an array' };
      access.groups = access.groups || {};
      if (!access.groups[convId]) {
        access.groups[convId] = { mode: 'mention', allowFrom: [...allowFrom] };
      } else {
        access.groups[convId].allowFrom = [...allowFrom];
      }
      return { applied: true, summary: `group ${convId} allowFrom → ${safeJson(allowFrom)}` };
    }

    case 'agent.config.group_scope_changed': {
      const { scope } = data;
      if (!VALID_GROUP_SCOPES.has(scope)) return { applied: false, reason: `invalid scope "${scope}"` };
      access.groupPolicy = scope;
      return { applied: true, summary: `groupPolicy → ${scope}` };
    }

    case 'agent.config.group_allowlist_changed': {
      const { action, conversation_ids: convIds } = data;
      if (!Array.isArray(convIds)) return { applied: false, reason: 'conversation_ids is not an array' };
      if (!['add', 'remove', 'set'].includes(action)) return { applied: false, reason: `unknown action "${action}"` };
      access.groups = access.groups || {};
      if (action === 'add') {
        for (const id of convIds) {
          if (!access.groups[id]) access.groups[id] = { mode: 'mention', allowFrom: ['*'] };
        }
      } else if (action === 'remove') {
        for (const id of convIds) delete access.groups[id];
      } else { // 'set'
        const old = access.groups;
        access.groups = {};
        for (const id of convIds) access.groups[id] = old[id] || { mode: 'mention', allowFrom: ['*'] };
      }
      return { applied: true, summary: `group_allowlist ${action} ${convIds.length} conversation(s)` };
    }

    default:
      return { applied: false, unknown: true, reason: `unknown config event "${event}"` };
  }
}
