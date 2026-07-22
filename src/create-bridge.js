/**
 * Assemble the SDK CwsAgentBridge orchestrator from the adapter runtime.
 *
 * This is the exact wiring the design mandates: the adapter supplies ONLY the
 * Cat.B translation point (providers.inbound.deliver = wake-into-Claude) plus
 * storage/logger/runtimeState and the callback seams; every protocol concern
 * (WS lifecycle, auth, heartbeat/reconnect, dedupe, /sync + inbox-ledger, frame
 * dispatch, access-policy, normalization) stays inside CwsAgentBridge.
 *
 * NOTE: we intentionally DO NOT pass callbacks.dedupe — the SDK rejects a
 * non-atomic deduper at construction and its built-in atomic deduper already
 * gives exactly-once. There is no reason for a Cat.B adapter to override it.
 */

import { CwsAgentBridge } from '@openmaxai/openmax-agent-sdk';

const PKG_VERSION = '1.1.1';

/**
 * @param {object} params
 * @param {object} params.runtime          buildRuntime() output (http, tokenManager, orgConfigs, callbacks)
 * @param {object} params.inbound          InboundDelivery ({deliver})
 * @param {object} params.storage          StorageProvider
 * @param {object} params.runtimeState     RuntimeStateProvider
 * @param {object} params.logger
 * @param {object} params.wsConfig         runtime.wsConfig — { baseUrl (server.ws_url),
 *        deviceId (agent.device_id), clientVersion (agent.app_version), cf_access,
 *        reconnectMaxMs?, heartbeatIntervalMs?, pingIntervalMs? }
 * @returns {CwsAgentBridge}
 */
export function createBridge({ runtime, inbound, storage, runtimeState, logger, wsConfig }) {
  return new CwsAgentBridge({
    http: runtime.http,
    tokenManager: runtime.tokenManager,
    ws: {
      baseUrl: wsConfig.baseUrl,
      deviceId: wsConfig.deviceId,
      clientVersion: wsConfig.clientVersion,
      ...(wsConfig.cf_access ? { cfAccess: { cf_access: wsConfig.cf_access } } : {}),
      ...(wsConfig.reconnectMaxMs != null ? { reconnectMaxMs: wsConfig.reconnectMaxMs } : {}),
      ...(wsConfig.heartbeatIntervalMs != null ? { heartbeatIntervalMs: wsConfig.heartbeatIntervalMs } : {}),
      ...(wsConfig.pingIntervalMs != null ? { pingIntervalMs: wsConfig.pingIntervalMs } : {}),
    },
    orgConfigs: runtime.orgConfigs,
    providers: {
      storage,
      runtimeState,
      inbound,
      logger,
    },
    callbacks: runtime.callbacks,
    reporters: {
      version: PKG_VERSION,
    },
  });
}
