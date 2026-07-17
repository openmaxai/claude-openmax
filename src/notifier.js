/**
 * DebouncedWakeNotifier — burst coalescing (raft EAB-8), ported from
 * raft-external-agents v0.3.1 (plugins/raft-channel/src/wake.ts).
 *
 * A wake notifier that batches WakeRequests arriving within a debounce window
 * into a single channel injection: the first wake in a window is injected
 * immediately (leading edge); subsequent wakes in the window are merged and
 * resolved together when the window closes. This reduces repeated Claude turns
 * under bursts while preserving the ok:true invariant — every caller's promise
 * resolves (or rejects) with the fate of the injection that covers it, so a
 * merged notice that reaches context resolves all coalesced wakes, and a failed
 * injection rejects all of them (→ each becomes {ok:false} → SDK redelivers).
 *
 * A merged notice must cover all coalesced wakes (one comm getMessages drains
 * everything — safe because the SDK dedupes on the way back in).
 */
export class DebouncedWakeNotifier {
  /**
   * @param {object} opts
   * @param {(wakes: object[]) => Promise<any>} opts.notify  underlying batch injector (ClaudeChannel.notifyWake)
   * @param {number} [opts.debounceMs]  coalesce window (default 0 = disabled)
   * @param {number} [opts.maxBatchSize] flush early at N pending (default 20)
   */
  constructor({ notify, debounceMs = 0, maxBatchSize = 20 }) {
    if (typeof notify !== 'function') throw new Error('DebouncedWakeNotifier requires a notify(wakes) function');
    this._notify = notify;
    this.debounceMs = Math.max(0, debounceMs);
    this.maxBatchSize = Math.max(1, maxBatchSize);
    this._pending = [];      // { wake, resolve, reject }
    this._timer = undefined;
    this._windowSend = undefined;
    this._windowActive = false;
  }

  /**
   * Enqueue a wake for injection.
   * @param {object} wake  WakeRequest
   * @returns {Promise<any>} resolves when the covering injection reached context
   */
  notify(wake) {
    if (this.debounceMs === 0) {
      return this._notify([wake]);
    }
    if (!this._windowActive) {
      this._windowActive = true;
      this._windowSend = this._notify([wake]);
      // NOTE: not unref'd — this timer must keep the loop alive long enough to
      // close the coalesce window and resolve the merged waiters.
      this._timer = setTimeout(() => { this._timer = undefined; void this._closeWindow(); }, this.debounceMs);
      return this._windowSend;
    }
    return new Promise((resolve, reject) => {
      this._pending.push({ wake, resolve, reject });
      if (this._pending.length >= this.maxBatchSize) void this._closeWindow();
    });
  }

  async _closeWindow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
    const pending = this._pending.splice(0);
    const windowSend = this._windowSend;
    this._windowSend = undefined;
    this._windowActive = false;
    try {
      const res = await windowSend;
      for (const item of pending) item.resolve(res);
    } catch (err) {
      for (const item of pending) item.reject(err);
    }
  }
}
