/**
 * Receive-reaction ("processing" 👀) manager for the Claude Code (Cat.B) adapter.
 *
 * Behavior (confirmed with the product owner, mirrors the proven zylos-openmax
 * comm-bridge implementation):
 *
 *   1. On inbound delivery → add an "eyes" (👀) reaction to the inbound message
 *      (POST /messages/{id}/reactions) and arm a timeout (default 120s).
 *   2. On the adapter sending a reply for that conversation (comm_send) → remove
 *      the reaction and clear the timeout.
 *   3. On the timeout firing (the LLM never replied in time) → remove the
 *      reaction automatically.
 *   4. Persistence + restart cleanup: when a reaction is applied we write a small
 *      marker to the StorageProvider, keyed by messageId. On process startup we
 *      read ALL leftover markers and remove every reaction from the server
 *      (DELETE), then clear the markers. Confirmed policy is "clear all on
 *      restart" — simple + reliable, no re-arming timers, so a process that died
 *      mid-flight can never leave a permanently-stuck 👀.
 *   5. Reaction removal retries once on failure.
 *
 * The reaction work is STRICTLY non-blocking and fire-and-forget: it must never
 * delay or block delivering the message to the agent, nor block the reply send.
 * Callers ignore the returned promise; it exists only so tests can await the
 * settled state. Every method swallows its own errors (logged at warn).
 *
 * Server API (per-org authenticated, via the SDK CwsHttpClient):
 *   ADD:    POST   apiPath(`/messages/{messageId}/reactions`)  { reaction_code }
 *   REMOVE: DELETE apiPath(`/messages/{messageId}/reactions/{code}`)
 * Both route per-org through http.postForOrg / http.delForOrg (the same
 * convention every other authed adapter call uses — the JWT is resolved against
 * the org's token cache).
 *
 * Markers are persisted under a SINGLE aggregate storage key (the StorageProvider
 * only offers get/set) as an object map keyed by messageId, so startup can
 * enumerate them:
 *   reactions/active.json → { [messageId]: { orgId, conversationId, code, ts } }
 */

const REACTIONS_MARKER_KEY = 'reactions/active.json';
const DEFAULT_REMOVE_RETRY_MS = 1000;

/**
 * @param {object} opts
 * @param {object} opts.http       CwsHttpClient — needs postForOrg/delForOrg/apiPath
 * @param {object} opts.storage    StorageProvider — needs get/set
 * @param {string} [opts.code]     reaction code (e.g. 'eyes'); falsy → feature disabled
 * @param {number} [opts.timeoutMs] auto-remove timeout (default 120000)
 * @param {object} [opts.logger]
 * @param {number} [opts.removeRetryMs] delay before the single remove retry (default 1000)
 */
export function createReactionManager({
  http,
  storage,
  code,
  timeoutMs = 120000,
  logger,
  removeRetryMs = DEFAULT_REMOVE_RETRY_MS,
} = {}) {
  const enabled = !!code && !!http && typeof http.postForOrg === 'function';

  // messageId → { orgId, conversationId, code, timer }
  const active = new Map();

  // Serialize the read-modify-write of the single aggregate marker key so
  // concurrent applies/removes never lose an update.
  let markerChain = Promise.resolve();

  const info = (...a) => logger?.info?.('[reactions]', ...a);
  const warn = (...a) => logger?.warn?.('[reactions]', ...a);

  const apiPath = (p) => (typeof http?.apiPath === 'function' ? http.apiPath(p) : p);

  async function readMarkers() {
    try {
      const raw = await storage.get(REACTIONS_MARKER_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  // Apply `fn(currentMarkers)` and persist the result, serialized on markerChain.
  function mutateMarkers(fn) {
    markerChain = markerChain
      .then(async () => {
        const cur = await readMarkers();
        const next = fn({ ...cur }) || cur;
        try {
          await storage.set(REACTIONS_MARKER_KEY, JSON.stringify(next));
        } catch (e) {
          warn(`marker persist failed: ${e.message}`);
        }
      })
      .catch(() => {});
    return markerChain;
  }

  const deleteMarker = (messageId) =>
    mutateMarkers((m) => {
      delete m[messageId];
      return m;
    });

  function doRemove(orgId, messageId, rcode) {
    return http.delForOrg(orgId, apiPath(`/messages/${messageId}/reactions/${rcode}`));
  }

  // DELETE the reaction, retrying ONCE on failure (mirrors the reference). On
  // success (or successful retry) the marker is cleared; if BOTH attempts fail
  // the marker is intentionally LEFT so the next startup cleanup retries it —
  // this is what guarantees "no permanently-stuck 👀".
  function serverRemove(orgId, messageId, rcode, reason) {
    return doRemove(orgId, messageId, rcode)
      .then(() => {
        info(`reaction removed msg=${messageId} (${reason})`);
        return deleteMarker(messageId);
      })
      .catch((e) => {
        warn(`reaction remove failed msg=${messageId}: ${e.message}, retrying...`);
        return new Promise((r) => setTimeout(r, removeRetryMs)).then(() =>
          doRemove(orgId, messageId, rcode)
            .then(() => deleteMarker(messageId))
            .catch((e2) => warn(`reaction remove retry failed msg=${messageId}: ${e2.message}`)),
        );
      });
  }

  /**
   * Apply the receive-reaction to an inbound message + arm the timeout + persist
   * a marker. Fire-and-forget: never throws, returns a promise for tests.
   */
  function applyOnReceive(orgId, conversationId, messageId) {
    if (!enabled || !orgId || !messageId) return Promise.resolve();
    return http
      .postForOrg(orgId, apiPath(`/messages/${messageId}/reactions`), { reaction_code: code })
      .then(() => {
        info(`reacted '${code}' org=${orgId} msg=${messageId}`);
        const timer = setTimeout(() => {
          removeReaction(messageId, 'timeout');
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        active.set(messageId, { orgId, conversationId, code, timer });
        return mutateMarkers((m) => {
          m[messageId] = { orgId, conversationId, code, ts: Date.now() };
          return m;
        });
      })
      .catch((e) => warn(`react-on-receive failed msg=${messageId}: ${e.message}`));
  }

  /**
   * Remove a reaction by messageId (clears the timer + marker). Resolves org/code
   * from the in-memory entry, or from the persisted marker when it is not
   * in-memory (cross-process reply in split topology, or a startup-orphaned id).
   */
  function removeReaction(messageId, reason) {
    if (!messageId) return Promise.resolve();
    const state = active.get(messageId);
    if (state) {
      clearTimeout(state.timer);
      active.delete(messageId);
      return serverRemove(state.orgId, messageId, state.code, reason);
    }
    return readMarkers().then((m) => {
      const mk = m[messageId];
      if (mk?.orgId && mk?.code) return serverRemove(mk.orgId, messageId, mk.code, reason);
      // No server-removable info — just drop any stale marker.
      return deleteMarker(messageId);
    });
  }

  /**
   * Clear the reaction(s) for a conversation — the reply hot path. Matches both
   * the in-memory entries and any marker-only entries for that conversation.
   */
  function clearForConversation(conversationId, reason = 'reply') {
    if (!conversationId) return Promise.resolve();
    const ids = new Set();
    for (const [msgId, st] of active) {
      if (st.conversationId === conversationId) ids.add(msgId);
    }
    const memPromises = [...ids].map((id) => removeReaction(id, reason));
    const markerPromise = readMarkers()
      .then((m) => {
        const extra = Object.entries(m)
          .filter(([id, mk]) => mk?.conversationId === conversationId && !ids.has(id))
          .map(([id]) => id);
        return Promise.all(extra.map((id) => removeReaction(id, reason)));
      })
      .catch(() => {});
    return Promise.all([...memPromises, markerPromise]);
  }

  /** Remove a reaction by explicit messageId (thin alias). */
  const clearForMessage = (messageId, reason = 'reply') => removeReaction(messageId, reason);

  /**
   * Startup cleanup: read ALL leftover markers, DELETE every reaction from the
   * server (retrying once), then clear ALL markers. Confirmed "clear all on
   * restart" policy — no timers are re-armed. Non-blocking / never throws.
   */
  async function cleanupOnStartup() {
    let markers;
    try {
      markers = await readMarkers();
    } catch {
      return { removed: 0 };
    }
    const ids = Object.keys(markers);
    if (ids.length === 0) return { removed: 0 };
    info(`startup cleanup: removing ${ids.length} leftover reaction(s)`);
    await Promise.all(
      ids.map(async (id) => {
        const mk = markers[id];
        if (!mk?.orgId || !mk?.code) return;
        try {
          await doRemove(mk.orgId, id, mk.code);
        } catch (e) {
          warn(`startup remove failed msg=${id}: ${e.message}, retrying...`);
          try {
            await doRemove(mk.orgId, id, mk.code);
          } catch (e2) {
            warn(`startup remove retry failed msg=${id}: ${e2.message}`);
          }
        }
      }),
    );
    // Clear ALL markers regardless of individual removal outcome (policy).
    try {
      await storage.set(REACTIONS_MARKER_KEY, JSON.stringify({}));
    } catch (e) {
      warn(`startup marker clear failed: ${e.message}`);
    }
    active.clear();
    return { removed: ids.length };
  }

  return {
    enabled,
    markerKey: REACTIONS_MARKER_KEY,
    applyOnReceive,
    removeReaction,
    clearForConversation,
    clearForMessage,
    cleanupOnStartup,
    // Test/introspection seam only.
    _activeCount: () => active.size,
  };
}
