/**
 * Local access policy ⇄ server reported-policy mappers (pure functions).
 *
 * Two representations of the same thing, and this module is the only place that
 * knows how to translate between them:
 *
 *   LOCAL  (config.json `orgs.<id>.access`, what the SDK's decideInbound reads)
 *     { dmPolicy, dmAllowFrom[], groupPolicy, groups: { <convId>: { mode, allowFrom[] } } }
 *
 *   SERVER (cws-core `PUT /agents/<id>/reported-policy` body, and the mirror
 *          shape returned by `GET /agents/<id>/policy`)
 *     { dm_policy, dm_allowlist[], group_scope, group_allowlist[],
 *       groups: [ { conversation_id, mode, allow_from[] } ] }
 *
 * ── Fidelity is the whole point ──────────────────────────────────────────────
 * The workspace settings page renders the SERVER copy, while the agent enforces
 * the LOCAL copy. Any mapping asymmetry shows up to a user as "the page says one
 * thing and the agent does another", which is the bug this module exists to fix.
 * So the defaults below are not "sensible defaults" — they are transcribed, value
 * for value, from the SDK's own fallbacks in
 * `@openmaxai/openmax-agent-sdk/src/protocol/access-policy.js` (decideInbound):
 *
 *   access.dmPolicy    || 'owner'      (access-policy.js:161)
 *   access.dmAllowFrom || []           (access-policy.js:191)
 *   access.groupPolicy || 'allowlist'  (access-policy.js:221)
 *   groupCfg?.mode     || 'mention'    (access-policy.js:258)
 *   allowFrom: undefined / [] / containing '*' all mean "any member may
 *              trigger me" (access-policy.js:267-268)
 *
 * If one of those literals drifts from the SDK, a policy decision silently flips
 * between the page and the agent. test/owner-sync.test.js pins them by running
 * the real decideInbound over a matrix of access shapes and asserting a
 * local-vs-round-tripped decision match, so a drifted default fails the suite
 * rather than shipping.
 */

/**
 * Per-group `allow_from` as the SERVER should store it.
 *
 * Locally, `undefined` and `[]` both mean "any member may trigger me" — the SDK
 * gate is `allowFrom && allowFrom.length > 0 && !allowFrom.includes('*')`. On the
 * wire that must become the explicit wildcard: an empty array survives JSON, and
 * the settings page renders it as "no members selected" — the exact INVERSE of
 * the local meaning. (`[] || ['*']` does not do this: an empty array is truthy in
 * JS, so the `||` fallback zylos-openmax uses never fires for it.)
 */
function reportedAllowFrom(allowFrom) {
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return ['*'];
  return [...allowFrom];
}

/**
 * Project a local `access` block onto the server's reported-policy body.
 *
 * Two deliberate exclusions:
 *
 * 1. `mode: 'silent'` entries are dropped from `groups[]` AND from
 *    `group_allowlist`. The server's mode enum accepts only smart|mention and
 *    validates the WHOLE report before writing anything, so a single silent
 *    entry 400s the entire upload — every other group's settings included. A
 *    silent group means "do not participate here", so omitting it from the
 *    allowlist is also the faithful projection, not just damage control.
 *    Anything outside smart|mention|silent is dropped for the same reason (a
 *    hand-edited typo must not be able to wedge the whole report).
 *
 * 2. The owner's unconditional DM exemption (access-policy.js:166-173 — the
 *    bound owner reaches us whatever dmPolicy says) has NO server-side
 *    equivalent. We do NOT paper over that by injecting the owner into
 *    `dm_allowlist`: that would grant the owner a *standalone* allowlist entry
 *    that survives an owner transfer, i.e. leave a former owner with DM access
 *    the local gate would have revoked. The page showing a shorter allowlist
 *    than the effective policy is the lesser evil, and it is honest about what
 *    the server actually stores.
 *
 * @param {object} [access]  local access block (may be undefined/partial)
 * @returns {{dm_policy:string, dm_allowlist:string[], group_scope:string, group_allowlist:string[], groups:Array<{conversation_id:string, mode:string, allow_from:string[]}>}}
 */
export function buildReportedPolicy(access) {
  const a = access || {};
  const groups = [];
  const groupAllowlist = [];
  for (const [convId, cfg] of Object.entries(a.groups || {})) {
    if (!convId) continue;
    const mode = cfg?.mode || 'mention';
    if (mode !== 'smart' && mode !== 'mention') continue; // silent / unknown — see (1) above
    groupAllowlist.push(convId);
    groups.push({ conversation_id: convId, mode, allow_from: reportedAllowFrom(cfg?.allowFrom) });
  }
  return {
    dm_policy: a.dmPolicy || 'owner',
    dm_allowlist: Array.isArray(a.dmAllowFrom) ? [...a.dmAllowFrom] : [],
    // ALWAYS sent explicitly. `group_scope` is optional in the request body and
    // cws-core substitutes "open" when it is absent (agent_policy.go report
    // handler) — omitting it on an allowlist/disabled agent would silently
    // widen the server's copy to "any group".
    group_scope: a.groupPolicy || 'allowlist',
    group_allowlist: groupAllowlist,
    groups,
  };
}

/**
 * Inverse mapper: a `GET /agents/<id>/policy` snapshot → a local access block.
 *
 * Used when the server copy wins (someone edited the policy in the workspace UI
 * while we were offline), so it must produce a block the SDK gate reads the same
 * way the settings page displays it.
 *
 * A conversation listed in `group_allowlist` but carrying no `groups[]` row gets
 * a local entry with the SDK's own defaults. Without it the allowlist gate
 * (access-policy.js:230) would reject a conversation the page shows as allowed —
 * on the server the allowlist and the per-group rows are separate tables and only
 * the former is populated until someone touches that group's mode/allow-from.
 *
 * @param {object} [snapshot]  parsed GET /policy body
 * @returns {{dmPolicy:string, dmAllowFrom:string[], groupPolicy:string, groups:object}}
 */
export function accessFromServerPolicy(snapshot) {
  const s = snapshot || {};
  const groups = {};
  for (const g of Array.isArray(s.groups) ? s.groups : []) {
    const convId = g?.conversation_id;
    if (!convId) continue;
    groups[convId] = {
      mode: g.mode || 'mention',
      allowFrom: Array.isArray(g.allow_from) && g.allow_from.length ? [...g.allow_from] : ['*'],
    };
  }
  for (const convId of Array.isArray(s.group_allowlist) ? s.group_allowlist : []) {
    if (convId && !groups[convId]) groups[convId] = { mode: 'mention', allowFrom: ['*'] };
  }
  return {
    dmPolicy: s.dm_policy || 'owner',
    dmAllowFrom: Array.isArray(s.dm_allowlist) ? [...s.dm_allowlist] : [],
    // Fall back to the SDK's local default rather than the server's ("open"):
    // a response missing the field tells us nothing, and guessing "open" would
    // widen access. Current cws-core always sends it.
    groupPolicy: s.group_scope || 'allowlist',
    groups,
  };
}

/**
 * Key-sorted canonical form. Object keys are sorted so serialization order can
 * never masquerade as a change; ARRAYS are sorted too because every list in the
 * reported policy is a set (member ids, conversation ids, per-group rows) whose
 * order carries no meaning — a server or config edit that merely reorders one
 * must not read as "the local policy changed" and trigger a pointless upload.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    items.sort((a, b) => {
      const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

/**
 * Stable fingerprint of a local access block, used to answer one question: "does
 * what we would upload differ from what we last uploaded / adopted?"
 *
 * Taken over the REPORTED PROJECTION, not the raw access block, so that
 * locally-equivalent spellings the server can't tell apart (`allowFrom: []` vs
 * `['*']`, key order, list order) do not each provoke an upload — while a change
 * the server WOULD see (a group flipped to silent disappears from the payload)
 * does.
 *
 * @param {object} [access]
 * @returns {string} canonical JSON — compare with ===
 */
export function accessFingerprint(access) {
  return JSON.stringify(canonical(buildReportedPolicy(access)));
}

/**
 * Which conversation ids from OUR payload does the server's error name?
 *
 * `PUT /reported-policy` answers 404 for two completely different reasons and the
 * status code alone cannot separate them:
 *
 *   - the endpoint does not exist (older cws-core deployment), or
 *   - one of the groups we reported is no longer ours — cws-comm's
 *     verifyAgentGroupMember returns not-found when the agent is not a member of
 *     that conversation any more, and cws-core relays the message verbatim, so
 *     the failing `group <conversation_id>: ...` detail carries the id.
 *
 * Matching our own ids against the error text is what tells them apart. The
 * zylos-openmax reference treats every 404 as "endpoint missing" and then stays
 * quiet for the rest of the process lifetime, so one group the agent was removed
 * from stops ALL policy reporting — that is the bug this exists to avoid.
 *
 * @param {object} err     rejected CwsHttpClient error ({status, message, body})
 * @param {Array<{conversation_id:string}>} groups  the groups we tried to report
 * @returns {string[]} ids named by the error (empty when none are)
 */
export function staleGroupIdsFromError(err, groups) {
  const ids = (Array.isArray(groups) ? groups : []).map((g) => g?.conversation_id).filter(Boolean);
  if (!ids.length) return [];
  let haystack = String(err?.message || '');
  try { haystack += ` ${JSON.stringify(err?.body ?? '')}`; } catch { /* body may be unserializable */ }
  return ids.filter((id) => haystack.includes(id));
}

/**
 * Copy of a reported-policy payload with the given conversations removed from
 * both `groups[]` and `group_allowlist` (they have to go together — a group left
 * in the allowlist with no row is a different policy than one that was dropped).
 */
export function withoutGroups(payload, convIds) {
  const drop = new Set(convIds || []);
  return {
    ...payload,
    group_allowlist: (payload?.group_allowlist || []).filter((id) => !drop.has(id)),
    groups: (payload?.groups || []).filter((g) => !drop.has(g?.conversation_id)),
  };
}
