/**
 * Channel activation gate + single-instance lock (OPENM-1107).
 *
 * Claude Code starts this plugin's MCP server in EVERY session — a plain
 * `claude`, a `claude -p`, an IDE session — but it only delivers
 * `notifications/claude/channel` to a session that was launched with the
 * channel loaded (`--dangerously-load-development-channels plugin:…`). In any
 * other session it drops the notification silently and reports no error, so a
 * session that opens the workspace WS without the channel shows the agent as
 * online, acks every message (ok:true → SDK commits + marks read + advances the
 * device cursor) and the message is never seen.
 *
 * So the WS is opened only when the channel is known to be active, and only by
 * ONE process at a time:
 *
 *  - resolveChannelActivation(): explicit signal `CLAUDE_OPENMAX_CHANNEL=1`, set
 *    by the launch command scripts/onboard.js prints/runs (`=0` forces it off).
 *    Claude Code exposes no "channel active" signal of its own. Fallback when the
 *    env var is UNSET: look for the channel flag naming this plugin in the parent
 *    process's argv (the MCP server is spawned by the `claude` process). This
 *    covers a user who starts the channel by hand without the env var, and the
 *    case where Claude Code does not pass the env through to MCP children (not
 *    documented either way — needs real-machine verification).
 *  - acquireChannelLock(): `<dataDir>/channel.lock` created O_EXCL with our pid.
 *    A lock whose pid is gone is stale and taken over. A second channel-active
 *    session degrades to tools-only instead of double-processing every message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CHANNEL_ENV = 'CLAUDE_OPENMAX_CHANNEL';
export const PLUGIN_CHANNEL_REF = 'plugin:openmax-channel@openmax';
const CHANNEL_FLAGS = ['--dangerously-load-development-channels', '--channels'];

/**
 * Read the parent process's argv. Linux: /proc/<ppid>/cmdline; elsewhere `ps`.
 * Returns [] when it cannot be determined. Never throws.
 */
export function readParentArgv(ppid = process.ppid) {
  if (!ppid || ppid <= 1) return [];
  try {
    const raw = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8');
    return raw.split('\0').filter(Boolean);
  } catch { /* not Linux, or not readable */ }
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split(/\s+/).filter(Boolean);
  } catch { return []; }
}

/** True when argv loads this plugin's channel via one of the channel flags. */
export function argvLoadsChannel(argv) {
  if (!Array.isArray(argv)) return false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const flag of CHANNEL_FLAGS) {
      if (a === flag && typeof argv[i + 1] === 'string' && argv[i + 1].includes('openmax-channel')) return true;
      if (a.startsWith(`${flag}=`) && a.includes('openmax-channel')) return true;
    }
  }
  return false;
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {() => string[]} [opts.parentArgv]   test seam (default readParentArgv)
 * @returns {{active: boolean, source: 'env'|'parent-argv'|'none'}}
 */
export function resolveChannelActivation({ env = process.env, parentArgv = readParentArgv } = {}) {
  const v = env[CHANNEL_ENV];
  if (v === '1' || v === 'true') return { active: true, source: 'env' };
  if (v === '0' || v === 'false') return { active: false, source: 'env' };
  if (argvLoadsChannel(parentArgv())) return { active: true, source: 'parent-argv' };
  return { active: false, source: 'none' };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Take the single-instance channel lock. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {number} [opts.pid]                 default process.pid
 * @param {(pid:number)=>boolean} [opts.isAlive]  test seam
 * @returns {{acquired: true, path: string, release: () => void}
 *         | {acquired: false, path: string, holderPid: number|null, reason: string}}
 */
export function acquireChannelLock({ dataDir, pid = process.pid, isAlive = pidAlive }) {
  const lockPath = path.join(dataDir, 'channel.lock');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* surfaced by the open below */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${pid}\n`);
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          // Only remove the lock if it is still ours (never delete a successor's).
          if (Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10) === pid) fs.rmSync(lockPath, { force: true });
        } catch { /* already gone */ }
      };
      return { acquired: true, path: lockPath, release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: false, path: lockPath, holderPid: null, reason: `cannot create lock: ${e.message}` };
    }
    let holder = null;
    try { holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch { /* raced with a release */ }
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
      return { acquired: false, path: lockPath, holderPid: holder, reason: `held by pid ${holder}` };
    }
    // Stale (holder gone / unreadable / our own leftover pid) — take it over.
    try { fs.rmSync(lockPath, { force: true }); } catch { /* retry the open anyway */ }
  }
  return { acquired: false, path: lockPath, holderPid: null, reason: 'lock contention' };
}
