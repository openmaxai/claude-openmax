/**
 * First channel session after onboarding: start the inbox catch-up at the
 * beginning of the (brand-new) inbox instead of seeking to its end.
 *
 * WHY: on the first-ever connect (no persisted `/sync` cursor) the SDK seeks to
 * the END of the inbox (`init sync_seq=N (seeked to inbox end)`) and seeds the
 * inbox ledger with that cursor, so everything at or below it counts as already
 * consumed. That is right for an EXISTING identity whose local state was lost (it
 * avoids replaying old history), but for an identity the onboarding command just
 * registered it silently drops every message sent between onboarding and the
 * first channel session — typically the owner's first DM — which then never gets
 * an answer.
 *
 * HOW: when onboarding registers a NEW identity it writes a marker
 * (`<dataDir>/first-sync.json`, keyed to the api_key fingerprint). For an org with
 * no persisted session cursor, `loadSession` then returns `inboxStartCursor()` for
 * that org instead of nothing, and the SDK takes its RECONNECT path — `/sync`
 * from seq 0 through the normal dedupe → access-policy → deliver pipeline — so
 * the messages that arrived after registration are delivered. A brand-new
 * identity has no inbox history from before its registration, so nothing older
 * than the onboarding is replayed. The marker is ignored for any other api_key
 * and is retired per org as soon as that org has a real cursor (so a later
 * purge of the local session state never replays the whole inbox).
 *
 * inboxStartCursor(): the SDK (1.1.0, `orchestrator.#startOrgWs` / `SyncEngine`)
 * treats a FALSY `sync_seq` as "first-ever connect → seek to the end", and
 * `syncMissedEvents` returns early on one — so a plain `0` cannot express
 * "catch up from seq 0". A boxed zero (`Object(0)`) is truthy, compares and does
 * arithmetic as 0 (`> 0` false, `Math.max(x, 0)` → 0, so the ledger is NOT
 * pre-seeded and the cursor is replaced by the first real seq), and serialises
 * as the number `0` on the wire (`{"since_seq":0}`). test/first-sync.test.js
 * drives the real SDK orchestrator to pin this behaviour; replace it with an SDK
 * option once the SDK grows one.
 *
 * Pure Node builtins.
 */

import fs from 'node:fs';
import path from 'node:path';

import { apiKeyFingerprint } from './token-guard.js';

export const FIRST_SYNC_KEY = 'first-sync.json';

/** A truthy cursor that means "from the start of the inbox" (see header). */
export function inboxStartCursor() {
  // eslint-disable-next-line no-new-wrappers
  return Object(0);
}

/**
 * Called by the onboarding after it registered a NEW identity (sync fs; never
 * throws — returns false when the marker could not be written).
 * @param {{dataDir:string, apiKey:string, identityId?:string, now?:number}} o
 */
export function writeFirstSyncMarker({ dataDir, apiKey, identityId = '', now = Date.now() }) {
  try {
    const fp = apiKeyFingerprint(apiKey);
    if (!dataDir || !fp) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, FIRST_SYNC_KEY);
    const tmp = `${file}.tmp-${process.pid}`;
    const body = { fp, identity_id: identityId, created_at: new Date(now).toISOString(), done: [] };
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The loadSession/saveSession side, over the adapter's StorageProvider.
 * @param {{storage:{get:Function,set:Function}, apiKey:string, logger?:object}} o
 */
export function createFirstSync({ storage, apiKey, logger }) {
  const fp = apiKeyFingerprint(apiKey);

  const read = async () => {
    try {
      const raw = await storage.get(FIRST_SYNC_KEY);
      if (!raw) return null;
      const m = JSON.parse(raw);
      return m && typeof m === 'object' ? m : null;
    } catch { return null; }
  };

  const pendingFor = (m, orgId) => !!m && !!fp && m.fp === fp
    && !(Array.isArray(m.done) && m.done.includes(orgId));

  return {
    /**
     * The cursor to hand the SDK for an org that has NO persisted session, or
     * null to keep the SDK default (seek to the inbox end).
     */
    async initialCursor(orgId) {
      const m = await read();
      if (!pendingFor(m, orgId)) return null;
      logger?.info?.(`[first-sync] org=${orgId}: first channel session after onboarding — `
        + `catching up the inbox from seq 0 (onboarded ${m.created_at || '?'}) instead of seeking to its end`);
      return inboxStartCursor();
    },

    /** A real cursor was persisted for this org — the marker is spent for it. */
    async cursorSaved(orgId, seq) {
      if (!(typeof seq === 'number' && seq > 0)) return;
      const m = await read();
      if (!pendingFor(m, orgId)) return;
      try {
        await storage.set(FIRST_SYNC_KEY, JSON.stringify({ ...m, done: [...(Array.isArray(m.done) ? m.done : []), orgId] }));
      } catch (e) {
        logger?.warn?.(`[first-sync] could not retire the marker for org=${orgId}: ${e.message}`);
      }
    },
  };
}
