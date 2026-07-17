/**
 * Adapter-side providers/loggers handed to the SDK CwsAgentBridge.
 *
 * StorageProvider lives in storage.js. Here we provide:
 *   - a RuntimeStateProvider that DEGRADES to empty metrics (Cat.B has no
 *     dashboard/state collector — the design's explicit degraded semantics;
 *     the SDK's metrics reporter tolerates {} and does not crash), and
 *   - a small structured Logger that writes to stderr ONLY.
 *
 * stderr is deliberate: when this process is a stdio MCP server, stdout is the
 * JSON-RPC channel to Claude Code and MUST NOT carry log lines. All adapter
 * logging therefore goes to stderr (same discipline raft's plugin uses).
 */

export function createStderrLogger(prefix = '[claude-openmax]') {
  const emit = (level, args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    process.stderr.write(`${new Date().toISOString()} ${prefix} ${level} ${line}\n`);
  };
  return {
    info: (...a) => emit('INFO', a),
    warn: (...a) => emit('WARN', a),
    error: (...a) => emit('ERROR', a),
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
