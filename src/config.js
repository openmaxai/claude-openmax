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
 *       "org_name": "Acme",                                // display only; slug source
 *       "slug":     "acme",                                // OPTIONAL explicit slug override
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
 * ── org_id ⇄ slug bridge ────────────────────────────────────────────────────
 * The on-disk `orgs` map is keyed by org_id (openmax-style). The SDK
 * orchestrator, however, keys its per-org runtime records by a `slug`
 * (`for (const [slug, rec] of this._orgs)`, `loadConfig().orgs?.[slug]`).
 * `normalizeConfig` therefore derives a stable `slug` per org — an explicit
 * `slug` wins, else a slugified `org_name`, else the org_id — and `buildRuntime`
 * bridges the two: the SDK sees slug-keyed orgs while every write-back
 * (member_id via onMemberId, self.name via syncSelf, owner bind) lands back in
 * the org_id-keyed on-disk structure via persist().
 *
 * The old shape (top-level `http`/`auth` + array `orgs`) is still accepted:
 * normalizeConfig translates it to the new shape with a one-time warning.
 */

import fs from 'node:fs';
import path from 'node:path';

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

const DEFAULT_APP_VERSION = 'claude-openmax/0.1.0';
const DEFAULT_FRONTEND_BASE_PATH = '/workspace';

export function resolveConfigPath(explicit) {
  return explicit
    || process.env.CLAUDE_OPENMAX_CONFIG
    || path.join(process.env.CLAUDE_OPENMAX_DATA_DIR
      || path.join(process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`, 'claude-openmax'),
    'config.json');
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

/**
 * Slugify a human string into a stable, URL/path-safe slug. Returns '' when the
 * input has no slug-able characters (caller then falls back to org_id).
 */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a stable slug for an org record. Priority: explicit `slug` > slugified
 * `org_name` > the org_id (map key). Deterministic, so it is stable across
 * restarts as long as those inputs are stable.
 */
export function deriveSlug(org, orgIdKey) {
  if (org?.slug) return String(org.slug);
  const fromName = slugify(org?.org_name);
  if (fromName) return fromName;
  return String(org?.org_id || orgIdKey || '');
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
      ...(o.slug ? { slug: o.slug } : {}),
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
 * fallbacks and derives a stable slug per org. Internally `orgs` is an ARRAY of
 * records (each carrying its derived `slug`); persist() serializes it back to
 * the org_id-keyed on-disk map.
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
      slug: deriveSlug(org, orgIdKey),
      slugExplicit: !!org.slug,
      enabled: org.enabled,
      org_id,
      org_name: org.org_name || '',
      owner: org.owner || { member_id: '', name: '' },
      self: org.self || { member_id: '', name: '', display_name: '' },
      access: org.access || {},
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
 */
export function buildRuntime({ config, file, storage, logger, httpClient }) {
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
    ...(o.slugExplicit ? { slug: o.slug } : {}),   // only persist slug when explicitly set
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
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      logger?.warn?.(`config persist failed: ${e.message}`);
    }
  };

  const orgBySlug = (slug) => state.orgs.find((o) => o.slug === slug);
  const orgByOrgId = (id) => state.orgs.find((o) => o.org_id === id);
  const resolveDefaultOrgId = () => state.orgs[0]?.org_id || process.env.COCO_ORG_ID || '';

  // Self-healing member_id write-back: when the SDK resolves the agent's per-org
  // member_id (from the JWT claim), stash it into the org's `self` block and
  // persist — into the org_id-keyed on-disk structure. Reachable for tests.
  const applyMemberId = (orgId, memberId) => {
    const org = orgByOrgId(orgId);
    if (org && memberId && org.self?.member_id !== memberId) {
      org.self = { ...(org.self || {}), member_id: memberId };
      persist();
      logger?.info?.(`member_id resolved for org=${org.slug}: ${memberId}`);
      return true;
    }
    return false;
  };

  const tokenManager = new TokenManager({
    apiKey: state.agent.api_key,
    coreUrl: state.server.bff_url,
    cfAccess: state.cf_access,
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
    cfAccess: state.cf_access,
    // Wire the SDK's built-in frontend-link builder (frontendUrl(p)) to the
    // configured SPA mount point — enables clickable /workspace links.
    frontendBasePath: state.server.frontend_base_path,
    tokenManager,
    resolveDefaultOrgId,
    logger,
  });

  // Config provider for the config-coupled service methods (comm dm_* / owner).
  const configProvider = {
    enabledOrgs: () => state.orgs.slice(),
    getOrgByOrgId: orgByOrgId,
    updateConfig: (fn) => {
      const cfg = { orgs: Object.fromEntries(state.orgs.map((o) => [o.slug, o])) };
      fn(cfg);
      // reflect back mutations keyed by slug into the array
      state.orgs = Object.values(cfg.orgs);
      persist();
      return cfg;
    },
    setOwner: (slug, memberId, name) => {
      const org = orgBySlug(slug);
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
  // The SDK keys per-org runtime records by slug — bridge the org_id-keyed
  // on-disk store to a slug-keyed map here.
  const loadConfig = () => ({ orgs: Object.fromEntries(state.orgs.map((o) => [o.slug, o])) });

  const loadSession = async (slug) => {
    try {
      const raw = await storage.get(path.join('sessions', `${slug}.json`));
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const saveSession = async (slug, partial) => {
    const cur = await loadSession(slug);
    await storage.set(path.join('sessions', `${slug}.json`), JSON.stringify({ ...cur, ...partial }));
  };

  const syncSelf = async (orgConfig) => {
    // Hydrate the authoritative self display_name from cws-core (/me).
    try {
      const me = await http.getForOrg(orgConfig.org_id, http.apiPath('/me'));
      const name = me?.display_name || me?.username || '';
      if (name) {
        const org = orgBySlug(orgConfig.slug);
        if (org) { org.self = { ...(org.self || {}), name }; persist(); }
        return { nameReady: true, displayName: name, source: 'core' };
      }
    } catch (e) {
      logger?.warn?.(`syncSelf(${orgConfig.slug}) failed: ${e.message}`);
    }
    return { nameReady: false, reason: 'core returned no display_name' };
  };

  const callbacks = {
    loadConfig,
    loadSession,
    saveSession,
    syncSelf,
    onOwnerBind: (slug, memberId, displayName) => configProvider.setOwner(slug, memberId, displayName),
    onOwnerNameHint: (slug, name) => {
      const org = orgBySlug(slug);
      if (org) { org.owner = { ...(org.owner || {}), name }; persist(); }
    },
    onConfigEvent: (orgConfig, { event, data }) => {
      logger?.info?.(`config event ${event} for org=${orgConfig.slug}`);
      // Persist agent.config.* into the org's access block (best-effort mirror).
      const org = orgBySlug(orgConfig.slug);
      if (org && data && typeof data === 'object') {
        org.access = { ...(org.access || {}), ...pickAccess(data) };
        persist();
      }
    },
    onConnectionEvent: (orgConfig) => logger?.info?.(`connection event for org=${orgConfig.slug} (Cat.B no-op)`),
    onChannelEvent: (orgConfig) => logger?.info?.(`channel event for org=${orgConfig.slug} (Cat.B no-op)`),
    onOrgTerminated: (orgConfig, code, reason) =>
      logger?.error?.(`org ${orgConfig.slug} terminated code=${code} reason="${reason || ''}"`),
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
    orgConfigs: state.orgs,
    callbacks,
    persist,
    resolveDefaultOrgId,
    configProvider,
    wsConfig,
    applyMemberId,
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

function pickAccess(data) {
  const out = {};
  for (const k of ['dmPolicy', 'dmAllowFrom', 'groupPolicy']) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}
