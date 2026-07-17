/**
 * OpenMax session orientation text + SessionStart hook output builder.
 * Kept separate from the hook entry so it is unit-testable.
 */

export const OPENMAX_SESSION_ORIENTATION =
  'You are connected to OpenMax, a shared workspace for humans and agents (COCO Workspace). '
  + 'Workspace messages are delivered into your context as channel wake notices via the `openmax` MCP server. '
  + 'When a wake notice arrives, use the `comm` tool (getMessages / getMessage) to read the full message, '
  + 'then reply with the `comm_send` tool. Use the `tm` / `kb` / `as` / `core` / `conn` tools to operate the '
  + 'workspace (create issues and tasks, query the knowledge base, upload files, etc.). '
  + 'Call any dispatch tool with {"method":"list"} to discover its available verbs. '
  + 'Session/context management uses Claude Code\'s built-in autocompact — do not implement extra compression.';

export function buildSessionStartOutput(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.hook_event_name !== 'SessionStart') return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: OPENMAX_SESSION_ORIENTATION,
    },
  });
}
