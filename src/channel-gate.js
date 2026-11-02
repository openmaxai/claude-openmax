/**
 * Channel activation gate + single-instance lock.
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

// A lock file without a pid younger than this is treated as held, not stale.
const LOCK_GRACE_MS = 5000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Take the single-instance channel lock. Never throws.
 *
 * Atomic: the pid is written to a private temp file first and then hard-linked
 * to `channel.lock` (link fails with EEXIST if the lock exists), so the lock
 * file is never observable empty or half-written. A stale lock (holder pid gone)
 * is taken over by RENAMING it away first — only one contender can win that
 * rename — and the renamed file is re-checked: if it turns out to hold a live
 * pid (someone else took over in between), it is put back and we report busy.
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
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* surfaced below */ }
  const uniq = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const readPid = (f) => { try { return Number.parseInt(fs.readFileSync(f, 'utf8'), 10); } catch { return null; } };

  const tmp = `${lockPath}.tmp-${uniq}`;
  try {
    fs.writeFileSync(tmp, `${pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    return { acquired: false, path: lockPath, holderPid: null, reason: `cannot create lock: ${e.message}` };
  }
  const tryLink = () => { try { fs.linkSync(tmp, lockPath); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tryLink()) {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours (never delete a successor's).
          try { if (readPid(lockPath) === pid) fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
        };
        return { acquired: true, path: lockPath, release };
      }
      const holder = readPid(lockPath);
      if (!Number.isInteger(holder)) {
        // No pid in it. Link-based creation never produces that, so it is debris
        // (an older build, a crash, a manual touch) — but only take it over once
        // it is old enough that it cannot be a writer still mid-way.
        let age = Infinity;
        try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; /* gone — retry */ }
        if (age < LOCK_GRACE_MS) return { acquired: false, path: lockPath, holderPid: null, reason: 'lock file is being written by another session' };
      }
      if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
        return { acquired: false, path: lockPath, holderPid: holder, reason: `held by pid ${holder}` };
      }
      // Stale: move it aside atomically, then make sure we moved what we judged.
      const aside = `${lockPath}.stale-${uniq}-${attempt}`;
      try { fs.renameSync(lockPath, aside); } catch { continue; /* gone or raced — retry the link */ }
      const moved = readPid(aside);
      if (Number.isInteger(moved) && moved !== pid && isAlive(moved)) {
        // We raced a successful takeover and moved a LIVE lock: restore it.
        try { fs.linkSync(aside, lockPath); } catch { /* a third party holds it now */ }
        try { fs.rmSync(aside, { force: true }); } catch { /* ignore */ }
        return { acquired: false, path: lockPath, holderPid: moved, reason: `held by pid ${moved}` };
      }
      try { fs.rmSync(aside, { force: true }); } catch { /* ignore */ }
    }
    return { acquired: false, path: lockPath, holderPid: readPid(lockPath), reason: 'lock contention' };
  } catch (e) {
    return { acquired: false, path: lockPath, holderPid: null, reason: `cannot create lock: ${e.message}` };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * What this process may do, from the mode, the activation and the lock.
 * Pure — the single place index.js takes these decisions from.
 *  - wsEnabled: open the workspace WS (in-process bridge only);
 *  - deliveryEnabled: accept wakes (in-process bridge, or /wake in channel-only).
 * Both require an active channel AND the lock — in channel-only mode too, so two
 * channel-only sessions cannot both accept wakes for the same agent.
 *
 * @param {{mode:string, active:boolean, lockAcquired:boolean}} o
 * @returns {{wsEnabled:boolean, deliveryEnabled:boolean, reason:string}}
 */
export function decideChannelRole({ mode, active, lockAcquired }) {
  if (!active) return { wsEnabled: false, deliveryEnabled: false, reason: 'channel not active in this session' };
  if (!lockAcquired) return { wsEnabled: false, deliveryEnabled: false, reason: 'another session holds the OpenMax channel' };
  return { wsEnabled: mode !== 'channel-only', deliveryEnabled: true, reason: '' };
}
