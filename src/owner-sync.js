/**
 * Periodic owner-info pull-sync.
 *
 * cws-core is the authoritative source of an org's owner binding. The SDK
 * hydrates the agent's own self.name on every (re)connect, but it does NOT pull
 * the OWNER — so an owner rebound in core while the bridge is connected would
 * never reach local config until a restart. This arms an interval that
 * periodically re-pulls each active org's owner from core and reconciles it into
 * local config via runtime.syncOwnerFromCore (setOwner + atomic persist).
 *
 * It is the PULL half of owner management; the owner_changed config event
 * (config.js onConfigEvent) drives the SAME pull path, so a pushed frame is only
 * ever a signal to re-sync, never trusted data.
 *
 * Mirrors the openmax component's `owner-config-sync` periodic task (5 min).
 *
 * The same tick also drives the periodic half of the ACCESS-POLICY reconcile
 * (runtime.reconcilePolicyWithServer — see config.js), which is pull-first and
 * therefore safe to run on a schedule: it reads the server copy before deciding
 * whether anything should be uploaded.
 */

import { safeJson } from './redact.js';

const DEFAULT_OWNER_SYNC_INTERVAL_MS = 5 * 60 * 1000;  // 5 min — matches the openmax component
const DEFAULT_OWNER_SYNC_INITIAL_DELAY_MS = 10 * 1000; // let connect + self-name hydration settle first

/**
 * Arm the periodic owner pull-sync. Returns a `{ stop }` handle; call stop() on
 * shutdown to clear the timers.
 *
 * @param {object}   params
 * @param {object}   params.runtime          buildRuntime() output (orgConfigs + syncOwnerFromCore)
 * @param {object}   [params.logger]
 * @param {number}   [params.intervalMs]     re-sync cadence (default 5 min)
 * @param {number}   [params.initialDelayMs] delay before the first pass (default 10 s; 0 = run immediately)
 * @returns {{ stop: () => void }}
 */
export function startOwnerSync({ runtime, logger, intervalMs = DEFAULT_OWNER_SYNC_INTERVAL_MS, initialDelayMs = DEFAULT_OWNER_SYNC_INITIAL_DELAY_MS }) {
  const tick = () => {
    const orgs = runtime.orgConfigs;
    logger?.info?.(`[owner-sync] tick start — ${orgs.length} active org(s)`);
    for (const orgConfig of orgs) {
      // syncOwnerFromCore is best-effort and never rejects, but guard anyway so
      // one org's failure can never take down the interval.
      Promise.resolve()
        .then(() => runtime.syncOwnerFromCore(orgConfig))
        .then((res) => logger?.info?.(`[owner-sync] org=${orgConfig.org_id} result=${safeJson(res)}`))
        .catch((e) => logger?.warn?.(`[owner-sync] org=${orgConfig.org_id} FAILED: ${e.message}`));

      // The access-policy reconcile rides the same cadence: it is the periodic
      // half of policy sync (the change-driven half is debounced off config
      // events and the SDK's local access tools). Called OPTIONALLY — a runtime
      // without it (older adapter build, or a test double) must not break the
      // owner sync sharing this tick.
      Promise.resolve()
        .then(() => runtime.reconcilePolicyWithServer?.(orgConfig))
        .then((res) => { if (res) logger?.info?.(`[policy-sync] org=${orgConfig.org_id} result=${safeJson(res)}`); })
        .catch((e) => logger?.warn?.(`[policy-sync] org=${orgConfig.org_id} FAILED: ${e.message}`));
    }
  };

  const timers = [];
  const interval = setInterval(tick, intervalMs);
  interval.unref?.(); // don't keep the process alive for this timer alone
  timers.push(interval);

  if (initialDelayMs > 0) {
    const kick = setTimeout(tick, initialDelayMs);
    kick.unref?.();
    timers.push(kick);
  } else {
    tick();
  }

  logger?.info?.(`owner pull-sync armed (every ${Math.round(intervalMs / 1000)}s)`);

  return {
    stop() {
      for (const t of timers) {
        try { clearInterval(t); clearTimeout(t); } catch { /* ignore */ }
      }
    },
  };
}
