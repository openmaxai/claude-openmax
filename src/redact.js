/**
 * Shared redaction / safe-logging utilities.
 *
 * Used by BOTH the object-level path (config.js onConfigEvent, which logs a
 * structured `data` object) and the line-level path (providers.js file sink,
 * which appends every rendered log line to disk). The file sink is the reason
 * this is line-level too: the tee writes EVERY line verbatim — startup
 * token-guard errors, SDK RPC/token traces — so a raw JWT / api_key could
 * otherwise land in the file in plaintext.
 */

/** JSON.stringify that never throws (falls back to String). */
export function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Object keys whose VALUE is a secret and must be masked wholesale.
const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|client[_-]?secret|token|password|passwd|authorization|bearer)/i;

/**
 * Deep/recursive copy of `obj` with any secret-keyed value masked. Handles
 * nested objects/arrays (e.g. `data.agent.api_key`) and is cycle-safe.
 * Non-objects are returned unchanged.
 */
export function redactSecretsDeep(obj, _seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return obj;
  if (_seen.has(obj)) return '[circular]';
  _seen.add(obj);
  if (Array.isArray(obj)) return obj.map((v) => redactSecretsDeep(v, _seen));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else out[k] = (v && typeof v === 'object') ? redactSecretsDeep(v, _seen) : v;
  }
  return out;
}

// Line-level scrubbers — value-shaped patterns first (catch bare tokens even
// with no key label), then labeled key=value / "key":"value" pairs.
const LINE_PATTERNS = [
  // JWT (three base64url segments) → mask entirely.
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'],
  // CWS API keys (cwsk_...).
  [/cwsk_[A-Za-z0-9_-]+/g, '[redacted-key]'],
  // Authorization: Bearer <token>.
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
  // Labeled secrets in JSON or key=value form: keep the "key:" / "key=" prefix
  // (and an opening quote if present), mask the value up to the next delimiter.
  [/(["']?(?:api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|token)["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi, '$1[redacted]'],
];

/** Mask common secret shapes in a single rendered log line. Never throws. */
export function scrubLine(line) {
  if (typeof line !== 'string' || !line) return line;
  let out = line;
  for (const [re, repl] of LINE_PATTERNS) out = out.replace(re, repl);
  return out;
}
