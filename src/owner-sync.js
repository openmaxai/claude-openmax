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
 */

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
    for (const orgConfig of runtime.orgConfigs) {
      // syncOwnerFromCore is best-effort and never rejects, but guard anyway so
      // one org's failure can never take down the interval.
      Promise.resolve()
        .then(() => runtime.syncOwnerFromCore(orgConfig))
        .catch((e) => logger?.warn?.(`periodic owner-sync failed for org=${orgConfig.org_id}: ${e.message}`));
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
