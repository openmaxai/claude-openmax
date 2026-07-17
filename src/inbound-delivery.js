/**
 * InboundDelivery.deliver() — the one required Cat.B translation point.
 *
 * The SDK CwsAgentBridge calls deliver(inbound, endpoint, priority) with a
 * fully normalized InboundMessage AFTER dedupe → detail-fetch → field-hoist →
 * conversation-fetch → access-policy. Our job: derive a raft-channel-wake.v1
 * WakeRequest and bring the message into Claude Code's visible context, then
 * return the WakeResult.
 *
 * ★ ok:true INVARIANT (schemas/v1/wake-result.schema.json): ok:true MUST mean
 * the message genuinely entered the runtime's visible context. We return
 * {ok:true} ONLY when the wake injection (channel push / POST /wake) resolved
 * successfully. Any failure → {ok:false, failureClass, retryAfterMs}; the SDK
 * then holds the dedupe/ledger/sync markers and redelivers on the next /sync
 * sweep. A false ok:true = a permanently lost message, so we never guess.
 *
 * `wake` is an injected function `(wakeRequest) => Promise<{runtimeSession?}>`:
 *   - in-process topology: ClaudeChannel.notifyWake / DebouncedWakeNotifier.notify
 *   - split topology:      an HTTP POST /wake client
 * so this module is transport-agnostic and unit-testable with a fake `wake`.
 */

import { deriveWakeRequest } from './wake.js';

const DEFAULT_RETRY_AFTER_MS = 5000;

/**
 * @param {object} opts
 * @param {(wakeRequest: object) => Promise<any>} opts.wake  the injector
 * @param {object} [opts.logger]
 * @param {string} [opts.runtimeSession]  fallback runtime session key
 * @param {number} [opts.previewMax]      contentPreview cap
 * @param {number} [opts.retryAfterMs]    default backoff hint on failure
 * @returns {{deliver: (inbound:object)=>Promise<{ok:boolean, runtimeSession?:string, failureClass?:string, retryAfterMs?:number}>}}
 */
export function createInboundDelivery({
  wake,
  logger,
  runtimeSession,
  previewMax,
  retryAfterMs = DEFAULT_RETRY_AFTER_MS,
} = {}) {
  if (typeof wake !== 'function') throw new Error('createInboundDelivery requires a wake(wakeRequest) function');

  return {
    async deliver(inbound) {
      let wakeReq;
      try {
        wakeReq = deriveWakeRequest(inbound, { previewMax });
      } catch (e) {
        // Malformed inbound is not retryable via /wake, but per the invariant we
        // still must NOT claim success — surface a failure so the SDK does not
        // commit markers on a message we could not even shape.
        logger?.error?.(`inbound.deliver: could not derive wake request: ${e.message}`);
        return { ok: false, failureClass: 'wake_failed', retryAfterMs };
      }

      try {
        const res = await wake(wakeReq);
        const session = (res && res.runtimeSession) || runtimeSession;
        return session ? { ok: true, runtimeSession: session } : { ok: true };
      } catch (e) {
        // failureClass is diagnostic only (SDK does not route on it; canonical
        // enum currently = {no_inbound_provider, wake_failed}). We surface a
        // finer class when the injector tagged one, else fall back to the
        // canonical wake_failed.
        const failureClass = e.failureClass || 'wake_failed';
        const backoff = Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : retryAfterMs;
        logger?.warn?.(`inbound.deliver: wake failed for msg=${wakeReq.messageId}: ${e.message} (failureClass=${failureClass}) — returning ok:false, SDK will redeliver on /sync`);
        return { ok: false, failureClass, retryAfterMs: backoff };
      }
    },
  };
}
