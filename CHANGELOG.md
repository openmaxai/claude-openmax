# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  without them on public/prod. An empty `cf_access` block is no longer persisted
  back to config. No other behavior changed (idempotency, placeholder-key
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
