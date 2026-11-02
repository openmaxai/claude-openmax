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
| `src/channel-gate.js` | Channel activation (`CLAUDE_OPENMAX_CHANNEL`) + single-instance `channel.lock`. |
| `scripts/onboard.js` | One-shot onboarding: config, register + accept, permission rules, launch the channel session. |
| `src/storage.js` | File-backed `StorageProvider` under a local data dir (XDG); no `~/zylos` coupling. |
| `src/providers.js` | stderr logger + empty `RuntimeStateProvider` (Cat.B degraded metrics). |
| `.claude-plugin/plugin.json` | Registers the `openmax` MCP server for Claude Code. |
| `hooks/hooks.json` + `hooks/session-hook.js` + `hooks/orientation.js` | `SessionStart` orientation injection (survives resume/compaction). |
| `CLAUDE.md` | Agent-facing instructions: how wakes arrive, how to read/reply, tool map. |
| `test/*.test.js` | `node --test` unit tests (frame derivation, `ok:true` gating, coalescing, tool dispatch, orientation). |

## Session / context management

Uses Claude Code's **built-in autocompact** (and `/clear` / `/compact`). This
adapter implements **no extra compression logic** — by design.

## Installation

Install as a Claude Code plugin from this repo's marketplace:

```bash
claude plugin marketplace add openmaxai/claude-openmax   # register the marketplace (once)
claude plugin install openmax-channel@openmax            # install the plugin
```

Claude Code fetches the plugin, installs it into its managed plugin directory,
and keeps it updated — no manual `git clone` needed. Then create your config
(see [Configuration](#config--env)) and start Claude Code.

> **Experimental wake — one caveat.** The MCP **tools** (`tm`/`kb`/`as`/`comm`/
> `core`/`conn` + `comm_send`) work from a plain plugin install with no flags.
> The **inbound wake** (`claude/channel`, how workspace messages reach the agent)
> is still an *experimental* Claude Code capability and currently requires
> launching with the development-channels flag:
>
> ```bash
> claude --dangerously-load-development-channels plugin:openmax-channel@openmax
> ```
>
> **Reference the plugin, not a bare server name.** When installed via
> `claude plugin install`, Claude Code namespaces this MCP server — `/mcp` shows
> it as `plugin:openmax-channel:openmax`, **not** `openmax`. So the bare
> `--dangerously-load-development-channels server:openmax` does **not** match a
> plugin install (it only works if you register the server directly in a
> `.mcp.json` under the literal name `openmax`); use the `plugin:…@…` form above.
> If in doubt, run `/mcp` and reference the exact server name it prints.
> Once `claude/channel` graduates from experimental, install alone will be enough.

### One-shot onboarding (`scripts/onboard.js`)

An OpenMax invitation prompt runs the whole onboarding as **one** Bash call — one
approval for the user — and then starts the channel session itself:

```bash
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
claude plugin marketplace add https://github.com/openmaxai/claude-openmax.git#openmax-channel--v<version> \
&& claude plugin install openmax-channel@openmax --scope user \
&& node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openmax/openmax-channel/<version>/scripts/onboard.js" --launch <<'JSON'
{ …the invitation's config JSON… }
JSON
```

`onboard.js` writes the config (0600), registers the agent and accepts the
invitation (per-request timeouts under a 45 s budget; registration is retried only
when the request provably never reached the server, so no orphan identity is
created), appends the OpenMax
tool rules to `permissions.allow`, and with `--launch` starts
`CLAUDE_OPENMAX_CHANNEL=1 claude --dangerously-load-development-channels plugin:openmax-channel@openmax "<greeting>"`
in tmux — a new window if you are already in tmux, otherwise a detached session
`openmax` (`tmux attach -t openmax`); without tmux it prints the command. You then
confirm Claude Code's dev-channel warning dialog yourself (the script never answers
it). Output ends with `ONBOARD OK` / `LAUNCH:` / `NEXT:` / `RESTART_COMMAND:` on
success or `ONBOARD FAILED: <step>: <reason>` on failure; exit codes are 0 (ok, also
"already onboarded"), 1 (failed — nothing is launched), 2 (bad usage / input).
Re-running it is safe. A running `openmax` tmux session is reused only if this run
kept the same agent identity; after a new registration it prints `LAUNCH: manual`
and asks you to close the old session first. `node scripts/onboard.js --help`
prints the usage.

### Which session receives messages

The plugin's MCP server starts in **every** Claude Code session, but Claude Code
delivers channel pushes only to a session launched with the channel flag, and drops
them silently anywhere else. So the workspace connection (WS) is opened only when
the session is channel-active — `CLAUDE_OPENMAX_CHANNEL=1` in its environment (the
command above sets it; `=0` forces it off). If the variable is unset, the plugin
falls back to checking whether its parent `claude` process was started with
`--dangerously-load-development-channels`/`--channels` naming `openmax-channel`.
Only **one** channel-active session holds the connection at a time
(`<data dir>/channel.lock`); a second one gets the tools only and a notice. Every
other session still has all MCP tools (`comm_send` works over REST), stays offline,
and never acknowledges a message it cannot show — the message waits for `/sync`
redelivery to the channel session.

**Startup and network errors:** if the config has no `agent.api_key` yet when the
server starts (registration still running in the `SessionStart` hook), it waits up
to 120 s for the key to appear instead of running the whole session on an empty key;
the tools answer "registration in progress" meanwhile. Workspace HTTP calls time out
after 15 s waiting for a response, errors name the request and its cause
(`fetch failed: POST /auth/ws-ticket → ECONNRESET`), and the token / ws-ticket calls
are retried twice on network errors.

**Group messages:** with the default access policy written by the invitation
(`groupPolicy: "allowlist"`, no groups listed), a group message reaches the agent
only when the owner @-mentions it; anything else in a group is dropped without a
reply. Direct messages from the owner always come through. This is intentional and
unchanged — @-mention the agent in groups.

## Security

What installing and onboarding this plugin does on your machine, so you can check it
before approving:

- **Installs:** this repository (public, `openmaxai/claude-openmax`) into Claude
  Code's plugin cache. Claude Code runs `dist/index.mjs` as a local MCP server
  (stdio) and `hooks/session-hook.js` on `SessionStart`. Plugins run with your user's
  permissions — only install from a tag/commit you trust.
- **Files written:**
  - `~/.config/claude-openmax/config.json` (or `$CLAUDE_OPENMAX_CONFIG`), mode 0600 —
    server URLs, the agent's api_key, optional CF-Access service-token pair, and the
    one-time invite (removed once accepted). A replaced config is kept as
    `config.json.bak-openmax-<ts>` (0600).
  - `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` — five entries **appended** to
    `permissions.allow`; nothing else is changed, the previous file is saved as
    `settings.json.bak-openmax-<ts>` first, and a file that is not valid JSON is
    refused.
  - `~/.local/share/claude-openmax/` (or `$CLAUDE_OPENMAX_DATA_DIR`) — token cache,
    sync cursors, dedupe ledger, downloaded media, `channel.lock`; files 0600.
  - A log file only if you set `CLAUDE_OPENMAX_LOG_FILE` (0600, secrets scrubbed).
- **Endpoints called** (only the workspace server in your config — `server.bff_url`
  / `server.ws_url`): `POST /auth/register/agent`, `POST /auth/agent/token`,
  `POST /api/v1/invitations/<id>/accept` during onboarding; then the agent token /
  ws-ticket endpoints, the workspace REST API (`/api/v1/...`) for the MCP tools, and
  the cws-comm WebSocket — the WebSocket only from the channel-active session. No
  other hosts, no telemetry.
- **Permissions added:** `mcp__plugin_openmax-channel_openmax__comm`, `…__comm_send`,
  `…__tm`, `…__kb`, `…__core`. The `as` (file upload/download) and `conn` (connection
  credentials) tools are **not** allowed and keep prompting per call. Remove the
  entries from `permissions.allow` to undo.
- **Verify what you run:**
  - Tag ↔ commit: `git ls-remote https://github.com/openmaxai/claude-openmax.git refs/tags/openmax-channel--v<version>`
    and compare with the SHA the invitation shows; the installed copy's
    `.claude-plugin/plugin.json` `version` must match.
  - Bundle ↔ source: `dist/` is generated, not hand-written, and unminified. In a
    checkout of the tag: `npm ci && npm run build && git diff --exit-code dist/` —
    CI runs the same check on every PR.
  - SDK: the bundled `@openmaxai/openmax-agent-sdk` source is public
    (`github.com/openmaxai/openmax-agent-sdk`) and its npm releases carry provenance
    — `npm view @openmaxai/openmax-agent-sdk@<version> dist.attestations` or
    `npm audit signatures` in a checkout.

## Running (from source / dev)

```bash
npm install                     # resolves @openmaxai/openmax-agent-sdk@alpha from npm
cp config.example.json ~/.config/claude-openmax/config.json   # fill in real values
npm test                        # node --test
```

Load into Claude Code as a plugin (dev):

```bash
claude plugin marketplace add --scope local /path/to/claude-openmax   # local checkout
# or point Claude Code at .claude-plugin/plugin.json directly
```

## Build (maintainers)

The plugin ships a **dependency-free bundle**. Claude Code installs a marketplace
plugin by cloning the repo and does **not** run `npm install`, so the MCP server
must run with zero `node_modules`. `scripts/build.js` (esbuild) inlines every
dependency into `dist/index.mjs` (the MCP server, referenced by
`.claude-plugin/plugin.json`) and `dist/bridge.mjs` (the split-topology bridge).

```bash
npm run build     # rebuild dist/ after changing src/ or bumping a dependency
```

`dist/` is committed (it is the shipped artifact); CI rebuilds it and fails if the
committed bundle is stale, and smoke-tests that it loads with no `node_modules`.

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
`CLAUDE_OPENMAX_CONTENT_FREE`, `CLAUDE_OPENMAX_WAKE_{HOST,PORT,TOKEN}`,
`CLAUDE_OPENMAX_CHANNEL` (`1` = this session receives workspace messages; see
"Which session receives messages").

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

**Session files auto-migrate.** Per-org state (incl. the `/sync` cursor) is now
keyed by `org_id` (`sessions/<org_id>.json`), where earlier builds used a derived
slug (`sessions/<slug>.json`). On first load, if only a legacy `sessions/<slug>.json`
exists (matching an explicit `slug` or `slugify(org_name)`), it is copied forward
to the `org_id` key so the cursor is preserved — no duplicate message delivery after
upgrade. The old file is left in place (harmless); no manual step is needed.

Each org also honors an **`enabled: false`** flag — such orgs are kept on disk but
not connected to (parity with the openmax component).

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
