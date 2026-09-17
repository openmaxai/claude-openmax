/**
 * Outbound @-mention wiring.
 *
 * Nothing in this adapter turned an agent's `@name` into a real mention, so
 * every `@` we sent was decorative. Two independent reasons, both fixed here:
 *
 *   1. **Where the mentions go on the wire.** cws-core builds its mention index
 *      from the mentions array at the **top level of the send request**
 *      (`{type, content, mentions:[{type:'member', member_id}]}`). An array
 *      nested under `content.body` is stored verbatim as part of the body and
 *      never reaches the index — the message reads back looking mentioned and
 *      wakes nobody. The receiving side agrees: the SDK's `extractMentions`
 *      reads `msg.mentions` (top level) and keys on
 *      `entity_id || mentioned_id || id`.
 *   2. **Resolving a name to a member id.** A structured mention needs the
 *      addressee's `member_id`. Learning names passively from inbound senders
 *      (below) only ever covers participants who have already spoken, so the
 *      send site hydrates the conversation roster before decorating — see
 *      `hydrateRoster` in mcp-tools.js.
 *
 * Canonicalization of the visible text still matters alongside the structured
 * array: cws-fe highlights a mention client-side by matching `@` + the exact
 * participant `display_name`, and the SDK's `isSelfNameMentionedInText` gate
 * matches `@<self display_name>` against the body text. A name differing by
 * case or by an alias is a silent no-op in both. The SDK ships that algorithm
 * (`createMentionRegistry`); this module adds what it cannot do on its own:
 *
 *   - **Member ids.** `createMentionRegistry` persists `normName -> display_name`
 *     (string values — `resolveMentions` calls `.length`/`.replace` on them, so
 *     the schema cannot hold objects). We keep a parallel `normName -> member_id`
 *     map under a separate key rather than forking the SDK's schema.
 *   - **The structured array**, emitted as `{type:'member', member_id}` entries
 *     for whichever canonicalized names resolved to a known member.
 */

import { createMentionRegistry } from '@openmaxai/openmax-agent-sdk';

const DEFAULT_KEY = 'mention-registry.json';
const DEFAULT_MEMBER_KEY = 'mention-members.json';
const MAX_NAMES_PER_CONV = 200;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Blank out every occurrence of `needle` in `text`, preserving length so the
 * remaining offsets keep lining up. Deliberately not a RegExp: a display_name
 * is arbitrary user input, and building a pattern out of it is a ReDoS surface
 * (and an escaping bug waiting to happen) for what is a plain substring search.
 *
 * @returns {{found:boolean, text:string}}
 */
function blankOut(text, needle) {
  let idx = text.indexOf(needle);
  if (idx === -1) return { found: false, text };
  let out = text;
  while (idx !== -1) {
    out = out.slice(0, idx) + ' '.repeat(needle.length) + out.slice(idx + needle.length);
    idx = out.indexOf(needle, idx + needle.length);
  }
  return { found: true, text: out };
}

/**
 * @param {object} opts
 * @param {import('@openmaxai/openmax-agent-sdk').StorageProvider} opts.storage
 * @param {string} [opts.key]        SDK registry key (name canonicalization)
 * @param {string} [opts.memberKey]  our parallel member-id map key
 * @param {number} [opts.maxNamesPerConv]
 * @param {(...a:any[])=>void} [opts.log]
 * @returns {{record:Function, decorate:Function}}
 */
export function createMentions({
  storage,
  key = DEFAULT_KEY,
  memberKey = DEFAULT_MEMBER_KEY,
  maxNamesPerConv = MAX_NAMES_PER_CONV,
  log = () => {},
} = {}) {
  if (!storage) throw new Error('createMentions requires a storage provider');

  const registry = createMentionRegistry({ storage, key, maxNamesPerConv, log });

  // Lazily loaded `{ [conversationId]: { [normName]: memberId } }`.
  let members = null;

  async function ensureMembers() {
    if (members) return members;
    try {
      const raw = await storage.get(memberKey);
      members = raw ? JSON.parse(raw) : {};
    } catch {
      // Missing or corrupt state must never break message handling.
      members = {};
    }
    return members;
  }

  async function persistMembers(m) {
    try {
      await storage.set(memberKey, JSON.stringify(m));
    } catch (err) {
      log(`mention members persist failed: ${err?.message || err}`);
    }
  }

  /**
   * Learn one participant. Called for every inbound sender and for every member
   * returned by a roster read. Both fields are best-effort: the SDK leaves
   * `senderDisplayName` empty when it could not resolve a name, and we simply
   * learn nothing in that case.
   *
   * @param {{conversationId?:string, displayName?:string, memberId?:string}} p
   */
  async function record({ conversationId, displayName, memberId } = {}) {
    const conv = String(conversationId ?? '').trim();
    const name = String(displayName ?? '').trim();
    if (!conv || !name) return;

    await registry.recordParticipants(conv, name);

    const id = String(memberId ?? '').trim();
    if (!id) return;
    const m = await ensureMembers();
    const bucket = m[conv] || (m[conv] = {});
    const nkey = norm(name);
    if (bucket[nkey] === id) return;
    bucket[nkey] = id;

    const keys = Object.keys(bucket);
    if (keys.length > maxNamesPerConv) {
      for (const k of keys.slice(0, keys.length - maxNamesPerConv)) delete bucket[k];
    }
    await persistMembers(m);
  }

  /**
   * Canonicalize the `@name` tokens in `text` and collect the structured
   * mentions for whichever of them resolved to a known member id.
   *
   * The caller decides how to put `mentions` on the wire — this module does not
   * build the request envelope, because the correct placement (top level, not
   * inside `content`) is a property of the send path, not of the text.
   *
   * @param {string} text
   * @param {string} conversationId
   * @returns {Promise<{text:string, mentions:Array<{type:string, member_id:string}>}>}
   */
  async function decorate(text, conversationId) {
    const conv = String(conversationId ?? '').trim();
    const original = typeof text === 'string' ? text : '';
    if (!original || !conv || !original.includes('@')) return { text: original, mentions: [] };

    const canonical = await registry.resolveMentions(original, conv);

    let known;
    try {
      const raw = await storage.get(key);
      known = raw ? (JSON.parse(raw)[conv] || {}) : {};
    } catch {
      known = {};
    }
    const idsByName = (await ensureMembers())[conv] || {};

    // Longest-first so "Alice Wong" wins over the "Alice" prefix, mirroring the
    // SDK's own resolution order. Matched spans are then blanked out of the
    // working copy: without that, the shorter name matches again INSIDE the
    // longer one's span and we emit a second, wrong mention for "@Alice Wong".
    const names = Object.values(known).sort((a, b) => b.length - a.length);
    const seen = new Set();
    const mentions = [];
    let remaining = canonical;
    for (const name of names) {
      const nkey = norm(name);
      if (seen.has(nkey)) continue;
      const hit = blankOut(remaining, '@' + name);
      if (!hit.found) continue;
      seen.add(nkey);
      remaining = hit.text;
      const memberId = idsByName[nkey];
      if (memberId) mentions.push({ type: 'member', member_id: memberId });
    }

    return { text: canonical, mentions };
  }

  return { record, decorate };
}
