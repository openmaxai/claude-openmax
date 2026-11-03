# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [1.3.3] - 2026-11-03

Fixes from the INT real-machine end-to-end test of 1.3.2 (Claude Code 2.1.308).

### Fixed

- **`onboard.js --launch` started a session that exited at once — and reported
  success** (`scripts/onboard.js`). `--dangerously-load-development-channels` takes
  several values, so Claude Code read the greeting prompt that followed the plugin
  ref as a second channel entry and exited 1 (`--dangerously-load-development-channels
  entries must be tagged: …`); the tmux window/session vanished, yet the script
  printed `LAUNCH: tmux-window` / `tmux-session`. The launch command and
  `RESTART_COMMAND` now put `--` before the prompt. A newly started window/session
  must also still be running after 3 s: it is created with `remain-on-exit` (in the
  same tmux command), checked, and on an early exit the script prints
  `launch: FAILED the channel session exited right after starting (exit status N): <last output lines>`,
  removes the dead window/session it just created, and reports `LAUNCH: manual`
  with a NEXT line that says what went wrong. A live one gets `remain-on-exit`
  reset to the user's default.
- **The first channel session skipped messages sent right after onboarding**
  (`src/first-sync.js`, `loadSession` in `src/config.js`, `src/create-bridge.js`,
  `scripts/onboard.js`). With no saved `/sync` cursor the SDK seeks to the END of
  the inbox (`init sync_seq=N (seeked to inbox end)`), so a DM sent between
  onboarding and the first channel session was never delivered or answered. When
  the onboarding registers a NEW identity it now writes `<dataDir>/first-sync.json`
  (api_key fingerprint + the org ids it joined, 0600); the first channel session for
  that identity then catches up those orgs' inboxes from seq 0 through the normal
  dedupe → access-policy → deliver path. A new identity has no older inbox history,
  so nothing from before the onboarding is replayed. When the first real cursor is
  saved, the SDK inbox ledger is advanced to it (as the seek-to-end path does) —
  otherwise a first seq that is not a deliverable message would leave a permanent
  hole and the ledger would re-run `/sync` from 0 every ~10 s. The marker is
  ignored for any other api_key and for orgs joined later, never used when a
  cursor exists, and retired per org once a real cursor is saved. Existing
  identities keep the seek-to-end behaviour.
- **Routine token logs at ERROR level** (`ERROR [token] ws-ticket ok …`). The SDK
  TokenManager's exchange / refresh / ws-ticket progress lines are now logged at
  INFO, its cache-discard notice at WARN (`levelTokenLogs` in `src/providers.js`).
- Network errors keep undici's code and add its readable message, e.g.
  `fetch failed: POST /auth/ws-ticket → UND_ERR_SOCKET: other side closed` (log,
  tool errors, onboarding errors).

### Notes

- A launched session that dies more than 3 s after starting is not detected (it
  still counts as launched).
- `inbox-ledger: gap persisted … triggering /sync from 0` (seen four times without
  a `/sync` request in the E2E log): SDK 1.1.0 `syncMissedEvents` returns early
  while the session cursor is 0, which is the state after a first connect that
  found an empty inbox; the ledger then keeps re-triggering a sweep that never
  runs. Not changed here (SDK-side). The first-sync path above starts with a
  non-zero cursor and advances the ledger, so it neither hits that early return nor
  leaves a gap of its own.

## [1.3.2] - 2026-11-02

The rest of Plane OPENM-1107 / cws-core#269 (the gating part shipped in 1.3.1).

### Fixed

- **Startup race left a session offline for good** (`src/index.js`,
  `waitForApiKey` in `src/config.js`). The MCP server read its config once at
  startup while registration could still be running (in 1.3.0 the `SessionStart`
  hook registered; since 1.3.1 the onboarding command does, possibly while a session
  is already starting); if it won the race, the TokenManager was built with an empty key and never re-read it, so the
  whole session stayed offline. With no usable key the server now advertises its
  tools at once (they answer "waiting for the API key — run the onboarding command
  if you haven't"), polls the config every
  2 s for up to 120 s, and builds the runtime and connects once the key lands.
  If it gives up, it releases `channel.lock`, so a later session is not locked out.
- **"fetch failed" with no detail, and requests that could hang forever**
  (`src/fetch-guard.js`, injected into the SDK `TokenManager` + `CwsHttpClient`).
  15 s time-to-headers timeout for JSON API calls (uploads exempt); errors now read
  `fetch failed: <METHOD> <path> → <cause>` / `fetch timed out after 15000ms: …`
  (path only, no query string); token / refresh / ws-ticket calls retry twice on
  network errors. Tool errors returned to Claude keep the cause too.
- **Thread replies went to the main conversation** (`src/wake.js`). The wake now
  carries the SDK's `endpoint` (`<conv>|thread:…|parent:…`) in the notice text,
  the reply hint and `meta.openmax_endpoint`.
- **Attachment-only messages had an empty preview** — the preview now ends with
  `[N attachments: name, …]` (names only, at most five listed). This also keeps
  such wakes valid for the split topology, which requires a non-empty preview.
- A permanently terminated org connection (WS close 4002/4005/4006) is now also
  pushed into the channel session as a notice instead of only being logged.

### Documentation

- Group-message behaviour is unchanged and now documented (README, CLAUDE.md):
  with the default policy the agent only sees group messages that @-mention it.


## [1.3.1] - 2026-11-02

Onboarding in one approval (Plane OPENM-1106 / cws-core#268), plus the three
OPENM-1107 gating fixes it depends on (Plane OPENM-1107 / cws-core#269): the
onboard script starts a second Claude Code session while the first is still
running, and without the gate both would hold the workspace connection.

### Added

- **`scripts/onboard.js`** — one command for the invitation prompt: write the
  config from stdin (0600), register + accept the invitation (per-request
  timeouts under a 45 s total budget; up to 3 retries — for registration only on
  failures that prove no identity was created, i.e. connection never established
  or HTTP 503/429, so a retry can never leave an orphan identity), append the OpenMax tool rules to
  `permissions.allow` in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
  (append-only, backup first, corrupt JSON refused), self-check, and with
  `--launch` start `CLAUDE_OPENMAX_CHANNEL=1 claude --dangerously-load-development-channels plugin:openmax-channel@openmax`
  in tmux (new window inside tmux, detached `openmax` session outside, printed
  command without tmux). Prints `ONBOARD OK` … `RESTART_COMMAND: …` or
  `ONBOARD FAILED: <step>: <reason>`; exit 0 / 1 / 2. Idempotent: a re-run keeps
  the existing registration, does not duplicate rules and reuses the tmux window.
  A running `openmax` window/session is NOT reused when this run registered a new
  identity or replaced the config (it would still hold the old key): the script
  prints `LAUNCH: manual` and asks the user to close it first, and never kills it.
  `settings.json` is replaced atomically (temp file + rename, mode kept, 0600
  backup). Nothing is launched after any failure, and no dialog is ever answered
  for the user.
- Allowed tools: `comm`, `comm_send`, `tm`, `kb`, `core`. `as` and `conn` still
  prompt per call.
- README **Security** section: what is installed, files written, endpoints called,
  permissions added, how to verify tag / commit / bundle / SDK provenance.

### Fixed

- **Only a channel-active session connects to the workspace** (`src/channel-gate.js`,
  `src/index.js`). Every Claude Code session started the MCP server and opened the WS,
  so a session without the channel showed the agent online while Claude Code dropped
  its pushes. The WS now opens only with `CLAUDE_OPENMAX_CHANNEL=1` (fallback when
  unset: the parent `claude` argv carries the channel flag for this plugin); other
  sessions keep every tool.
- **Single instance:** `<data dir>/channel.lock`, created atomically (pid written to
  a temp file, then hard-linked into place, so it is never seen empty); a stale lock
  is taken over only under an O_EXCL takeover mutex, re-checked before and after it
  is moved aside, and a live lock moved by mistake is put back (or left in place,
  never deleted). The lock records pid + process start time + boot id, so a pid
  reused after a restart or reboot is recognised as stale (Linux: `/proc/<pid>/stat`
  starttime + `boot_id`; macOS: `ps -o lstart` read with `LC_ALL=C TZ=UTC0` and
  compared as epoch seconds, so sessions with different time zones or locales
  agree). macOS has no boot-id check: `kern.boottime` moves whenever the clock is
  adjusted, and pid + start time already catch a reboot. When the start time /
  boot id cannot be read it falls back to pid liveness. Applies in `channel-only` mode
  too.
  A second channel-active session runs tools-only and is told so, instead of
  processing every message twice.
- **No false delivery ack:** a session that may not deliver refuses the wake
  (`runtime_unavailable`), so the SDK returns `ok:false`, does not mark the message
  read or advance the cursor, and redelivers it via `/sync` to the channel session.
- `hooks/auto-register.js` run standalone printed `no-op (already registered / nothing
  to do)` and exited 0 when registration **failed**. It now prints `FAILED: <step> →
  <reason>` (with the network cause, e.g. `fetch failed (ECONNREFUSED)`) and exits 1;
  a real no-op still exits 0.
- **The SessionStart hook no longer registers the agent** — it only accepts a
  still-pending invitation (8 s budget, always exits 0). Its budget is shorter than
  a slow registration, and a registration aborted after it reached the server lost
  the new identity's key, so the next session registered yet another identity.
  Registration now happens only in the onboarding command. A registration whose
  outcome is unknown (timeout, budget abort, reset, HTTP 502/504) is never retried
  automatically and says what to do.


## [1.3.0] - 2026-09-18

Makes the outbound `@mention` resolution that landed in the previous commit
actually take effect: the SDK method it calls has shipped, and the pin here now
points at it. Until this bump the feature was present but inert.

### Added

- **Outbound `@mention` resolution on the send path** (`src/mcp-tools.js`,
  wired in `src/index.js`). An `@name` typed in the message text is now turned
  into a structured, top-level `mentions` row before the message leaves, so the
  recipient actually gets a notification and an unread-mention badge. Previously
  the text rendered as a mention client-side while nobody was notified, which is
  indistinguishable from a working mention by eye.
  - `comm_send` and the `comm` dispatch tool's `send` verb both go through it —
    treating only one of them would make the other a silent bypass.
  - The per-conversation roster is read once per minute, and only for text that
    actually contains an `@`, so an ordinary message costs no extra request.
  - Resolution failure is never allowed to cost a send: on any error the original
    text goes out verbatim with no mentions.
  - When nothing resolves, no `mentions` key is added at all — an empty array
    would change the call shape for every message that mentions no one.

### Changed

- **`@openmaxai/openmax-agent-sdk` pinned 1.0.3 → 1.1.0.** The resolution itself
  lives in the SDK (`createMentionRegistry().resolveOutbound`), which 1.0.3 does
  not expose — against 1.0.3 the send path fell through its own error branch and
  sent verbatim with no `mentions`, so a typed `@name` still notified nobody. The
  fallback is deliberate (resolution must never cost a send) and it is also what
  made the gap invisible: the code was correct but inert. 1.1.0 adds
  `resolveOutbound` and `recordMembers`, so the mentions rows now actually go out.

  The adapter's tolerance of a registry without `resolveOutbound` is kept and
  still tested — it guards the fallback contract, not the old pin.


## [1.2.0] - 2026-08-27

Feature release: the agent's access policy is now reconciled with the server in
both directions, so the workspace settings page and the agent finally agree on
who may reach the agent.

### Added

- **Two-way access-policy reconcile** (`src/policy-sync.js`,
  `runtime.reconcilePolicyWithServer`). The workspace settings page renders the
  policy cws-core has on record, while the agent enforces the policy in its local
  config, and nothing kept the two in step: an agent that never reported looked
  wide open on the page (`group scope: open` — cws-core's synthesized default for
  "no policy row on file") while in fact refusing every group message, and a
  policy edited in the UI while the agent was offline never reached local config.
  The reconcile runs on three triggers — the existing 5-minute owner-sync tick,
  a debounced pass after each `agent.config.*` event, and a debounced pass after
  a local access change made through the SDK's `dm_policy` / `dm_allow` /
  `dm_revoke` tools.
- It is deliberately **pull-first**: it reads `GET /agents/<self>/policy` and
  uploads to `PUT /agents/<self>/reported-policy` only when that read proved
  there is nothing to lose. A server copy that moved since the last pass wins and
  is adopted into local config (with the SDK's live access reference repointed,
  so the gate applies it without a restart); a local change is uploaded only when
  the server has not moved; a failed or unreadable policy read uploads nothing at
  all. A blind periodic push — what the sibling adapters do — is how an agent's
  stale config overwrites a policy a human just set from the UI.
- The mapping in `src/policy-sync.js` transcribes the SDK's own `decideInbound`
  fallbacks value for value (`dmPolicy || 'owner'`, `groupPolicy || 'allowlist'`,
  `mode || 'mention'`, and "empty/absent/`['*']` allow-from all mean any member"),
  with a `group_scope` that is always sent explicitly because cws-core substitutes
  `open` for a missing one. Two cases the server cannot express are handled
  head-on: a `silent` group is dropped from `groups[]` **and**
  `group_allowlist` (its mode enum is smart|mention and one bad entry rejects the
  whole upload), and the owner's unconditional DM exemption is *not* forged into
  `dm_allowlist` (that entry would outlive an owner transfer). A `4xx` naming one
  of the reported conversations — the server saying the agent is no longer in that
  group — drops that group and retries once instead of being mistaken for a
  missing endpoint and silencing all reporting.

### Changed

- `@openmaxai/openmax-agent-sdk` 1.0.1 → 1.0.3 (log-redaction fixes only; no
  behavior change for this adapter).

## [1.1.2] - 2026-07-22

Bug-fix release: agent self-registration and invite-acceptance now work on
public/production deployments that are not behind Cloudflare Access.

### Fixed

- `hooks/auto-register.js` treated Cloudflare Access (CF-Access) credentials as
  mandatory. That is correct for the INT deployment (cws-int.coco.xyz, which
  sits behind Cloudflare Access and needs `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers), but production `openmax.com` is public and
  needs no CF headers — so on prod, agent self-registration and invite
  acceptance were unconditionally skipped/blocked. CF-Access headers are now
  OPTIONAL: they are sent only when both credentials are present (INT behaves
  exactly as before), and registration + token-exchange + invite-accept proceed
  without them on public/prod. On registration, an empty/blank `cf_access` block
  (e.g. the one `config.example.json` seeds) is stripped from the config rather
  than left in place — so it never lingers to make the runtime emit empty
  CF-Access headers. No other behavior changed (idempotency, placeholder-key
  detection, 0600 persistence, invite-clear-after-accept, timeouts).

## [1.1.1] - 2026-07-22

Bug-fix release: policy changes made in the OpenMax workspace UI now actually
apply to the agent's local config and live access gate.

### Fixed

- `onConfigEvent` dropped every real config-event payload field. It ran a
  generic `pickAccess(data)` that only copied the literal keys `dmPolicy` /
  `dmAllowFrom` / `groupPolicy`, so events carrying `policy`, `scope`, `action`,
  `conversation_ids`, `member_ids`, `allow_from`, or `mode` (e.g.
  `agent.config.group_scope_changed`, `agent.config.group_allowlist_changed`)
  applied nothing — a group allowlisted in the UI was still locally rejected.
  Replaced `pickAccess` with an event-type-aware `applyConfigAccessEvent` that
  maps each `agent.config.*` event to the correct `access` mutation (mirroring
  the zylos-openmax reference handler), persists the change, and syncs the live
  SDK `orgConfig.access` reference so the access gate updates immediately.

## [1.1.0] - 2026-07-22

Stable release promoting `1.1.0-beta.1` and adding opt-in diagnostic logging.

### Added

- **Periodic owner pull-sync.** Every 5 minutes the adapter re-pulls each active
  org's authoritative owner from cws-core and reconciles it into local config.
  cws-core is the source of truth for an org's owner binding, and the SDK only
  hydrates the agent's own display name on (re)connect — so an owner rebound
  while the agent is online now propagates to local config without waiting for a
  restart.
- **`agent.config.owner_changed` handling (pull-not-trust).** An incoming
  owner-changed event is treated purely as a signal to re-pull the authoritative
  owner from cws-core — the owner value carried in the pushed frame is never
  trusted. Owner is the DM-access trust anchor, so a forged or replayed frame can
  never rebind the agent to an attacker.
- **10-second timeout guard on the owner-sync core calls.** The two `/members`
  lookups used by owner sync are time-bounded, so a hung or unresponsive core
  connection can never block the periodic task or the `owner_changed` handler; a
  timeout is treated like any other fetch failure (local owner kept, retried on
  the next sync).
- **Opt-in diagnostic file logging (`CLAUDE_OPENMAX_LOG_FILE`).** When that env
  var is set, the adapter tees its logs (adapter + SDK) to that file in addition
  to stderr, which is otherwise swallowed inside the claude-plugin/MCP host. The
  file is created `0600`, rotates to `<file>.1` when it exceeds 10 MB, and every
  line is scrubbed of common secret shapes (JWTs, `cwsk_…` keys, `Bearer` tokens,
  and labeled `api_key`/`client_secret`/`password`/`token` values). File logging
  is OFF by default (stderr-only). Startup logs the resolved config-file and
  log-file paths, and `onConfigEvent` plus the periodic owner-sync are
  instrumented so a policy/access change can be traced end to end.

### Fixed

- **Empty owner name now backfills.** When an earlier owner-name lookup failed or
  timed out and left the owner's display name empty, a later sync now fills it in
  instead of leaving it stuck empty.
- **No redundant writes.** An unchanged owner is no longer re-persisted on every
  periodic tick — the config file is only rewritten when the owner id or name
  actually changes.
- **Safer URL construction.** The member id in the `/members/{id}` core paths is
  now `encodeURIComponent`-encoded, matching the SDK's own convention.

## [1.1.0-beta.1] - 2026-07-22

### Added

- **Periodic owner pull-sync.** Every 5 minutes the adapter re-pulls each active
  org's authoritative owner from cws-core and reconciles it into local config.
  cws-core is the source of truth for an org's owner binding, and the SDK only
  hydrates the agent's own display name on (re)connect — so an owner rebound
  while the agent is online now propagates to local config without waiting for a
  restart.
- **`agent.config.owner_changed` handling (pull-not-trust).** An incoming
  owner-changed event is treated purely as a signal to re-pull the authoritative
  owner from cws-core — the owner value carried in the pushed frame is never
  trusted. Owner is the DM-access trust anchor, so a forged or replayed frame can
  never rebind the agent to an attacker.
- **10-second timeout guard on the owner-sync core calls.** The two `/members`
  lookups used by owner sync are now time-bounded, so a hung or unresponsive core
  connection can never block the periodic task or the `owner_changed` handler; a
  timeout is treated like any other fetch failure (local owner kept, retried on
  the next sync).

### Fixed

- **Empty owner name now backfills.** When an earlier owner-name lookup failed or
  timed out and left the owner's display name empty, a later sync now fills it in
  instead of leaving it stuck empty.
- **No redundant writes.** An unchanged owner is no longer re-persisted on every
  periodic tick — the config file is only rewritten when the owner id or name
  actually changes.
- **Safer URL construction.** The member id in the `/members/{id}` core paths is
  now `encodeURIComponent`-encoded, matching the SDK's own convention.
