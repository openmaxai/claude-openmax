/**
 * Stale-token-cache guard — belt-and-suspenders for an org-keyed token cache bug.
 *
 * The SDK's TokenManager caches the org JWT keyed by ORG ONLY
 * (`tokens/<org>.json`, plus `tokens/_identity.json` for the identity-only JWT).
 * If the agent's `api_key` changes within the same org (an identity swap — common
 * in testing), the STALE JWT minted with the OLD api_key is reused: the agent
 * then connects as the WRONG identity (`/me` returns the old one) and messages
 * for the new identity never arrive. The root fix lives in the SDK; this module
 * is the adapter-side safety net.
 *
 * We track a small fingerprint of the api_key (`sha256(api_key).slice(0,8)`) in a
 * per-org marker (`apikey-fp/<org>.json`), written AFTER a successful connect. On
 * the next bootstrap we compare the current api_key's fingerprint against the
 * stored one; on a mismatch (or a legacy deployment with a cached token but no
 * marker to verify it) we purge that org's cached token/session/inbox BEFORE
 * connecting, so a fresh JWT is exchanged for the CURRENT identity.
 *
 * The api_key itself is NEVER logged or persisted — only the fingerprint hash.
 * Every function here is defensive: it never throws, degrading to
 * "purge to be safe" so a guard failure can never leave a stale JWT in play.
 */

import crypto from 'node:crypto';

// Storage keys — MUST match exactly what the SDK/adapter write, so resolve() maps
// to the same files:
//   tokens/<id>.json    — SDK TokenManager (<id> = org_id, or "_identity" for the
//                         identity-only JWT, both minted from api_key)
//   sessions/<id>.json  — adapter loadSession/saveSession (the /sync cursor)
//   inbox-<id>.json     — SDK inbox-ledger
//   apikey-fp/<id>.json — this module's api_key fingerprint marker
const IDENTITY_SLOT = '_identity';
const tokenKey = (id) => `tokens/${id}.json`;
const sessionKey = (id) => `sessions/${id}.json`;
const inboxKey = (id) => `inbox-${id}.json`;
const markerKey = (id) => `apikey-fp/${id}.json`;

/**
 * Short, non-reversible fingerprint of an api_key: `sha256(api_key).slice(0,8)`.
 * Safe to log/persist (does not reveal the key). Empty string for a falsy key.
 * @param {string} apiKey
 * @returns {string}
 */
export function apiKeyFingerprint(apiKey) {
  if (!apiKey) return '';
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 8);
}

/** Read `me.identity_id` (with the SDK's fallback field) off a /me response. */
export function identityIdFromMe(me) {
  return me?.identity_id || me?.identity?.id || '';
}

async function safeRemove(storage, key) {
  try {
    if (typeof storage.remove === 'function') return await storage.remove(key);
    // Degrade for a get/set-only StorageProvider: overwrite with empty so the
    // next read is treated as absent (the SDK reads `raw ? JSON.parse : null`).
    await storage.set(key, '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Purge one slot's cached JWT, /sync cursor, and inbox ledger so the next
 * bootstrap exchanges a FRESH JWT. Never throws.
 *
 * @param {object}   params
 * @param {object}   params.storage  StorageProvider ({get,set}[,remove])
 * @param {string}   params.orgId    org_id (or "_identity" for the identity slot)
 * @param {object}   [params.logger]
 * @param {string}   [params.reason]
 * @returns {Promise<string[]>}  the keys actually removed
 */
export async function purgeOrgTokenCache({ storage, orgId, logger, reason }) {
  const removed = [];
  for (const key of [tokenKey(orgId), sessionKey(orgId), inboxKey(orgId)]) {
    if (await safeRemove(storage, key)) removed.push(key);
  }
  if (removed.length) {
    logger?.warn?.(
      `token-guard: purged cached ${removed.join(', ')} for org=${orgId}`
      + `${reason ? ` (${reason})` : ''}`,
    );
  }
  return removed;
}

/**
 * Bootstrap cache guard. Run this BEFORE connecting each org. For every org (plus
 * the identity-only slot) it decides whether the cached token/session/inbox must
 * be purged:
 *
 *   - marker present & differs        → api_key changed → purge
 *   - marker absent & a token exists  → can't verify which api_key minted it → purge to be safe
 *   - marker absent & no token        → genuine first run → keep
 *   - marker present & matches        → keep
 *
 * Never throws; any per-org error degrades to "purge to be safe".
 *
 * @param {object}   params
 * @param {object}   params.storage  StorageProvider ({get,set}[,remove])
 * @param {string[]} params.orgIds   org_ids the runtime will connect to
 * @param {string}   params.apiKey   the CURRENT agent.api_key
 * @param {object}   [params.logger]
 * @returns {Promise<string[]>}  the org ids (incl. "_identity") whose cache was purged
 */
export async function guardStaleTokenCache({ storage, orgIds, apiKey, logger }) {
  const fp = apiKeyFingerprint(apiKey);
  const ids = new Set([IDENTITY_SLOT, ...(orgIds || []).filter(Boolean)]);
  const purgedOrgs = [];
  for (const orgId of ids) {
    try {
      let stored = null;
      const rawMarker = await storage.get(markerKey(orgId));   // may throw → outer catch purges
      if (rawMarker) {
        try { stored = JSON.parse(rawMarker)?.fp ?? null; } catch { stored = null; }
      }
      let purge;
      if (stored) {
        purge = stored !== fp;
      } else {
        // No marker: legacy deployment or first run. Purge ONLY if a cached token
        // already exists (can't prove which api_key minted it); a clean first run
        // has nothing to purge and is left untouched.
        purge = (await storage.get(tokenKey(orgId))) != null; // may throw → outer catch purges
      }
      if (purge) {
        await purgeOrgTokenCache({
          storage, orgId, logger,
          reason: `api_key fingerprint ${stored || '<none>'} → ${fp || '<none>'}`,
        });
        purgedOrgs.push(orgId);
      }
    } catch (e) {
      // A read failed — we cannot verify the cached JWT's provenance. Never let
      // the guard throw; degrade to purge-to-be-safe so a stale JWT can't survive.
      try {
        await purgeOrgTokenCache({ storage, orgId, logger, reason: `guard read error: ${e.message}` });
        purgedOrgs.push(orgId);
      } catch { /* ignore */ }
    }
  }
  return purgedOrgs;
}

/**
 * Persist the current api_key fingerprint marker for each org (plus the
 * identity-only slot), to be called AFTER a successful connect so a later api_key
 * change is detectable on the next bootstrap. Never throws.
 *
 * @param {object}   params
 * @param {object}   params.storage
 * @param {string[]} params.orgIds
 * @param {string}   params.apiKey
 * @param {object}   [params.logger]
 */
export async function writeApiKeyMarkers({ storage, orgIds, apiKey, logger }) {
  const fp = apiKeyFingerprint(apiKey);
  const ids = new Set([IDENTITY_SLOT, ...(orgIds || []).filter(Boolean)]);
  for (const orgId of ids) {
    try {
      await storage.set(markerKey(orgId), JSON.stringify({ fp, updated_at: new Date().toISOString() }));
    } catch (e) {
      logger?.warn?.(`token-guard: failed to persist api_key marker for org=${orgId}: ${e.message}`);
    }
  }
}
