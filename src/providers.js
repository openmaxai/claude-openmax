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
 * The optional file tee is OPT-IN (only when `{ logFile }` is passed — the
 * entry points pass it only when CLAUDE_OPENMAX_LOG_FILE is set). It exists
 * because, inside the claude-plugin/MCP host, stderr is swallowed — so "no
 * logs". The SAME logger is handed to BOTH buildRuntime (adapter) AND the SDK
 * CwsAgentBridge, so adapter and SDK lines land in the one file. The tee is
 * best-effort: a file-open failure degrades to stderr-only with a warning and
 * never crashes startup.
 *
 * Secrets: the file is created 0o600 (it can contain secrets) and every line
 * written to the FILE is run through scrubLine() (masks JWT / cwsk_ / Bearer /
 * api_key / client_secret / password shapes). stderr is left byte-for-byte as
 * before. A size cap rotates the file at open time so it can't grow unbounded
 * across restarts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { scrubLine } from './redact.js';

const LOG_FILE_MODE = 0o600;          // secrets may appear in logs → owner-only
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap; rotate to .1 at open time

/**
 * @param {string} prefix
 * @param {object} [opts]
 * @param {string} [opts.logFile]  absolute path to also append log lines to (tee).
 */
export function createStderrLogger(prefix = '[claude-openmax]', { logFile } = {}) {
  // Best-effort file sink. Open once (append mode, 0o600); on any failure, fall
  // back to stderr-only and emit a single warning — never throw out of setup.
  let appendToFile = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      // Size guard: if the existing file is over the cap, rotate it to .1 so a
      // long-running plugin can't grow the log unbounded across restarts.
      try {
        if (fs.statSync(logFile).size > LOG_FILE_MAX_BYTES) {
          fs.renameSync(logFile, `${logFile}.1`);
        }
      } catch { /* no existing file (ENOENT) or rotate failed — proceed to open */ }
      const fd = fs.openSync(logFile, 'a', LOG_FILE_MODE);
      // If it pre-existed with looser perms, tighten best-effort.
      try { fs.chmodSync(logFile, LOG_FILE_MODE); } catch { /* non-fatal */ }
      appendToFile = (line) => { try { fs.writeSync(fd, scrubLine(line)); } catch { /* sink failure is non-fatal */ } };
    } catch (e) {
      process.stderr.write(`${new Date().toISOString()} ${prefix} WARN failed to open log file ${logFile}: ${e.message} — logging to stderr only\n`);
    }
  }

  const emit = (level, args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const out = `${new Date().toISOString()} ${prefix} ${level} ${line}\n`;
    process.stderr.write(out);       // stderr unchanged (raw)
    if (appendToFile) appendToFile(out); // file sink scrubbed inside appendToFile
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
