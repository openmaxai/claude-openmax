/**
 * Adapter configuration + SDK client assembly.
 *
 * Loads the adapter's own config (local JSON file / env), builds the shared
 * TokenManager + CwsHttpClient, instantiates the six service clients, and
 * exposes the callback seams the SDK CwsAgentBridge needs (loadConfig,
 * loadSession/saveSession, onMemberId, owner/config persistence).
 *
 * Config file shape (see config.example.json), env-overridable:
 * {
 *   "http": { "baseUrl": "https://.../ (COCO_API_URL)" },
 *   "ws":   { "baseUrl": "wss://.../cws-comm", "deviceId", "clientVersion" },
 *   "auth": { "apiKey": "cwsk_... (COCO_API_KEY)" },
 *   "orgs": [ { "slug", "org_id", "self", "owner", "access" } ],
 *   "cf_access": { ... }   // test env only
 * }
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CwsHttpClient,
  TokenManager,
  createTmService,
  createKbService,
  createAsService,
  createCommService,
  createCoreService,
  createConnService,
} from '@openmaxai/openmax-agent-sdk';

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

function normalizeConfig(raw) {
  const http = raw.http || {};
  const ws = raw.ws || {};
  const auth = raw.auth || {};
  return {
    http: { baseUrl: http.baseUrl || process.env.COCO_API_URL || '' },
    ws: {
      baseUrl: ws.baseUrl || process.env.COCO_WS_URL || '',
      deviceId: ws.deviceId || process.env.COCO_DEVICE_ID || '',
      clientVersion: ws.clientVersion || process.env.COCO_CLIENT_VERSION || 'claude-openmax/0.1.0',
      reconnectMaxMs: ws.reconnectMaxMs,
      heartbeatIntervalMs: ws.heartbeatIntervalMs,
      pingIntervalMs: ws.pingIntervalMs,
    },
    auth: { apiKey: auth.apiKey || process.env.COCO_API_KEY || '' },
    cf_access: raw.cf_access,
    orgs: Array.isArray(raw.orgs) ? raw.orgs : [],
    wake: raw.wake || {},
  };
}

/**
 * Build the SDK clients + callback seams from a normalized config.
 *
 * @param {object} params
 * @param {object} params.config    normalized adapter config
 * @param {string} params.file      config file path (for persistence)
 * @param {object} params.storage   StorageProvider
 * @param {object} params.logger
 */
export function buildRuntime({ config, file, storage, logger }) {
  // Mutable in-memory config mirror; persisted back to `file` on writes so the
  // SDK's member_id write-back / owner bind / agent.config.* events survive a
  // restart (the SDK never writes config itself — that is the adapter's job).
  const state = { orgs: cloneOrgs(config.orgs) };

  const persist = () => {
    try {
      const out = { ...config, orgs: state.orgs };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      // 0o600: the config holds secrets (api_key, cf_access.client_secret). A
      // plain writeFileSync defaults to 0o644 and would rewrite the file
      // world-readable on every member_id/owner write-back.
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      logger?.warn?.(`config persist failed: ${e.message}`);
    }
  };

  const orgBySlug = (slug) => state.orgs.find((o) => o.slug === slug);
  const orgByOrgId = (id) => state.orgs.find((o) => o.org_id === id);
  const resolveDefaultOrgId = () => state.orgs[0]?.org_id || process.env.COCO_ORG_ID || '';

  const tokenManager = new TokenManager({
    apiKey: config.auth.apiKey,
    coreUrl: config.http.baseUrl,
    cfAccess: { cf_access: config.cf_access },
    storage,
    resolveDefaultOrgId,
    onMemberId: (orgId, memberId) => {
      const org = orgByOrgId(orgId);
      if (org && memberId && org.self?.member_id !== memberId) {
        org.self = { ...(org.self || {}), member_id: memberId };
        persist();
        logger?.info?.(`member_id resolved for org=${org.slug}: ${memberId}`);
      }
    },
    logger,
  });

  const http = new CwsHttpClient({
    baseUrl: config.http.baseUrl,
    apiKey: config.auth.apiKey,
    deviceId: config.ws.deviceId,
    clientVersion: config.ws.clientVersion,
    cfAccess: { cf_access: config.cf_access },
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

  return { http, tokenManager, services, orgConfigs: state.orgs, callbacks, persist, resolveDefaultOrgId, configProvider };
}

function cloneOrgs(orgs) {
  return orgs.map((o) => ({ ...o }));
}

function pickAccess(data) {
  const out = {};
  for (const k of ['dmPolicy', 'dmAllowFrom', 'groupPolicy']) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}
