# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

  **This depends on an unreleased SDK.** The resolution itself lives in
  `@openmaxai/openmax-agent-sdk` (`resolveOutbound`), which the currently pinned
  1.0.3 does not have. Against 1.0.3 this code degrades to sending verbatim —
  correct, but inert. It becomes live once the SDK ships that method and the
  dependency here is bumped.


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
