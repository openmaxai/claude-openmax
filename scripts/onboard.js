#!/usr/bin/env node
/**
 * One-shot OpenMax onboarding for Claude Code.
 *
 * Run ONCE, as ONE Bash call, by the agent that received the OpenMax invitation
 * prompt — so the user approves exactly one command:
 *
 *   node <plugin>/scripts/onboard.js --launch <<'JSON'
 *   { …invitation config JSON… }
 *   JSON
 *
 * Steps (stops at the first failure; nothing is launched after a failure):
 *   1. preflight   — the Claude Code settings file must be valid JSON (we will edit it)
 *   2. config      — write the config from stdin at 0600 (keeps an existing
 *                    registration when the same invitation is re-run)
 *   3. register    — POST /auth/register/agent, then exchange a token and accept
 *                    the invitation; 45s total budget, retries on network
 *                    errors / 5xx. A NEW registration also leaves
 *                    <dataDir>/first-sync.json so the first channel session
 *                    catches up messages sent from then on (src/first-sync.js)
 *   4. permissions — APPEND the OpenMax tool rules to permissions.allow in
 *                    ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json (backup first,
 *                    never removes or reorders anything, refuses a corrupt file)
 *   5. self-check  — `claude --version`, plus warnings that matter for channels
 *   6. --launch    — start a NEW Claude Code session with the channel loaded
 *                    (CLAUDE_OPENMAX_CHANNEL=1 claude --dangerously-load-development-channels …)
 *                    in tmux: a new window when already inside tmux, else a
 *                    detached `openmax` session; with no tmux it prints the
 *                    command instead. It never types into any dialog — the
 *                    dev-channel warning is for the user to confirm. A new
 *                    window/session must still be running ~3 s later, otherwise
 *                    the launch is reported as FAILED (exit status + output)
 *                    with LAUNCH: manual — never as a successful launch.
 *
 * Output contract (stdout; consumed by the invitation prompt):
 *   [onboard] <step>: …        progress lines
 *   ONBOARD OK                 success marker, followed by
 *   LAUNCH: tmux-window | tmux-session | manual | none
 *   NEXT: <what the user does next>
 *   RESTART_COMMAND: <the exact channel launch command>   (always the last line)
 * or
 *   ONBOARD FAILED: <step>: <reason>
 * Exit codes: 0 OK (also "already onboarded"), 1 onboarding failed, 2 bad
 * usage / invalid config input.
 *
 * Re-running is safe: an already-registered config for the same org/server is
 * kept, an already-accepted invitation re-accepts idempotently server-side,
 * rules already present are not duplicated, and an existing `openmax` tmux
 * window/session is reused rather than started twice.
 *
 * Secrets: never prints the api_key, invitation token or CF-Access secret.
 * Pure Node builtins (same discipline as hooks/).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { registerAndAccept, resolveConfigPath, writeConfig0600, isPlaceholderKey } from '../hooks/auto-register.js';
import { scrubLine } from '../src/redact.js';
import { defaultDataDir } from '../src/storage.js';
import { writeFirstSyncMarker } from '../src/first-sync.js';

export const CHANNEL_REF = 'plugin:openmax-channel@openmax';
export const TMUX_NAME = 'openmax';
export const REGISTER_BUDGET_MS = 45000;
export const REGISTER_RETRIES = 3;

// The MCP tools that may run without a per-call prompt. Claude Code names a
// plugin's MCP tools mcp__plugin_<plugin>_<server>__<tool> (hyphens kept):
// plugin `openmax-channel` (.claude-plugin/plugin.json), server `openmax`, tools
// from src/mcp-tools.js. `as` (file upload/download) and `conn` (connection
// credentials) are deliberately NOT allowed — they keep asking per call.
const TOOL_PREFIX = 'mcp__plugin_openmax-channel_openmax__';
export const ALLOW_RULES = ['comm', 'comm_send', 'tm', 'kb', 'core'].map((t) => `${TOOL_PREFIX}${t}`);

// Claude Code marks its own children with these; a child `claude` that inherits
// them refuses to start ("already running"). Same list the Zylos CLI strips.
export const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
// Location overrides forwarded into the launched session (a tmux server started
// earlier does not have this shell's environment).
const ENV_PASSTHROUGH = ['CLAUDE_CONFIG_DIR', 'CLAUDE_OPENMAX_CONFIG', 'CLAUDE_OPENMAX_DATA_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_OPENMAX_LOG_FILE'];

// The new session starts fresh (no --continue/--resume); it only needs to greet.
export const GREETING_PROMPT =
  'OpenMax onboarding is complete and this session has the OpenMax channel loaded. '
  + 'Send your owner a short hello on OpenMax with the comm_send tool saying you are online '
  + '(use the comm tool to find or open your direct conversation with the owner; call it with method "list" to see its verbs). '
  + 'Mention that in group chats they need to @mention you for you to see a message. '
  + 'Do not run the onboarding steps again.';

class OnboardError extends Error {
  constructor(step, reason, code = 1) { super(`${step}: ${reason}`); this.step = step; this.reason = reason; this.code = code; }
}

// ── helpers ────────────────────────────────────────────────────────────────────

export function shellQuote(s) {
  const v = String(s);
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

export function claudeSettingsPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, value: undefined };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { exists: true, value: {} };
  return { exists: true, value: JSON.parse(text) };
}

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// ── config ─────────────────────────────────────────────────────────────────────

/** Validate the invitation config JSON handed over on stdin. Throws OnboardError(code 2). */
export function parseIncomingConfig(text) {
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new OnboardError('config', `stdin is not valid JSON (${e.message})`, 2); }
  if (!isObject(cfg)) throw new OnboardError('config', 'stdin JSON must be an object', 2);
  if (!isObject(cfg.server) || typeof cfg.server.bff_url !== 'string' || !cfg.server.bff_url) {
    throw new OnboardError('config', 'stdin config has no server.bff_url', 2);
  }
  if (!isObject(cfg.orgs) || Object.keys(cfg.orgs).length === 0) throw new OnboardError('config', 'stdin config has no orgs', 2);
  return cfg;
}

const normUrl = (u) => String(u || '').replace(/\/+$/, '');

/**
 * Decide what to write when an invitation config arrives over an existing one.
 *
 * Re-running the SAME invitation prompt must not throw away the registration it
 * produced the first time (the incoming config always has a blank api_key, and
 * writing it over would register a second, orphaned identity). So when the
 * existing config is registered against the same server and already knows every
 * incoming org, it is KEPT and only refreshed with the incoming server/CF-Access
 * values and the invite block (accept is idempotent server-side).
 * Anything else — a different server, a new org — is a new onboarding: the
 * incoming config replaces the old one (which the caller backs up first).
 *
 * @returns {{config: object, preserved: boolean}}
 */
export function mergeIncomingConfig(existing, incoming) {
  const key = existing?.agent?.api_key || existing?.auth?.apiKey || '';
  const sameServer = normUrl(existing?.server?.bff_url) === normUrl(incoming.server.bff_url);
  const knowsOrgs = isObject(existing?.orgs) && Object.keys(incoming.orgs).every((id) => id in existing.orgs);
  if (existing && !isPlaceholderKey(key) && sameServer && knowsOrgs) {
    const config = { ...existing, server: { ...existing.server, ...incoming.server } };
    if (incoming.cf_access !== undefined) config.cf_access = incoming.cf_access;
    if (incoming.invite !== undefined) config.invite = incoming.invite;
    return { config, preserved: true };
  }
  return { config: incoming, preserved: false };
}

// ── permissions ────────────────────────────────────────────────────────────────

/** Throws OnboardError if the settings file exists but cannot be safely edited. */
export function checkSettingsEditable(settingsPath) {
  let res;
  try { res = readJsonFile(settingsPath); } catch (e) {
    throw new OnboardError('preflight', `${settingsPath} is not valid JSON (${e.message}) — fix it first; nothing was changed`);
  }
  const s = res.value;
  if (res.exists && !isObject(s)) throw new OnboardError('preflight', `${settingsPath} is not a JSON object — nothing was changed`);
  if (s && s.permissions !== undefined && !isObject(s.permissions)) throw new OnboardError('preflight', `${settingsPath}: "permissions" is not an object — nothing was changed`);
  if (s?.permissions?.allow !== undefined && !Array.isArray(s.permissions.allow)) throw new OnboardError('preflight', `${settingsPath}: "permissions.allow" is not an array — nothing was changed`);
  return res;
}

/**
 * Append `rules` to permissions.allow — append-only, de-duplicated, every other
 * key untouched. Backs the file up to settings.json.bak-openmax-<ts> before the
 * first change. Written atomically (see writeFileAtomic).
 * @returns {{changed: boolean, added: string[], backup: string|null, path: string}}
 */
export function mergePermissions(settingsPath, rules = ALLOW_RULES, now = Date.now()) {
  const { exists, value } = checkSettingsEditable(settingsPath);
  const settings = exists ? value : {};
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const added = rules.filter((r) => !allow.includes(r));
  if (added.length === 0) return { changed: false, added, backup: null, path: settingsPath };

  let backup = null;
  if (exists) {
    backup = `${settingsPath}.bak-openmax-${stamp(now)}`;
    fs.copyFileSync(settingsPath, backup);
    fs.chmodSync(backup, 0o600); // settings can hold env secrets (e.g. "env" block)
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  settings.permissions = { ...(settings.permissions || {}), allow: [...allow, ...added] };
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { changed: true, added, backup, path: settingsPath };
}

/**
 * Atomic replace: write a temp file next to the REAL target (a symlinked
 * settings file stays a symlink), fsync, rename over it. Keeps the existing
 * file mode; a new file is created 0600. A crash mid-write leaves either the
 * old or the new file, never a truncated one.
 */
export function writeFileAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* does not exist yet */ }
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file */ }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

// ── launch ─────────────────────────────────────────────────────────────────────

/** env with the "already running" markers removed. */
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of ENV_VARS_TO_STRIP) delete out[k];
  return out;
}

/**
 * The channel launch command.
 * @param {object} [o]
 * @param {string} [o.claudeBin]     default 'claude'
 * @param {object} [o.env]           source of passthrough location overrides
 * @param {boolean} [o.stripEnv]     prefix `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` (tmux)
 * @param {string} [o.prompt]
 */
export function buildLaunchCommand({ claudeBin = 'claude', env = process.env, stripEnv = false, prompt = GREETING_PROMPT } = {}) {
  const parts = [];
  if (stripEnv) parts.push('env', ...ENV_VARS_TO_STRIP.flatMap((v) => ['-u', v]));
  for (const k of ENV_PASSTHROUGH) if (env[k]) parts.push(`${k}=${shellQuote(env[k])}`);
  parts.push('CLAUDE_OPENMAX_CHANNEL=1', shellQuote(claudeBin), '--dangerously-load-development-channels', CHANNEL_REF);
  // `--dangerously-load-development-channels` is VARIADIC: without the `--`
  // Claude Code reads the prompt as a second channel entry and exits 1
  // ("--dangerously-load-development-channels entries must be tagged: …").
  if (prompt) parts.push('--', shellQuote(prompt));
  return parts.join(' ');
}

/**
 * Where to launch. Pure — decided from env + platform + whether tmux runs.
 * @returns {'tmux-window'|'tmux-session'|'manual'} plus a reason for manual
 */
export function chooseLaunchMode({ env = process.env, platform = process.platform, tmuxAvailable = false } = {}) {
  if (platform === 'win32') return { mode: 'manual', reason: 'Windows has no tmux' };
  const entry = env.CLAUDE_CODE_ENTRYPOINT || '';
  if (entry && entry !== 'cli') return { mode: 'manual', reason: `not a terminal session (CLAUDE_CODE_ENTRYPOINT=${entry})` };
  if (!tmuxAvailable) return { mode: 'manual', reason: 'tmux is not installed' };
  return { mode: env.TMUX ? 'tmux-window' : 'tmux-session' };
}

const defaultExec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, ...opts });
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
};

/** Resolve the absolute `claude` path (tmux's shell may have a different PATH). */
function resolveClaudeBin(exec, env) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  const r = exec('sh', ['-c', 'command -v claude'], { env });
  const p = (r.status === 0 && r.stdout.trim().split('\n')[0]) || '';
  return p || 'claude';
}

// How long a freshly started channel session must survive before the launch is
// reported as successful. A command-line/parse error makes Claude Code exit
// within about a second; a healthy session sits in the dev-channel warning
// dialog waiting for the user.
export const LAUNCH_SETTLE_MS = 3000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** The last few non-empty lines of a dead pane, scrubbed and size-capped. */
function paneTail(text, maxLines = 8, maxChars = 600) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd())
    .filter((l) => l && !/^Pane is dead\b/.test(l));
  const tail = lines.slice(-maxLines).map((l) => scrubLine(l)).join(' | ');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/**
 * After starting a new window/session: wait, then check that the pane is still
 * running. The window was created with `remain-on-exit on` (in the SAME tmux
 * command, so even an instant exit leaves the dead pane behind) — that keeps the
 * exit status and the error output readable here. A dead pane we just created
 * is removed again; a live one gets the option reset to the user's default.
 * @returns {{alive: boolean, exitStatus?: string, output?: string}}
 */
async function verifyStarted({ run, target, kill, settleMs, delay }) {
  await delay(settleMs);
  const st = run(['display-message', '-p', '-t', target, '#{pane_dead} #{pane_dead_status}']);
  if (st.status !== 0) return { alive: false, output: '' };   // window already gone
  const [dead, exitStatus = ''] = st.stdout.trim().split(/\s+/);
  if (dead !== '1') {
    run(['set-option', '-w', '-u', '-t', target, 'remain-on-exit']);
    return { alive: true };
  }
  const cap = run(['capture-pane', '-p', '-J', '-t', target, '-S', '-50']);
  run(kill);
  return { alive: false, exitStatus, output: cap.status === 0 ? paneTail(cap.stdout) : '' };
}

function exitedReason(v) {
  return `the channel session exited right after starting${v.exitStatus ? ` (exit status ${v.exitStatus})` : ''}`
    + (v.output ? `: ${v.output}` : ' (no output captured)');
}

/**
 * Start (or reuse) the channel session in tmux. Never sends keystrokes and never
 * kills anything it did not just create.
 *
 * `allowReuse=false` (this run registered a new identity or replaced the
 * config): an already-running `openmax` window/session holds the OLD key in
 * memory, so switching to it would leave the new agent offline. In that case it
 * is reported (`stale: true`) instead of reused, and nothing is started.
 *
 * A NEW window/session is only reported as launched when it is still running
 * after `settleMs`; one that exited is reported as `exited: true` with its exit
 * status and the tail of its output, and removed again.
 * @returns {Promise<{launched: boolean, mode: string, reused?: boolean, stale?: boolean, exited?: boolean, attach?: string, reason?: string}>}
 */
export async function launchInTmux({
  mode, cwd, env, exec = defaultExec, claudeBin = 'claude', allowReuse = true,
  settleMs = LAUNCH_SETTLE_MS, delay = sleep,
}) {
  const tenv = cleanEnv(env);
  const cmd = buildLaunchCommand({ claudeBin, env, stripEnv: true });
  const run = (args) => exec('tmux', args, { env: tenv });
  // `;` chains a second tmux command into the same invocation.
  const keepDeadPane = [';', 'set-option', '-w', 'remain-on-exit', 'on'];

  if (mode === 'tmux-window') {
    const list = run(['list-windows', '-F', '#{window_name}']);
    if (list.status === 0 && list.stdout.split('\n').includes(TMUX_NAME)) {
      if (!allowReuse) return { launched: false, mode, stale: true, reason: `tmux window "${TMUX_NAME}" is already running with the previous configuration` };
      const sel = run(['select-window', '-t', TMUX_NAME]);
      if (sel.status === 0) return { launched: true, mode, reused: true };
    }
    const r = run(['new-window', '-P', '-F', '#{window_id}', '-n', TMUX_NAME, '-c', cwd, cmd, ...keepDeadPane]);
    if (r.status !== 0) return { launched: false, mode, reason: (r.stderr || r.error?.message || 'tmux new-window failed').trim() };
    const target = r.stdout.trim().split('\n')[0] || TMUX_NAME;
    const v = await verifyStarted({ run, target, kill: ['kill-window', '-t', target], settleMs, delay });
    if (!v.alive) return { launched: false, mode, exited: true, exitStatus: v.exitStatus, output: v.output, reason: exitedReason(v) };
    return { launched: true, mode, reused: false };
  }

  const attach = `tmux attach -t ${TMUX_NAME}`;
  const has = run(['has-session', '-t', `=${TMUX_NAME}`]);
  if (has.status === 0) {
    if (!allowReuse) return { launched: false, mode, stale: true, attach, reason: `tmux session "${TMUX_NAME}" is already running with the previous configuration` };
    return { launched: true, mode, reused: true, attach };
  }
  const r = run(['new-session', '-d', '-s', TMUX_NAME, '-c', cwd, cmd, ...keepDeadPane]);
  if (r.status !== 0) return { launched: false, mode, reason: (r.stderr || r.error?.message || 'tmux new-session failed').trim(), attach };
  const v = await verifyStarted({ run, target: `=${TMUX_NAME}:`, kill: ['kill-session', '-t', `=${TMUX_NAME}`], settleMs, delay });
  if (!v.alive) return { launched: false, mode, exited: true, exitStatus: v.exitStatus, output: v.output, reason: exitedReason(v), attach };
  return { launched: true, mode, reused: false, attach };
}

// ── main flow ──────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { launch: false, help: false, stdin: true };
  for (const a of argv) {
    if (a === '--launch') opts.launch = true;
    else if (a === '--no-stdin') opts.stdin = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new OnboardError('usage', `unknown argument "${a}"`, 2);
  }
  return opts;
}

const USAGE = `Usage: node scripts/onboard.js [--launch] [--no-stdin] < config.json

  stdin       the OpenMax invitation config JSON (omit with --no-stdin to re-use the existing config)
  --launch    after onboarding, start the channel session in tmux (or print the command)

Prints "ONBOARD OK" … "RESTART_COMMAND: …" on success, "ONBOARD FAILED: <step>: <reason>" on failure.
Exit codes: 0 ok, 1 failed, 2 bad usage/input.`;

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
  } catch { return '?'; }
}

/**
 * Run the onboarding. All side effects are injectable for tests.
 * @param {object} o
 * @param {string[]} [o.argv]
 * @param {string|null} [o.stdinText]   config JSON ('' / null = none supplied)
 * @param {object} [o.env]
 * @param {string} [o.cwd]
 * @param {string} [o.platform]
 * @param {(line:string)=>void} [o.print]
 * @param {Function} [o.exec]           (cmd,args,opts) => {status,stdout,stderr}
 * @param {Function} [o.register]       default registerAndAccept
 * @param {number} [o.now]
 * @param {object} [o.launchOpts]     TEST SEAM: extra launchInTmux options (settleMs, delay)
 * @returns {Promise<number>} exit code
 */
export async function runOnboard({
  argv = [], stdinText = null, env = process.env, cwd = process.cwd(), platform = process.platform,
  print = (l) => process.stdout.write(`${l}\n`), exec = defaultExec, register = registerAndAccept, now = Date.now(),
  launchOpts = {},
} = {}) {
  const say = (msg) => print(`[onboard] ${msg}`);
  try {
    const opts = parseArgs(argv);
    if (opts.help) { print(USAGE); return 0; }
    say(`claude-openmax onboard v${pluginVersion()}`);

    // 1. preflight — refuse to start if we could not finish the settings edit.
    const settingsPath = claudeSettingsPath(env);
    checkSettingsEditable(settingsPath);
    say(`preflight: ${settingsPath} OK`);

    // 2. config
    const configPath = resolveConfigPath();
    let existing;
    try { existing = readJsonFile(configPath).value; } catch (e) {
      if (!stdinText) throw new OnboardError('config', `${configPath} is not valid JSON (${e.message})`);
      existing = undefined; // replaced by the incoming config below (backed up first)
    }
    let configChanged = false;
    let keptRegistration = false;
    if (opts.stdin && stdinText && stdinText.trim()) {
      const incoming = parseIncomingConfig(stdinText);
      const { config, preserved } = mergeIncomingConfig(existing, incoming);
      keptRegistration = preserved;
      const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
      const after = JSON.stringify(config, null, 2) + '\n';
      if (before !== null && JSON.stringify(existing) === JSON.stringify(config)) {
        say(`config: ${configPath} unchanged`);
      } else {
        if (before !== null && !preserved) {
          const bak = `${configPath}.bak-openmax-${stamp(now)}`;
          fs.writeFileSync(bak, before, { mode: 0o600 });
          fs.chmodSync(bak, 0o600);
          say(`config: previous config backed up to ${bak}`);
        }
        writeConfig0600(configPath, JSON.parse(after));
        configChanged = true;
        say(`config: ${preserved ? 'kept existing registration, refreshed' : 'written'} ${configPath} (0600)`);
      }
    } else if (!existing) {
      throw new OnboardError('config', `no config on stdin and none at ${configPath}`, 2);
    } else {
      say(`config: using existing ${configPath}`);
    }

    // 3. register + accept
    say(`register: contacting the workspace server (budget ${REGISTER_BUDGET_MS / 1000}s, ${REGISTER_RETRIES} retries)`);
    const reg = await register({ deadlineMs: REGISTER_BUDGET_MS, retries: REGISTER_RETRIES });
    if (reg.status === 'failed') throw new OnboardError(reg.step || 'register', reg.reason || 'unknown error');
    const after = readJsonFile(configPath).value || {};
    const key = after.agent?.api_key || after.auth?.apiKey || '';
    if (isPlaceholderKey(key)) throw new OnboardError('register', `no api_key in ${configPath} after registration`);
    if (after.invite) throw new OnboardError('accept invitation', 'invitation is still pending after registration');
    say(`register: ${reg.registered ? `OK identity_id=${reg.identityId}` : 'already registered'}`);
    if (reg.registered) {
      // The first channel session must pick up messages sent from now on, instead
      // of seeking past them to the inbox end (see src/first-sync.js).
      const dataDir = defaultDataDir(env);
      if (writeFirstSyncMarker({ dataDir, apiKey: key, identityId: reg.identityId, now })) say(`first-sync: messages from now on reach the first channel session (${path.join(dataDir, 'first-sync.json')})`);
      else say(`first-sync: WARN could not write ${path.join(dataDir, 'first-sync.json')} — messages sent before the first channel session starts may be skipped`);
    }
    say(`invitation: ${!reg.inviteAccepted ? 'none pending' : keptRegistration ? 'already accepted (re-confirmed)' : 'accepted'}`);

    // 4. permissions
    const perm = mergePermissions(settingsPath, ALLOW_RULES, now);
    if (perm.changed) say(`permissions: added ${perm.added.length} rule(s) to ${perm.path}${perm.backup ? ` (backup: ${perm.backup})` : ''}`);
    else say(`permissions: all ${ALLOW_RULES.length} OpenMax rules already present in ${perm.path}`);

    // A re-run of the same invitation re-confirms the invite (idempotent
    // server-side) but registers nothing new — that is still "already onboarded".
    if (!reg.registered && !perm.changed && (keptRegistration || (!configChanged && !reg.inviteAccepted))) say('already onboarded');

    // 5. self-check
    const claudeBin = resolveClaudeBin(exec, cleanEnv(env));
    const ver = exec(claudeBin, ['--version'], { env: cleanEnv(env) });
    if (ver.status === 0) say(`check: claude ${ver.stdout.trim()}`);
    else say('check: WARN `claude --version` failed — make sure the Claude Code CLI is on PATH');
    if (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1') {
      say('check: WARN channels are not available on Amazon Bedrock / Google Vertex — workspace messages will not be pushed into the session');
    }
    say('note: on claude.ai Team/Enterprise an Owner must enable Channels, otherwise the channel loads but delivers nothing');

    // 6. launch
    const restart = buildLaunchCommand({ env });
    let launch = 'none';
    let next = 'Exit this session, then run the RESTART_COMMAND below and choose "I am using this for local development" in the warning dialog.';
    if (opts.launch) {
      const tmuxAvailable = platform !== 'win32' && exec('tmux', ['-V'], { env: cleanEnv(env) }).status === 0;
      const choice = chooseLaunchMode({ env, platform, tmuxAvailable });
      if (choice.mode === 'manual') {
        launch = 'manual';
        say(`launch: ${choice.reason} — not starting a session automatically`);
      } else {
        // A running channel session may only be reused when this run did not
        // change the agent identity it was started with.
        const allowReuse = !reg.registered && (keptRegistration || !configChanged);
        const res = await launchInTmux({ mode: choice.mode, cwd, env, exec, claudeBin, allowReuse, ...launchOpts });
        if (res.stale) {
          launch = 'manual';
          say(`launch: ${res.reason} — not reusing it (it still holds the old agent key) and not stopping it`);
          next = `First close the old OpenMax session in tmux ${choice.mode === 'tmux-window' ? 'window' : 'session'} "${TMUX_NAME}" `
            + `(exit Claude Code there, or \`tmux kill-${choice.mode === 'tmux-window' ? 'window' : 'session'} -t ${TMUX_NAME}\`), `
            + 'then run the RESTART_COMMAND below and choose "I am using this for local development" in the warning dialog.';
        } else if (res.exited) {
          // Started, but Claude Code quit at once — never report that as a launch.
          launch = 'manual';
          say(`launch: FAILED ${res.reason}`);
          next = `The new Claude Code session did not start: ${res.reason}. Fix that, then run the RESTART_COMMAND below `
            + '(in a new terminal or tmux window) and choose "I am using this for local development" in the warning dialog.';
        } else if (!res.launched) {
          launch = 'manual';
          say(`launch: WARN could not start tmux (${res.reason}) — run the command yourself`);
        } else if (choice.mode === 'tmux-window') {
          launch = 'tmux-window';
          say(`launch: ${res.reused ? 'switched to the existing' : 'opened a new'} tmux window "${TMUX_NAME}"`);
          next = `The new Claude Code session is in tmux window "${TMUX_NAME}" (already switched to it). Choose "I am using this for local development" in its warning dialog; it will then greet the owner. This old session can be closed afterwards.`;
        } else {
          launch = 'tmux-session';
          say(`launch: ${res.reused ? 'reusing the existing' : 'started a detached'} tmux session "${TMUX_NAME}"`);
          next = `Run \`${res.attach}\`, then choose "I am using this for local development" in the warning dialog; the new session will then greet the owner. This old session can be closed afterwards.`;
        }
      }
      if (launch === 'manual' && platform === 'win32') {
        next = 'Exit this session, then in PowerShell run: $env:CLAUDE_OPENMAX_CHANNEL="1"; claude --dangerously-load-development-channels '
          + `${CHANNEL_REF} — and choose "I am using this for local development" in the warning dialog.`;
      }
    }

    print('ONBOARD OK');
    print(`LAUNCH: ${launch}`);
    print(`NEXT: ${next}`);
    print(`RESTART_COMMAND: ${restart}`);
    return 0;
  } catch (e) {
    const err = e instanceof OnboardError ? e : new OnboardError('internal', e?.message || String(e));
    print(`ONBOARD FAILED: ${err.step}: ${err.reason}`);
    if (err.step === 'usage') print(USAGE);
    return err.code;
  }
}

function readStdin(timeoutMs = 5000) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => { process.stdin.pause(); resolve(Buffer.concat(chunks).toString('utf8')); }, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.once('error', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  (argv.includes('--no-stdin') || argv.includes('--help') || argv.includes('-h') ? Promise.resolve('') : readStdin())
    .then((stdinText) => runOnboard({ argv, stdinText }))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stdout.write(`ONBOARD FAILED: internal: ${e?.message || e}\n`); process.exitCode = 1; })
    .finally(() => process.exit());
}
