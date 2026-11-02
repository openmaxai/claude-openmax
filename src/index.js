#!/usr/bin/env node
/**
 * claude-openmax — MCP channel plugin entrypoint (loaded by Claude Code over
 * stdio via .claude-plugin/plugin.json).
 *
 * Default (MVP) topology 2, in-process: this ONE process is both the MCP
 * `channel` server (claude/channel push + tools) AND the host of the SDK
 * CwsAgentBridge (CWS WS + SDK). InboundDelivery pushes wakes straight to the
 * channel — the /wake HTTP hop is skipped but its wire shape (WakeRequest) is
 * preserved so the split can be cut later.
 *
 * The workspace WS is opened ONLY in a session where the channel is active
 * (CLAUDE_OPENMAX_CHANNEL=1, see channel-gate.js) and only by the one process
 * holding <dataDir>/channel.lock. Every other session still gets the full MCP
 * tool set (comm_send goes over REST and needs no WS) but stays off the wire and
 * refuses wakes, so it can neither show the agent online nor ack messages it
 * would never display.
 *
 * Set CLAUDE_OPENMAX_MODE=channel-only to run JUST the channel + an HTTP
 * /wake server (topology 1); the bridge then runs separately (src/bridge.js)
 * and survives Claude Code session restarts, redelivering via SDK /sync.
 *
 * IMPORTANT: stdout is the JSON-RPC channel to Claude Code. All logging goes to
 * stderr (see providers.js). Never console.log here.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadAdapterConfig, buildRuntime, resolveLogFilePath, waitForApiKey } from './config.js';
import { createFileStorage } from './storage.js';
import { createStderrLogger, createEmptyRuntimeState } from './providers.js';
import { ClaudeChannel } from './channel.js';
import { DebouncedWakeNotifier } from './notifier.js';
import { createInboundDelivery } from './inbound-delivery.js';
import { createMcpTools } from './mcp-tools.js';
import { createMentionRegistry } from '@openmaxai/openmax-agent-sdk';
import { createBridge } from './create-bridge.js';
import { startOwnerSync } from './owner-sync.js';
import { startWakeServer } from './wake-server.js';
import { guardStaleTokenCache, writeApiKeyMarkers } from './token-guard.js';
import { PKG_VERSION } from './version.js';
import { resolveChannelActivation, acquireChannelLock, decideChannelRole, CHANNEL_ENV } from './channel-gate.js';

// Same service keys as mcp-tools.js: used to advertise the tool list before the
// runtime exists (startup-race wait), so Claude Code sees the full tool set at once.
const TOOL_STUB_SERVICES = Object.fromEntries(['tm', 'kb', 'as', 'comm', 'core', 'conn'].map((k) => [k, {}]));

function pendingToolHandler(text) {
  return async () => ({ content: [{ type: 'text', text: JSON.stringify({ error: text }) }], isError: true });
}

async function main() {
  const mode = process.env.CLAUDE_OPENMAX_MODE || 'inproc';
  const { config: initialConfig, file } = loadAdapterConfig();
  // File logging is OPT-IN (CLAUDE_OPENMAX_LOG_FILE). When on, the SAME logger is
  // handed to buildRuntime AND the SDK bridge, so adapter + SDK lines co-locate.
  const logFile = resolveLogFilePath();
  const logger = createStderrLogger('[claude-openmax]', logFile ? { logFile } : {});
  logger.info(`starting claude-openmax v${PKG_VERSION} (mode=${mode})`);
  logger.info(`config file: ${file}`);
  logger.info(logFile
    ? `file logging ENABLED → ${logFile} (0600, 10MB cap, secrets scrubbed)`
    : 'file logging OFF (stderr only) — set CLAUDE_OPENMAX_LOG_FILE to enable');

  const storage = createFileStorage();
  const runtimeState = createEmptyRuntimeState();

  // ── MCP channel (claude/channel push + tools) ──────────────────────────────
  const debounceMs = Number(process.env.CLAUDE_OPENMAX_DEBOUNCE_MS || '0');
  const channel = new ClaudeChannel({
    name: 'openmax',
    version: PKG_VERSION,
    logger,
    includePreview: process.env.CLAUDE_OPENMAX_CONTENT_FREE !== '1',
  });

  // Advertise the tools right away; the real handler is swapped in once the
  // runtime is built (immediately when the config already has an api_key).
  channel.registerTools(
    createMcpTools({ services: TOOL_STUB_SERVICES }).defs,
    pendingToolHandler('OpenMax registration is still in progress — retry in a few seconds.'),
  );

  // ── channel activation gate + single-instance lock ───────────────────────────
  const activation = resolveChannelActivation();
  let channelLock = null;
  let lockBusy = null;
  if (activation.active) {
    const lock = acquireChannelLock({ dataDir: storage.dataDir });
    if (lock.acquired) channelLock = lock;
    else lockBusy = lock;
  }
  // channel-only (split topology): no WS in this process; the role only decides
  // whether wakes POSTed by the external bridge may be accepted.
  const role = decideChannelRole({ mode, active: activation.active, lockAcquired: !!channelLock });
  const wsEnabled = role.wsEnabled;
  channel.setDeliveryEnabled(role.deliveryEnabled, !activation.active
    ? `${role.reason} (${CHANNEL_ENV} unset and no channel flag detected)`
    : `${role.reason} (${lockBusy?.reason || 'lock busy'})`);
  if (!activation.active) {
    logger.info(`channel NOT active in this session (${CHANNEL_ENV}!=1, no channel flag on the parent) — tools only, workspace WS stays closed`);
  } else if (lockBusy) {
    logger.warn(`channel active but ${lockBusy.path} is ${lockBusy.reason} — this session runs tools only; the other session keeps receiving messages`);
  } else if (channelLock) {
    logger.info(`channel active (source=${activation.source}); holding ${channelLock.path}`);
  }
  if (channelLock) process.once('exit', () => channelLock.release());

  const notifier = new DebouncedWakeNotifier({
    notify: (wakes) => channel.notifyWake(wakes),
    debounceMs,
  });

  let bridge = null;
  let wakeServer = null;
  let ownerSync = null;

  // ── graceful shutdown (armed early: the key wait below may take a while) ────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    try { if (ownerSync) ownerSync.stop(); } catch { /* ignore */ }
    try { if (bridge) await bridge.stop(); } catch { /* ignore */ }
    try { if (wakeServer) await wakeServer.close(); } catch { /* ignore */ }
    try { await channel.close(); } catch { /* ignore */ }
    try { if (channelLock) channelLock.release(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  if (mode === 'channel-only') {
    // Topology 1: run only the HTTP /wake endpoint; the bridge is external.
    wakeServer = await startWakeServer({
      host: process.env.CLAUDE_OPENMAX_WAKE_HOST || '127.0.0.1',
      port: Number(process.env.CLAUDE_OPENMAX_WAKE_PORT || '0'),
      token: process.env.CLAUDE_OPENMAX_WAKE_TOKEN,
      notifier: { notify: (req) => notifier.notify(req).then(() => ({ runtimeSession: channel.runtimeSession })) },
      runtimeSession: channel.runtimeSession,
      logger,
    });
    logger.info(`channel-only: bridge must POST wakes to ${wakeServer.endpoint}`);
  }

  // Connect the MCP server to Claude Code (stdio) BEFORE starting the bridge,
  // so the channel is ready to accept a wake the moment the WS delivers one.
  await channel.connect(new StdioServerTransport());

  if (lockBusy) {
    // This session loaded the channel, so it can see this notice.
    void channel.notifyNotice(
      'OpenMax: another Claude Code session is already connected to the workspace channel'
      + `${lockBusy.holderPid ? ` (pid ${lockBusy.holderPid})` : ''}. This session will NOT receive workspace `
      + 'messages; the OpenMax tools (comm_send, tm, kb, ...) still work here. Close the other session '
      + 'and restart this one to move the channel here.',
    );
  }

  // ── startup race (OPENM-1107 P2): build only once a key exists ──────────────
  const config = await waitForApiKey({ initial: initialConfig, logger, cancelled: () => shuttingDown });
  if (!config) {
    if (shuttingDown) return;
    logger.error('agent.api_key is still not set — OpenMax stays offline in this session. Run the onboarding again, then restart Claude Code.');
    channel.registerTools(
      createMcpTools({ services: TOOL_STUB_SERVICES }).defs,
      pendingToolHandler('OpenMax is not registered on this machine (no agent.api_key). Re-run the OpenMax onboarding, then restart Claude Code.'),
    );
    return;
  }

  const runtime = buildRuntime({ config, file, storage, logger });

  // Resolve + cache the agent's global identity_id (from config or /me). Best-
  // effort and non-blocking: leadAgentId for the guided-autonomy flow == this.
  runtime.resolveIdentityId().catch(() => {});

  const mentionRegistry = createMentionRegistry({ storage, log: (m) => logger?.debug?.(m) });

  if (mode !== 'channel-only') {
    // Topology 2 (MVP): in-process bridge. InboundDelivery → channel directly.
    const inbound = createInboundDelivery({
      wake: (req) => notifier.notify(req).then(() => ({ runtimeSession: channel.runtimeSession })),
      runtimeSession: channel.runtimeSession,
      logger,
    });
    // A permanently terminated org (WS close 4002/4005/4006) used to be visible
    // only in the log. Tell the session too, so the agent can tell the user.
    const onOrgTerminated = runtime.callbacks.onOrgTerminated;
    runtime.callbacks.onOrgTerminated = (orgConfig, code, reason) => {
      try { onOrgTerminated?.(orgConfig, code, reason); } catch { /* logging only */ }
      if (channel.deliveryEnabled) {
        void channel.notifyNotice(
          `OpenMax: the workspace closed this agent's connection for org ${orgConfig?.org_id || '?'} `
          + `(code ${code}${reason ? `, "${reason}"` : ''}) and it will not reconnect. Workspace messages for that org `
          + 'will stop arriving; tell the user — the agent may have been removed or the org deleted.',
        );
      }
    };
    bridge = createBridge({
      runtime,
      inbound,
      storage,
      runtimeState,
      logger,
      // WS config (ws_url + device_id + app_version + cf_access + tuning) is
      // assembled by buildRuntime from server.* / agent.* / ws.* / cf_access.
      wsConfig: runtime.wsConfig,
    });
  }

  const tools = createMcpTools({
    services: runtime.services,
    bridge,                     // null in channel-only (comm_send reports it unavailable)
    defaultOrgId: runtime.resolveDefaultOrgId(),
    mentions: mentionRegistry,
    logger,
  });
  channel.registerTools(tools.defs, tools.handler);

  if (bridge && wsEnabled && !shuttingDown) {
    // Belt-and-suspenders for the org-keyed token cache bug: if agent.api_key
    // changed since the last successful connect, purge the org's cached
    // token/session/inbox BEFORE connecting so a fresh JWT is exchanged for the
    // CURRENT identity (see token-guard.js). Never throws.
    const orgIds = runtime.orgConfigs.map((o) => o.org_id);
    await guardStaleTokenCache({ storage, orgIds, apiKey: config.agent.api_key, logger });
    await bridge.start();
    // Record the api_key fingerprint now that we've connected, so a later
    // api_key change is detectable on the next bootstrap.
    await writeApiKeyMarkers({ storage, orgIds, apiKey: config.agent.api_key, logger });
    // Periodically re-pull each org's owner from cws-core (pull-not-trust). The
    // SDK only hydrates self.name on connect, so this covers owner rebinds that
    // happen while we're online.
    ownerSync = startOwnerSync({ runtime, logger });
    logger.info('bridge started; inbound wakes will flow into the Claude Code context');
  }
}

main().catch((e) => {
  process.stderr.write(`[claude-openmax] FATAL ${e?.stack || e}\n`);
  process.exit(1);
});
