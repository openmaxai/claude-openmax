#!/usr/bin/env node
/**
 * SessionStart hook — inject the OpenMax orientation into a fresh/resumed
 * Claude Code session (adapted from raft v0.3.1's SessionStart orientation).
 *
 * Invariants (same discipline as raft's activity-hook):
 *   - ALWAYS exits 0. A non-zero exit would perturb the user's session; a
 *     reporting/orientation miss must degrade silently.
 *   - Reads only hook_event_name from stdin — never transcript_path or prompts.
 *   - For SessionStart it prints the orientation as hookSpecificOutput
 *     additionalContext, which Claude Code injects into the session.
 */

import { buildSessionStartOutput } from './orientation.js';
import { ensureRegistered } from './auto-register.js';

const STDIN_TIMEOUT_MS = 3000;

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), timeoutMs);
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.once('error', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

async function main() {
  const input = await readStdin(STDIN_TIMEOUT_MS);
  let payload;
  try { payload = JSON.parse(input); } catch { return; }
  // Auto-register on first session (idempotent, best-effort — never throws).
  await ensureRegistered().catch(() => undefined);
  const out = buildSessionStartOutput(payload);
  if (out) process.stdout.write(out + '\n');
}

main().catch(() => undefined).finally(() => process.exit(0));
