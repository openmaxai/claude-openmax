/**
 * Adapter-side providers/loggers handed to the SDK CwsAgentBridge.
 *
 * StorageProvider lives in storage.js. Here we provide:
 *   - a RuntimeStateProvider that DEGRADES to empty metrics (Cat.B has no
 *     dashboard/state collector — the design's explicit degraded semantics;
 *     the SDK's metrics reporter tolerates {} and does not crash), and
 *   - a small structured Logger that writes to stderr, optionally TEE'd to a file.
 *
 * stderr is deliberate: when this process is a stdio MCP server, stdout is the
 * JSON-RPC channel to Claude Code and MUST NOT carry log lines. All adapter
 * logging therefore goes to stderr (same discipline raft's plugin uses).
 *
 * The optional file tee exists because, inside the claude-plugin/MCP host,
 * stderr is swallowed — so "no logs". Passing `{ logFile }` makes the SAME
 * logger also append to one findable file; since this logger is handed to BOTH
 * buildRuntime (adapter) AND the SDK CwsAgentBridge, adapter and SDK lines land
 * in the one file. The tee is best-effort: a file-open failure degrades to
 * stderr-only with a warning and never crashes startup.
 *
 * NOTE on secrets: the SDK's RPC logger routes through `logger.log(...)`, which
 * can carry api_key/JWT material and is gated operator-side by COCO_RPC_LOG
 * (set =0 to silence). With the file tee enabled, that RPC output also reaches
 * the file — so keep COCO_RPC_LOG=0 if the log file must stay secret-free.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} prefix
 * @param {object} [opts]
 * @param {string} [opts.logFile]  absolute path to also append log lines to (tee).
 */
export function createStderrLogger(prefix = '[claude-openmax]', { logFile } = {}) {
  // Best-effort file sink. Open once (append mode); on any failure, fall back to
  // stderr-only and emit a single warning — never throw out of logger setup.
  let appendToFile = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const fd = fs.openSync(logFile, 'a');
      appendToFile = (line) => { try { fs.writeSync(fd, line); } catch { /* sink failure is non-fatal */ } };
    } catch (e) {
      process.stderr.write(`${new Date().toISOString()} ${prefix} WARN failed to open log file ${logFile}: ${e.message} — logging to stderr only\n`);
    }
  }

  const emit = (level, args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const out = `${new Date().toISOString()} ${prefix} ${level} ${line}\n`;
    process.stderr.write(out);
    if (appendToFile) appendToFile(out);
  };
  return {
    info: (...a) => emit('INFO', a),
    // The SDK's RPC logger calls logger.log(...); without this method the very
    // first token exchange throws "this._logger.log is not a function". RPC
    // logging is gated operator-side by COCO_RPC_LOG (set =0 to silence — e.g.
    // to keep api_key/JWTs out of logs).
    log: (...a) => emit('LOG', a),
    warn: (...a) => emit('WARN', a),
    error: (...a) => emit('ERROR', a),
    // Kept a no-op: the SDK can call debug() very frequently, and flooding the
    // diagnostic log file would bury the signal. Adapter diagnostics use info/warn.
    debug: () => {},
  };
}

/** Cat.B has no metrics source → report empty (SDK tolerates {} — degraded, not broken). */
export function createEmptyRuntimeState() {
  return { async getMetrics() { return {}; } };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
