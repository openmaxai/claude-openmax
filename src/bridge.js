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
import { createReactionManager } from './reactions.js';
import { guardStaleTokenCache, writeApiKeyMarkers } from './token-guard.js';

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

  // Resolve + cache the agent's global identity_id (from config or /me). Best-
  // effort and non-blocking: leadAgentId for the guided-autonomy flow == this.
  runtime.resolveIdentityId().catch(() => {});

  // Receive-reaction ("processing" 👀) manager. In split topology the reply that
  // clears a reaction is handled by the channel process (src/index.js
  // channel-only) via the shared storage markers; this bridge process owns the
  // apply-on-receive + auto-timeout + startup cleanup. Fire-and-forget.
  const reactions = createReactionManager({
    http: runtime.http,
    storage,
    code: runtime.reactionConfig.code,
    timeoutMs: runtime.reactionConfig.timeoutMs,
    logger,
  });
  reactions.cleanupOnStartup().catch(() => {});

  const inbound = createInboundDelivery({
    wake: (wakeReq) => httpWake(endpoint, token, wakeReq),
    reactions,
    logger,
  });

  const bridge = createBridge({
    runtime,
    inbound,
    storage,
    runtimeState: createEmptyRuntimeState(),
    logger,
    // WS config (ws_url + device_id + app_version + cf_access + tuning).
    wsConfig: runtime.wsConfig,
  });

  // Belt-and-suspenders for the org-keyed token cache bug: if agent.api_key
  // changed since the last successful connect, purge the org's cached
  // token/session/inbox BEFORE connecting so a fresh JWT is exchanged for the
  // CURRENT identity (see token-guard.js). Never throws.
  const orgIds = runtime.orgConfigs.map((o) => o.org_id);
  await guardStaleTokenCache({ storage, orgIds, apiKey: config.agent.api_key, logger });
  await bridge.start();
  // Record the api_key fingerprint now that we've connected, so a later api_key
  // change is detectable on the next bootstrap.
  await writeApiKeyMarkers({ storage, orgIds, apiKey: config.agent.api_key, logger });
  logger.info(`bridge started; posting wakes to ${endpoint}`);

  const shutdown = async () => { try { await bridge.stop(); } catch { /* ignore */ } process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`[claude-openmax-bridge] FATAL ${e?.stack || e}\n`);
  process.exit(1);
});
