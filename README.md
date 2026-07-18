# claude-openmax

The **Claude Code** runtime adapter for OpenMax / CWS. A thin **Category-B**
(bare runtime) adapter: it owns none of the CWS protocol — that all comes from
[`@openmaxai/openmax-agent-sdk`](../cws-agent-sdk) (`CwsAgentBridge`) — and does
only the two runtime-specific translations plus capability exposure:

1. **Inbound** — bring a workspace message into Claude Code's *visible context*
   via an experimental `claude/channel` MCP push (`raft-channel-wake.v1`).
2. **Outbound** — send Claude's reply back to cws-core via the SDK's
   `CommService`.
3. **Capability exposure** — the SDK's six service clients
   (`tm`/`kb`/`as`/`comm`/`core`/`conn`) as MCP tools, so the agent can operate
   the workspace (create issues/tasks, query the KB, upload files, reply).

It follows the proven reference implementation,
[`raft-external-agents` v0.3.1](https://github.com/botiverse/raft-external-agents)
— the only one of the four external runtimes with a shipped Claude Code plugin —
and the [claude-openmax adapter design](#).

## Architecture

```
Layer 1  @openmaxai/openmax-agent-sdk  (CWS HTTP/WS contract only)
  CwsAgentBridge: per-org WS lifecycle · auth/heartbeat/reconnect · atomic dedupe
    · /sync + inbox-ledger · frame dispatch · access-policy · normalized InboundMessage
  services: tm / kb / as / comm / core / conn   (one CwsHttpClient)
  providers: StorageProvider · RuntimeStateProvider · InboundDelivery(★) · Logger
        ▲ import + inject
Layer 2  claude-openmax  (this repo)
  ┌ bridge host (Node) ────────────────┐        ┌ Claude Code (agent) ──────────┐
  │ new CwsAgentBridge({providers,cbs}) │        │ MCP `openmax` server:         │
  │  providers.inbound.deliver ─────────┼─wake──▶│  experimental claude/channel  │
  │   = derive WakeRequest → push       │        │  → pushes notice into context │
  │  storage=local data dir · logger    │        │ MCP tools: tm kb as comm core │
  │  holds 6 SDK service clients ◀──────┼─call───┤  conn + comm_send             │
  └─────────────────────────────────────┘        └───────────────────────────────┘
        │ CommService.send() / bridge.send() → cws-core
        ▼
     cws-core REST  ◀── cws-comm WS (inbound frames) ── COCO Workspace (user)
```

### Topologies

- **In-process (MVP, default)** — one Node process is both the stdio MCP server
  (`claude/channel` + tools) **and** the host of `CwsAgentBridge`. `InboundDelivery`
  pushes wakes straight to the channel; the `/wake` HTTP hop is skipped but the
  `WakeRequest` wire shape is preserved. Run: Claude Code loads the plugin.
- **Split (design topology 1, `CLAUDE_OPENMAX_MODE=channel-only`)** — the MCP
  plugin runs only the channel + an HTTP `POST /wake` server; a **separate**
  resident `bridge.js` holds the WS and POSTs wakes. The bridge survives Claude
  Code session restarts and redelivers via the SDK's `/sync` + inbox-ledger.

## The `ok:true` delivery invariant

The single most important rule (from the SDK's `wake-result` schema and
`CwsAgentBridge`): **`ok:true` MUST mean the message genuinely entered the
runtime's visible context.** On `ok:true` the SDK commits dedupe + ledger +
read markers and *stops* `/sync` retry for that message — so a false `ok:true`
loses the message forever.

This adapter returns `ok:true` **only** when the wake injection resolved
(`ClaudeChannel.notifyWake` / `POST /wake` succeeded). Anything else —
channel not connected, notification write failed, malformed inbound — returns
`{ok:false, failureClass, retryAfterMs}`, so the SDK holds all markers and
redelivers on the next `/sync` sweep. See `src/inbound-delivery.js` and its
tests.

## Files

| File | Purpose |
|------|---------|
| `src/index.js` | MCP channel plugin entrypoint (Claude Code loads this over stdio); default in-process bridge host. |
| `src/bridge.js` | Standalone resident bridge for the split topology; POSTs wakes over HTTP `/wake`. |
| `src/channel.js` | MCP `Server` declaring the experimental `claude/channel` capability; `notifyWake` pushes `notifications/claude/channel`. |
| `src/wake.js` | Pure `raft-channel-wake.v1` derivation + validation + the human-visible wake notice/meta builders. |
| `src/inbound-delivery.js` | `InboundDelivery.deliver()` — derive WakeRequest, inject, gate `ok:true`. |
| `src/notifier.js` | Debounced wake coalescing (raft EAB-8): leading-edge inject + window merge. |
| `src/wake-server.js` | HTTP `POST /wake` server for the split topology (token-guarded). |
| `src/mcp-tools.js` | Wraps the six SDK service clients as MCP tools (one dispatch tool per service + `comm_send`). |
| `src/config.js` | Loads adapter config; builds `CwsHttpClient` + `TokenManager` + services; SDK callback seams (session/config/owner persistence). |
| `src/create-bridge.js` | Assembles `CwsAgentBridge` from the runtime + providers. |
| `src/storage.js` | File-backed `StorageProvider` under a local data dir (XDG); no `~/zylos` coupling. |
| `src/providers.js` | stderr logger + empty `RuntimeStateProvider` (Cat.B degraded metrics). |
| `.claude-plugin/plugin.json` | Registers the `openmax` MCP server for Claude Code. |
| `hooks/hooks.json` + `hooks/session-hook.js` + `hooks/orientation.js` | `SessionStart` orientation injection (survives resume/compaction). |
| `CLAUDE.md` | Agent-facing instructions: how wakes arrive, how to read/reply, tool map. |
| `test/*.test.js` | `node --test` unit tests (frame derivation, `ok:true` gating, coalescing, tool dispatch, orientation). |

## Session / context management

Uses Claude Code's **built-in autocompact** (and `/clear` / `/compact`). This
adapter implements **no extra compression logic** — by design.

## Running

```bash
npm install                     # resolves the SDK via file:../cws-agent-sdk
cp config.example.json ~/.config/claude-openmax/config.json   # fill in real values
npm test                        # node --test
```

Load into Claude Code as a plugin (dev):

```bash
claude plugin marketplace add --scope local /path/to/claude-openmax   # if published via a marketplace
# or point Claude Code at .claude-plugin/plugin.json directly
```

Split topology (resident bridge + channel-only plugin):

```bash
# terminal A: Claude Code loads the plugin with
CLAUDE_OPENMAX_MODE=channel-only CLAUDE_OPENMAX_WAKE_PORT=47600 CLAUDE_OPENMAX_WAKE_TOKEN=... claude ...
# terminal B: resident bridge (config.wake.endpoint = http://127.0.0.1:47600/wake)
CLAUDE_OPENMAX_WAKE_TOKEN=... node src/bridge.js
```

### Config / env

Config file at `$CLAUDE_OPENMAX_CONFIG` (or `~/.config/claude-openmax/config.json`);
see `config.example.json`. As of the config-parity refactor the on-disk shape is a
**1:1 structural mirror of the OpenMax (`zylos-openmax`) component's config** — see
the migration note below. The shape:

```
enabled?: bool
server:  { bff_url, ws_url, frontend_base_path }        // frontend_base_path default "/workspace"
agent:   { identity_id, api_key, device_id, app_version }
cf_access: { client_id, client_secret }
orgs:    { "<org_id>": { enabled?, org_id, org_name?,
             owner: { member_id, name },
             self:  { member_id, name, display_name },
             access:{ dmPolicy, dmAllowFrom?, groupPolicy?, groups?:{ "<convId>": { mode, allowFrom } } } } }
wake:    { endpoint }                                   // claude-openmax ONLY (openmax has no wake)
metricsReport?: { dashboardApiKey }                     // RESERVED / forward-compat — inert (no reporter yet)
ws?:     { reconnectMaxMs?, heartbeatIntervalMs?, pingIntervalMs? }   // claude-openmax WS tuning knobs
```

Env fallbacks (map onto the nested fields): `COCO_API_URL`→`server.bff_url`,
`COCO_WS_URL`→`server.ws_url`, `COCO_FRONTEND_BASE_PATH`→`server.frontend_base_path`,
`COCO_API_KEY`→`agent.api_key`, `COCO_DEVICE_ID`→`agent.device_id`,
`COCO_CLIENT_VERSION`→`agent.app_version`, `COCO_ORG_ID`→default org. Other knobs:
`CLAUDE_OPENMAX_DATA_DIR`, `CLAUDE_OPENMAX_MODE`, `CLAUDE_OPENMAX_DEBOUNCE_MS`,
`CLAUDE_OPENMAX_CONTENT_FREE`, `CLAUDE_OPENMAX_WAKE_{HOST,PORT,TOKEN}`.

**`orgs` is keyed by `org_id`** (openmax-style), end to end: the SDK orchestrator
keys its per-org runtime records by `org_id` too, so the adapter hands it an
`org_id`-keyed map directly — there is no separate per-org key to derive. Every
self-healing write-back (`self.member_id`, `self.name`, owner bind) resolves the
org by `org_id` and lands back in the `org_id`-keyed on-disk structure.

**`agent.identity_id`** is the agent's global identity. Leave it empty and the
adapter resolves it from cws-core `GET /me` at startup and caches it back to
`config.json`. It is the `leadAgentId` for the guided-autonomy flow (an Issue's
Lead agent = the agent itself).

**`server.frontend_base_path`** is wired into the SDK's `CwsHttpClient.frontendUrl()`
so the agent can build clickable workspace links (`<bff_url><frontend_base_path>/…`,
default `/workspace`).

### Migrating from the openmax (`zylos-openmax`) component

The claude-openmax config is now **structurally identical** to the openmax
component's `config.json` — you can drop an openmax config in as-is. The only
differences are additive and claude-openmax-specific:

- **`wake.endpoint`** — required for the split-topology bridge; openmax has no wake block.
- **`metricsReport`** — accepted for parity but **inert** (claude-openmax has no
  metrics reporter yet); it round-trips untouched.
- **`ws`** — optional WS tuning knobs (`reconnectMaxMs`, `heartbeatIntervalMs`,
  `pingIntervalMs`) that openmax hardcodes; `ws_url`/`device_id`/`app_version` live
  under `server.*`/`agent.*`, NOT here.

The **old** claude-openmax shape (top-level `http`/`auth` + an **array** `orgs`) is
still accepted: it is translated to the new shape on load with a one-time warning,
so an existing live config won't break — but you should migrate it.

## Verified vs. spike (honesty ledger)

**Verified locally (`node --test` + MCP client smoke):**
- WakeRequest derivation/validation, `ok:true` gating, coalescing, tool dispatch — 32 unit tests green.
- The MCP server boots, advertises `capabilities.experimental["claude/channel"]`, and lists all 7 tools to a real MCP client.
- `POST /wake` (token-guarded) → `server.notification({method:"notifications/claude/channel", ...})` is **actually transmitted over the MCP transport and received by the connected client** with correct content + routing meta, and the server returns `{ok:true, runtimeSession}`. `server.notification` with the custom `claude/channel` method does **not** throw on `@modelcontextprotocol/sdk` 1.22+.

**⚠️ SPIKE — requires a live Claude Code to confirm (biggest technical uncertainty):**
1. **`claude/channel` rendering.** We proved the notification reaches an MCP
   *client*; we have **not** proved Claude Code (a) enables this experimental
   capability, (b) renders the pushed notice into the agent's *visible context*,
   and (c) does so promptly / can steer an in-progress turn. Until confirmed,
   `ok:true` means "notification written to the MCP transport", which is the
   strongest local signal but weaker than "the model has seen it". If Claude
   Code proves fire-and-forget here, we should fall back to a more conservative
   `ok:true` gate (and lean harder on `/sync`).
2. **`runtimeSession` binding.** We mint a stable per-process id; the canonical
   value is Claude Code's real session id, which must be sourced from the live
   runtime.
3. **Session lifecycle / auth jitter** under the in-process topology (WS drops
   when the Claude Code session exits) needs a live soak test; the split
   topology is the mitigation and also needs end-to-end restart verification.
4. **Tool budget.** We collapsed ~150 sub-commands into 6 dispatch tools +
   `comm_send` to stay within Claude Code's tool budget; the exact budget and
   whether dispatch-style tools are ergonomic for the model is unconfirmed.

## Boundaries

- Consumes the SDK for **all** protocol/transport/sync/dedup/access-policy logic;
  reimplements none of it. Does **not** pass a custom `callbacks.dedupe` (uses the
  SDK's built-in atomic deduper).
- No dependency on `zylos-openmax`; independent local data dir (no `~/zylos`).
