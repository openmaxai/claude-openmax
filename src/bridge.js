#!/usr/bin/env node
/**
 * claude-openmax — standalone bridge process (split topology 1, design P3).
 *
 * Holds the CWS WS connection + SDK CwsAgentBridge and stays resident across
 * Claude Code session restarts (redelivering via SDK /sync + inbox-ledger).
 * Its InboundDelivery POSTs raft-channel-wake.v1 requests over HTTP to the MCP
 * channel plugin's /wake endpoint (run `src/index.js` with
 * CLAUDE_OPENMAX_MODE=channel-only). This process runs NO MCP server.
 *
 * Config: `wake.endpoint` (+ optional CLAUDE_OPENMAX_WAKE_TOKEN) points at the
 * channel plugin's /wake. ok:true is returned to the SDK only when that POST
 * comes back 2xx {ok:true}.
 */

import { loadAdapterConfig, buildRuntime } from './config.js';
import { createFileStorage } from './storage.js';
import { createStderrLogger, createEmptyRuntimeState } from './providers.js';
import { createInboundDelivery } from './inbound-delivery.js';
import { createBridge } from './create-bridge.js';

async function httpWake(endpoint, token, wakeReq) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-openmax-wake-token': token } : {}),
    },
    body: JSON.stringify(wakeReq),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || payload.ok !== true) {
    const err = new Error(payload.reason || `wake POST returned ${res.status}`);
    err.failureClass = payload.failureClass || (res.status === 401 ? 'auth_revoked' : 'wake_failed');
    if (Number.isFinite(payload.retryAfterMs)) err.retryAfterMs = payload.retryAfterMs;
    throw err;
  }
  return { runtimeSession: payload.runtimeSession };
}

async function main() {
  const logger = createStderrLogger('[claude-openmax-bridge]');
  const { config, file } = loadAdapterConfig();
  const endpoint = config.wake?.endpoint;
  if (!endpoint) throw new Error('config.wake.endpoint is required for the split-topology bridge');
  const token = process.env.CLAUDE_OPENMAX_WAKE_TOKEN || config.wake?.token;

  const storage = createFileStorage();
  const runtime = buildRuntime({ config, file, storage, logger });

  const inbound = createInboundDelivery({
    wake: (wakeReq) => httpWake(endpoint, token, wakeReq),
    logger,
  });

  const bridge = createBridge({
    runtime,
    inbound,
    storage,
    runtimeState: createEmptyRuntimeState(),
    logger,
    wsConfig: config.ws,
  });

  await bridge.start();
  logger.info(`bridge started; posting wakes to ${endpoint}`);

  const shutdown = async () => { try { await bridge.stop(); } catch { /* ignore */ } process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`[claude-openmax-bridge] FATAL ${e?.stack || e}\n`);
  process.exit(1);
});
