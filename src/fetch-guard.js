/**
 * Guarded fetch for the SDK's TokenManager + CwsHttpClient (OPENM-1107).
 *
 * The SDK uses native fetch with no timeout, and undici reports every
 * network-layer failure as the bare message "fetch failed" with the real reason
 * hidden in `e.cause`. So a hung cws-core connection stalled a token exchange or
 * tool call forever, and a broken one reached the agent (and the log) as just
 * "fetch failed" — undiagnosable. Both SDK classes take a `fetch` constructor
 * option; this wraps the global fetch with:
 *
 *  - a time-to-response-headers timeout (default 15s) for JSON API calls. Body
 *    uploads (PUT, or a non-string body) are exempt so large artifact uploads
 *    are not cut off; the body read after the headers is not timed.
 *  - errors that name the request and the cause, e.g.
 *    `fetch failed: POST /auth/ws-ticket → ECONNRESET` or
 *    `fetch timed out after 15000ms: POST /auth/agent/token`. Path only — the
 *    query string is dropped (it can carry tickets); no headers or bodies.
 *  - 1–2 short retries for the token / ws-ticket endpoints on network errors or
 *    timeouts only (never on an HTTP status — the SDK handles those itself).
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_PATH_RE = /\/auth\/(agent\/token|refresh|ws-ticket)$/;

function requestPath(url) {
  try { return new URL(String(url)).pathname; } catch { return String(url).split('?')[0]; }
}

/** The most specific reason available for a failed fetch. */
export function fetchCause(e) {
  const c = e?.cause;
  return (c && (c.code || c.message)) || e?.code || e?.message || String(e);
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.baseFetch]   default globalThis.fetch (resolved per call)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]           extra attempts for token / ws-ticket requests
 * @param {number} [opts.retryDelayMs]
 * @param {object} [opts.logger]
 * @returns {typeof fetch}
 */
export function createGuardedFetch({
  baseFetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS, logger,
} = {}) {
  const doFetch = (...a) => (baseFetch || globalThis.fetch)(...a);

  const once = async (url, init, method, path) => {
    const timed = timeoutMs > 0 && method !== 'PUT' && (init?.body === undefined || typeof init.body === 'string');
    if (!timed) return doFetch(url, init);
    const ctrl = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = () => ctrl.abort(outer.reason);
    if (outer) { if (outer.aborted) ctrl.abort(outer.reason); else outer.addEventListener('abort', onOuterAbort, { once: true }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (timedOut) {
        const err = new Error(`fetch timed out after ${timeoutMs}ms: ${method} ${path}`);
        err.name = 'TimeoutError';
        err.cause = e;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
  };

  return async function guardedFetch(url, init = {}) {
    const method = String(init?.method || 'GET').toUpperCase();
    const path = requestPath(url);
    const maxAttempts = 1 + (RETRYABLE_PATH_RE.test(path) ? Math.max(0, retries) : 0);
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(url, init, method, path);
      } catch (e) {
        const callerAborted = init?.signal?.aborted && e?.name !== 'TimeoutError';
        const err = e?.name === 'TimeoutError' || callerAborted
          ? e
          : Object.assign(new Error(`fetch failed: ${method} ${path} → ${fetchCause(e)}`), { cause: e });
        if (callerAborted || attempt >= maxAttempts) {
          logger?.warn?.(`[http] ${err.message}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
          throw err;
        }
        logger?.warn?.(`[http] ${err.message} — retrying (${attempt}/${maxAttempts - 1})`);
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
  };
}
