/**
 * File-backed StorageProvider for the Claude Code (Cat.B) adapter.
 *
 * Cat.B runtimes have NO ~/zylos layout — they own an independent local data
 * dir (XDG or an explicit override). This provider satisfies the SDK's
 * StorageProvider ({get,set}) plus the extra seams a couple of service clients
 * expect (downloadDir for AsService, credential cache for ConnService — both
 * degrade to safe empties here in Phase 1).
 *
 * Keys are namespaced paths the SDK writes: `tokens/<org>.json`,
 * `ledger/<slug>.json`, etc. We map each key to a file under <dataDir>/<key>.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultDataDir() {
  if (process.env.CLAUDE_OPENMAX_DATA_DIR) return process.env.CLAUDE_OPENMAX_DATA_DIR;
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-openmax');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]  root data dir (default XDG / ~/.local/share/claude-openmax)
 * @returns {import('@openmaxai/openmax-agent-sdk').StorageProvider & {downloadDir:Function, listCredentials:Function, clearCredentials:Function, dataDir:string, sessionPath:Function, remove:Function}}
 */
export function createFileStorage(opts = {}) {
  const dataDir = opts.dataDir || defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const resolve = (key) => {
    // Defend against traversal — keys are SDK-controlled but keep it tight.
    const safe = String(key).replace(/\.\.(\/|\\|$)/g, '');
    return path.join(dataDir, safe);
  };

  return {
    dataDir,

    async get(key) {
      try {
        return fs.readFileSync(resolve(key), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async set(key, value) {
      const file = resolve(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Atomic write: tmp + rename, so a crash never leaves a torn ledger/token.
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, String(value), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },

    // Delete a stored key (best-effort). Returns true if a file was removed,
    // false if it was already absent. Never throws. Used by the stale-token-cache
    // guard (token-guard.js) to purge a stale JWT/session/inbox before connecting.
    async remove(key) {
      const file = resolve(key);
      try {
        if (!fs.existsSync(file)) return false;
        fs.rmSync(file, { force: true });
        return true;
      } catch (e) {
        if (e.code === 'ENOENT') return false;
        return false;
      }
    },

    // AsService download target (falls back to os.tmpdir() if absent — we
    // provide a stable per-adapter dir instead).
    downloadDir() {
      const dir = path.join(dataDir, 'media');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

    // ConnService credential cache — Phase 1 degrades to empty (no local cache).
    listCredentials() { return []; },
    clearCredentials() { return []; },

    // Convenience for the per-org sync cursor persisted by loadSession/saveSession.
    sessionPath(orgId) { return resolve(path.join('sessions', `${orgId}.json`)); },
  };
}
