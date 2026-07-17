/**
 * HTTP POST /wake server — the split-topology (design topology 1) transport
 * boundary between a standalone bridge process and the MCP channel plugin.
 *
 * Adapted from raft-external-agents v0.3.1 (plugins/raft-channel/src/wake.ts).
 * In the recommended split topology the MCP channel plugin (this side, loaded
 * by Claude Code) owns this endpoint; the bridge process (holding the CWS WS +
 * SDK) POSTs raft-channel-wake.v1 requests to it. In the MVP in-process
 * topology (src/index.js default) this HTTP hop is skipped — InboundDelivery
 * calls the notifier directly — but the wire shape is identical so the split is
 * a clean future cut.
 *
 * ok:true is returned ONLY after notifier.notify(...) resolves (the wake
 * entered / is queued to enter the agent's visible context). Any failure →
 * non-2xx or {ok:false, failureClass}. Token is enforced when configured.
 */

import http from 'node:http';

import { validateWakeRequest } from './wake.js';

export async function startWakeServer({ host = '127.0.0.1', port = 0, token, notifier, runtimeSession, logger }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const tokenOk = !token || req.headers['x-openmax-wake-token'] === token;

    if (req.method !== 'POST' || url.pathname !== '/wake') {
      return writeJson(res, 404, { ok: false, failureClass: 'wake_failed', reason: 'unknown endpoint' });
    }
    if (!tokenOk) {
      return writeJson(res, 401, { ok: false, failureClass: 'auth_revoked', reason: 'invalid wake token' });
    }

    let body;
    try {
      body = validateWakeRequest(JSON.parse(await readBody(req)));
    } catch (e) {
      return writeJson(res, 400, { ok: false, failureClass: 'wake_failed', reason: e.message });
    }

    try {
      const result = await notifier.notify(body);
      const session = (result && result.runtimeSession) || runtimeSession;
      return writeJson(res, 200, session ? { ok: true, runtimeSession: session } : { ok: true });
    } catch (e) {
      const failureClass = e.failureClass || 'wake_failed';
      const status = failureClass === 'runtime_unavailable' ? 503
        : failureClass === 'auth_revoked' ? 401 : 500;
      logger?.warn?.(`/wake injection failed: ${e.message} (failureClass=${failureClass})`);
      return writeJson(res, status, {
        ok: false,
        failureClass,
        reason: e.message,
        ...(Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const endpoint = `http://${host}:${boundPort}/wake`;
  logger?.info?.(`wake-server listening at ${endpoint}`);

  return {
    endpoint,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
