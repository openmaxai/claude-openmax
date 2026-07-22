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
 * Set CLAUDE_OPENMAX_MODE=channel-only to run JUST the channel + an HTTP
 * /wake server (topology 1); the bridge then runs separately (src/bridge.js)
 * and survives Claude Code session restarts, redelivering via SDK /sync.
 *
 * IMPORTANT: stdout is the JSON-RPC channel to Claude Code. All logging goes to
 * stderr (see providers.js). Never console.log here.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadAdapterConfig, buildRuntime } from './config.js';
import { createFileStorage } from './storage.js';
import { createStderrLogger, createEmptyRuntimeState } from './providers.js';
import { ClaudeChannel } from './channel.js';
import { DebouncedWakeNotifier } from './notifier.js';
import { createInboundDelivery } from './inbound-delivery.js';
import { createMcpTools } from './mcp-tools.js';
import { createBridge } from './create-bridge.js';
import { startOwnerSync } from './owner-sync.js';
import { startWakeServer } from './wake-server.js';
import { guardStaleTokenCache, writeApiKeyMarkers } from './token-guard.js';

const PKG_VERSION = '1.1.0-beta.1';

async function main() {
  const logger = createStderrLogger();
  const mode = process.env.CLAUDE_OPENMAX_MODE || 'inproc';
  logger.info(`starting claude-openmax v${PKG_VERSION} (mode=${mode})`);

  const { config, file } = loadAdapterConfig();
  const storage = createFileStorage();
  const runtimeState = createEmptyRuntimeState();
  const runtime = buildRuntime({ config, file, storage, logger });

  // Resolve + cache the agent's global identity_id (from config or /me). Best-
  // effort and non-blocking: leadAgentId for the guided-autonomy flow == this.
  runtime.resolveIdentityId().catch(() => {});

  // ── MCP channel (claude/channel push + tools) ──────────────────────────────
  const debounceMs = Number(process.env.CLAUDE_OPENMAX_DEBOUNCE_MS || '0');
  const channel = new ClaudeChannel({
    name: 'openmax',
    version: PKG_VERSION,
    logger,
    includePreview: process.env.CLAUDE_OPENMAX_CONTENT_FREE !== '1',
  });

  const { defs, handler } = createMcpTools({
    services: runtime.services,
    bridge: null,               // set after the bridge exists (comm_send needs it)
    defaultOrgId: runtime.resolveDefaultOrgId(),
    logger,
  });
  channel.registerTools(defs, handler);

  const notifier = new DebouncedWakeNotifier({
    notify: (wakes) => channel.notifyWake(wakes),
    debounceMs,
  });

  let bridge = null;
  let wakeServer = null;
  let ownerSync = null;

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
  } else {
    // Topology 2 (MVP): in-process bridge. InboundDelivery → channel directly.
    const inbound = createInboundDelivery({
      wake: (req) => notifier.notify(req).then(() => ({ runtimeSession: channel.runtimeSession })),
      runtimeSession: channel.runtimeSession,
      logger,
    });
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
    // Re-register tools now that comm_send can reach the bridge.
    const withBridge = createMcpTools({
      services: runtime.services,
      bridge,
      defaultOrgId: runtime.resolveDefaultOrgId(),
      logger,
    });
    channel.registerTools(withBridge.defs, withBridge.handler);
  }

  // Connect the MCP server to Claude Code (stdio) BEFORE starting the bridge,
  // so the channel is ready to accept a wake the moment the WS delivers one.
  await channel.connect(new StdioServerTransport());

  if (bridge) {
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

  // ── graceful shutdown ───────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    try { if (ownerSync) ownerSync.stop(); } catch { /* ignore */ }
    try { if (bridge) await bridge.stop(); } catch { /* ignore */ }
    try { if (wakeServer) await wakeServer.close(); } catch { /* ignore */ }
    try { await channel.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`[claude-openmax] FATAL ${e?.stack || e}\n`);
  process.exit(1);
});
