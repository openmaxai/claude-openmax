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
// A takeover mutex older than this is debris from a crashed process.
const TAKEOVER_STALE_MS = 5000;

/** kill(pid, 0): alive, or alive-but-not-ours (EPERM). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Start time of `pid` as an opaque string, or null when it cannot be read.
 * Linux: field 22 of /proc/<pid>/stat (clock ticks since boot; readable for other
 * users' processes too). Elsewhere: `ps -o lstart= -p <pid>`.
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces/parens — fields after the LAST ')' are
    // state (3), ppid (4), … starttime (22) → index 19.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] || null;
  } catch { /* not Linux / gone */ }
  if (process.platform === 'win32' || process.platform === 'linux') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

/** Identifier of the current boot, or null. Linux: boot_id; macOS: kern.boottime. */
export function currentBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* not Linux */ }
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

/** Parse a lock file: "<pid>\nstart=<s>\nboot=<b>\n" (older builds: just "<pid>\n"). */
export function parseLock(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const pid = Number.parseInt(lines[0], 10);
  const field = (k) => { const l = lines.find((x) => x.startsWith(`${k}=`)); return l ? (l.slice(k.length + 1) || null) : null; };
  return { pid: Number.isInteger(pid) ? pid : null, start: field('start'), boot: field('boot') };
}

/**
 * Is the process recorded in a lock still the one that wrote it?
 *  - different boot id → stale (rebooted; the pid means nothing now);
 *  - pid not running → stale;
 *  - pid running but with a different start time → stale (pid reused);
 *  - anything we cannot determine (no boot id / start time on either side) falls
 *    back to pid-only liveness — "unknown" is NEVER treated as stale, or a live
 *    lock could be stolen.
 */
export function holderIsLive(info, { isAlive = pidAlive, startTimeOf = processStartTime, bootId = currentBootId() } = {}) {
  if (!info || !Number.isInteger(info.pid)) return false;
  if (info.boot && bootId && info.boot !== bootId) return false;
  if (!isAlive(info.pid)) return false;
  if (info.start) {
    const now = startTimeOf(info.pid);
    if (now && now !== info.start) return false;
  }
  return true;
}

/**
 * Take the single-instance channel lock. Never throws.
 *
 * - Fresh acquire: our "<pid>/start/boot" record is written to a private temp
 *   file and hard-linked to `channel.lock` (link fails with EEXIST if the lock
 *   exists), so the lock is never observable empty or half-written. After the
 *   link the file is re-read and must be ours.
 * - Stale takeover (holder gone, pid reused, or rebooted — see holderIsLive) is
 *   serialized by an O_EXCL mutex `channel.lock.takeover`. Under it the lock is
 *   re-read and must still be exactly the record judged stale; it is then
 *   renamed aside, and the moved file is compared again. If we moved something
 *   else (a live lock), it is put back; if putting it back fails (a third
 *   process linked in meanwhile) the moved file is LEFT in place and we report
 *   busy — we never delete a lock we did not judge stale.
 *
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {number} [opts.pid]                       default process.pid
 * @param {(pid:number)=>boolean} [opts.isAlive]    test seam
 * @param {(pid:number)=>string|null} [opts.startTimeOf]  test seam
 * @param {string|null} [opts.bootId]               test seam
 * @param {object} [opts._hooks]                    test seam: {beforeRename, afterRename, afterLink}
 * @returns {{acquired: true, path: string, release: () => void}
 *         | {acquired: false, path: string, holderPid: number|null, reason: string}}
 */
export function acquireChannelLock({
  dataDir, pid = process.pid, isAlive = pidAlive, startTimeOf = processStartTime, bootId = currentBootId(), _hooks = {},
}) {
  const lockPath = path.join(dataDir, 'channel.lock');
  const mutexPath = `${lockPath}.takeover`;
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* surfaced below */ }
  const uniq = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const ownRecord = `${pid}\nstart=${startTimeOf(pid) || ''}\nboot=${bootId || ''}\n`;
  const busy = (holderPid, reason) => ({ acquired: false, path: lockPath, holderPid, reason });
  const live = (info) => holderIsLive(info, { isAlive, startTimeOf, bootId });

  const tmp = `${lockPath}.tmp-${uniq}`;
  try {
    fs.writeFileSync(tmp, ownRecord, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    return busy(null, `cannot create lock: ${e.message}`);
  }
  const tryLink = () => { try { fs.linkSync(tmp, lockPath); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };

  const takeMutex = () => {
    for (let i = 0; i < 2; i++) {
      try { fs.closeSync(fs.openSync(mutexPath, 'wx', 0o600)); return true; } catch (e) {
        if (e.code !== 'EEXIST') return false;
        let age = 0;
        try { age = Date.now() - fs.statSync(mutexPath).mtimeMs; } catch { continue; }
        if (age < TAKEOVER_STALE_MS) return false;
        try { fs.rmSync(mutexPath, { force: true }); } catch { /* retry */ }
      }
    }
    return false;
  };

  /** Move a stale lock out of the way. Returns 'retry' or a busy result. */
  const takeOver = (observed) => {
    if (!takeMutex()) return busy(null, 'another session is taking over the lock');
    try {
      const cur = read(lockPath);
      if (cur === null || cur !== observed) return 'retry'; // gone or changed — re-evaluate
      _hooks.beforeRename?.();
      const aside = `${lockPath}.stale-${uniq}`;
      try { fs.renameSync(lockPath, aside); } catch { return 'retry'; }
      _hooks.afterRename?.();
      const moved = read(aside);
      if (moved !== observed) {
        // Not what we judged stale: a live lock. Put it back, never delete it.
        try { fs.linkSync(aside, lockPath); } catch {
          return busy(parseLock(moved)?.pid ?? null, 'lock changed during takeover (moved lock left in place)');
        }
        try { fs.rmSync(aside, { force: true }); } catch { /* ignore */ }
        return busy(parseLock(moved)?.pid ?? null, `held by pid ${parseLock(moved)?.pid}`);
      }
      try { fs.rmSync(aside, { force: true }); } catch { /* ignore */ }
      return 'retry';
    } finally {
      try { fs.rmSync(mutexPath, { force: true }); } catch { /* ignore */ }
    }
  };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tryLink()) {
        _hooks.afterLink?.();
        if (read(lockPath) !== ownRecord) return busy(parseLock(read(lockPath))?.pid ?? null, 'lock taken by another session');
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours (never delete a successor's).
          try { if (read(lockPath) === ownRecord) fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
        };
        return { acquired: true, path: lockPath, release };
      }
      const observed = read(lockPath);
      if (observed === null) continue; // released meanwhile
      const info = parseLock(observed);
      if (!Number.isInteger(info.pid)) {
        // No pid in it. Link-based creation never produces that, so it is debris
        // (an older build, a crash, a manual touch) — but only take it over once
        // it is old enough that it cannot be a writer still mid-way.
        let age = Infinity;
        try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }
        if (age < LOCK_GRACE_MS) return busy(null, 'lock file is being written by another session');
      } else if (info.pid !== pid && live(info)) {
        return busy(info.pid, `held by pid ${info.pid}`);
      }
      const r = takeOver(observed);
      if (r !== 'retry') return r;
    }
    return busy(parseLock(read(lockPath))?.pid ?? null, 'lock contention');
  } catch (e) {
    return busy(null, `cannot create lock: ${e.message}`);
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
