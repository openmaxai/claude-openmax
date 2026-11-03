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
 * and for orgs that were not in the config at onboarding time (an org joined
 * later keeps the SDK default), and is retired per org as soon as that org has
 * a real cursor (so a later purge of the local session state never replays the
 * whole inbox).
 *
 * Non-message seqs: the SDK's seek-to-end path seeds the inbox ledger with the
 * cursor (`setAckedSeq`); the catch-up path does not (the start cursor is not
 * `> 0`). `/sync` events that are not deliverable messages (no message_id /
 * conversation_id) are skipped by the SDK sweep WITHOUT being recorded, so if
 * the inbox starts with such a seq the ledger's contiguous watermark would stay
 * at 0 and its gap timer would re-run `/sync` from 0 every ~10 s for the whole
 * session. For orgs in first-sync mode, `wrapHttp()` therefore records exactly
 * those skipped seqs in the ledger as each `/sync` page arrives. The watermark
 * is NOT jumped to the swept cursor: a message the sweep skipped as an
 * in-flight duplicate of a live delivery that then FAILS must stay below the
 * watermark, so the SDK's gap rescan (from acked_seq) can still recover it.
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
 * @param {{dataDir:string, apiKey:string, identityId?:string, orgIds:string[], now?:number}} o
 *        orgIds: the orgs in the config at onboarding time — the only ones the marker applies to
 */
export function writeFirstSyncMarker({ dataDir, apiKey, identityId = '', orgIds = [], now = Date.now() }) {
  try {
    const fp = apiKeyFingerprint(apiKey);
    const orgs = [...new Set((orgIds || []).filter((id) => typeof id === 'string' && id))];
    if (!dataDir || !fp || orgs.length === 0) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, FIRST_SYNC_KEY);
    const tmp = `${file}.tmp-${process.pid}`;
    const body = { fp, identity_id: identityId, orgs, created_at: new Date(now).toISOString(), done: [] };
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * (orgId) => inbox ledger of a started org of an SDK 1.1.0 CwsAgentBridge.
 * @param {object} bridge
 */
export function ledgerAccessor(bridge) {
  return (orgId) => bridge?._orgs?.get?.(orgId)?.ledger || null;
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
    && Array.isArray(m.orgs) && m.orgs.includes(orgId)
    && !(Array.isArray(m.done) && m.done.includes(orgId));

  // (orgId) => the SDK's inbox ledger for that org, bound once the bridge exists.
  let ledgerFor = () => null;
  // Orgs that started this process from the start-of-inbox cursor.
  const catchUpOrgs = new Set();

  // Record the seqs of a /sync page that the SDK sweep will skip (see header).
  const recordSkipped = (orgId, res) => {
    const events = Array.isArray(res?.events) ? res.events : [];
    const skipped = events.filter((ev) => ev && (!ev.message_id || !ev.conversation_id)
      && typeof ev.seq === 'number' && ev.seq > 0).map((ev) => ev.seq);
    if (!skipped.length) return;
    const ledger = ledgerFor(orgId);
    if (!ledger || typeof ledger.record !== 'function') {
      logger?.warn?.(`[first-sync] org=${orgId}: inbox ledger not reachable — non-message seq(s) ${skipped.join(',')} stay open`);
      return;
    }
    for (const seq of skipped) ledger.record(seq);
    logger?.info?.(`[first-sync] org=${orgId}: recorded non-message inbox seq(s) ${skipped.join(',')} in the ledger`);
  };

  return {
    /**
     * Give access to the started orgs' inbox ledgers. SDK 1.1.0 has no public
     * accessor; `CwsAgentBridge._orgs` (orgId → {ledger, …}) is the record the
     * orchestrator keeps per started org (test/first-sync.test.js pins it).
     * @param {(orgId:string) => ({record:Function}|null|undefined)} fn
     */
    bindLedgers(fn) { if (typeof fn === 'function') ledgerFor = fn; },

    /**
     * The http client handed to the SDK bridge: identical, except that `/sync`
     * pages for orgs in first-sync mode get their non-message seqs recorded.
     */
    wrapHttp(http) {
      if (!http) return http;
      const isSync = (p) => /\/sync$/.test(String(p || '').replace(/\?.*$/, ''));
      return new Proxy(http, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (prop === 'postForOrg' && typeof v === 'function') {
            return async (orgId, p, ...rest) => {
              const res = await v.call(target, orgId, p, ...rest);
              if (catchUpOrgs.has(orgId) && isSync(p)) {
                try { recordSkipped(orgId, res); } catch (e) { logger?.warn?.(`[first-sync] org=${orgId}: ${e.message}`); }
              }
              return res;
            };
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },

    /**
     * The cursor to hand the SDK for an org that has NO persisted session, or
     * null to keep the SDK default (seek to the inbox end).
     */
    async initialCursor(orgId) {
      const m = await read();
      if (!pendingFor(m, orgId)) return null;
      catchUpOrgs.add(orgId);
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
