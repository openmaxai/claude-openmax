/**
 * Expose the SDK's six service clients (tm/kb/as/comm/core/conn) as MCP tools.
 *
 * Design decision (adapter design §8.2 open question "MCP tools vs CLI shim"):
 * the six services carry ~150 sub-commands between them. Registering one tool
 * per sub-command risks blowing Claude Code's tool budget, so we register ONE
 * dispatch tool per service — `tm`/`kb`/`as`/`comm`/`core`/`conn`, each taking
 * `{ method, params }` — plus one dedicated convenience tool, `comm_send`
 * ({endpoint, content, replyTo, orgId}), for the outbound-reply hot path the
 * design calls out by name. The dispatch handler is a thin pass-through: look
 * up service[method], call it with params, return the JSON result. Because the
 * service methods are already the CLI verbs camelCased (project.list →
 * projectList), the tool layer has essentially no logic of its own.
 *
 * Field + purpose discovery (so the agent stops guessing param names, doesn't
 * mis-read a cws-core validation error as a permission error, AND picks the
 * RIGHT verb when several names look alike):
 *   - each dispatch tool's `description` inlines a compact signature reference
 *     for the high-frequency methods (`projectCreate(name*, slug?, ...) — new
 *     project`, `*` = required), each tagged with a few-word PURPOSE gloss so
 *     the agent knows what the verb does without a call;
 *   - the `{method:"list"}` meta-method returns the FULL per-method schema
 *     (`{name, summary, params:[{name, required, description}], note?}`) for
 *     EVERY spec'd method — a one-line purpose summary ("what it does / when to
 *     use") plus an exact field list — via progressive disclosure, so the long
 *     tail costs ZERO static context yet is one `list` call away.
 *
 * The `summary` (per-method purpose) is deliberately distinct from the param
 * descriptions: per MCP/Anthropic guidance the purpose line is the highest-
 * leverage field for correct method selection, whereas params only matter once
 * the verb is chosen.
 *
 * Ground truth: param NAMES + actual behavior come from the SDK service source
 * (openmax-agent-sdk/src/services/*.js); required-ness / lifecycle semantics
 * come from zylos-openmax/references/*-operations.md. Where the two disagree,
 * the SDK wins and the divergence is called out in the method `note`.
 */

const SERVICE_KEYS = ['tm', 'kb', 'as', 'comm', 'core', 'conn'];

const SERVICE_DESCRIPTIONS = {
  tm: 'Task management: projects, issues, tasks, blueprints, comments, attempts, event-bindings (cws-work via cws-core). method = a camelCase verb like projectCreate, issueCreate, taskCreate.',
  kb: 'Knowledge base: KB collections, directory tree nodes, pages + content/revisions/trash, full-text search, file upload. method = a camelCase verb like create, pageCreate, pageContentWrite, search.',
  as: 'Artifact store: upload/download media, resolve artifact:// URIs, presigned URLs. method = a camelCase verb like uploadMedia, getMediaUrl, downloadMedia, resolveUris. NOTE: as methods take POSITIONAL args (e.g. uploadMedia(localPath, opts)), not a single params object — call them from code, not through this dispatch shape.',
  comm: 'Communication: conversations, messages, history, mark-read, sync, DM access control. method = a camelCase verb like getMessages, getMessage, send, listConversations, createDm. Prefer the comm_send tool for replies.',
  core: 'Directory/identity: me, member/agent/org/role/invitation directory, agent profiles, self rename, onboarding. method = a camelCase verb like me, memberList, agentProfiles, orgList, selfRename.',
  conn: 'Connection credentials: list/acquire/proxy connection credentials + local cache. method = a camelCase verb like list, acquire, proxy, status, cached.',
};

/**
 * Per-method schema, keyed by service then method. Each entry is:
 *   { summary, params: [ [name, required(boolean), description], ... ] }
 *
 * `summary` is a one-line PURPOSE (what the verb does / when to use it,
 * plus the non-obvious "when NOT to") — the field the agent reads to pick the
 * right verb. `params` tuples mirror the SDK service source exactly for NAMES;
 * required-ness reflects what cws-core actually validates (per
 * references/*-operations.md). When a field is genuinely unclear it is marked
 * optional. `METHOD_NOTES` below adds caveats where the SDK method accepts
 * fewer/other fields than the docs imply (note = caveat, summary = purpose;
 * they are complementary).
 */
const METHOD_SPECS = {
  tm: {
    // Project
    projectList: {
      summary: 'List projects (filter status active/archived, search by name). Read-only browse before choosing an owning project.',
      params: [
        ['status', false, 'filter: "active" | "archived"'],
        ['query', false, 'search over name/description'],
        ['page', false, 'page number (offset paging)'],
        ['pageSize', false, 'items per page'],
        ['orderBy', false, 'sort key'],
      ],
    },
    projectCreate: {
      summary: 'Create a project (needs leadMemberId). Only when the user explicitly asks for a new one — never auto-create/silently default.',
      params: [
        ['name', true, 'project name'],
        ['leadMemberId', true, 'lead member id (cws-core requires it)'],
        ['description', false, 'markdown description'],
        ['slug', false, 'url slug (server derives one if omitted)'],
        ['isDefault', false, 'mark as the default/Inbox project'],
        ['knowledgeBaseId', false, 'associated KnowledgeBase id'],
        ['memberIds', false, 'array of member ids to add'],
      ],
    },
    projectGet: {
      summary: "Fetch one project's details by id.",
      params: [['id', true, 'project id']],
    },
    projectUpdate: {
      summary: 'Edit project metadata (name/description/lead). Does not touch membership or issue state.',
      params: [
        ['id', true, 'project id'],
        ['name', false, 'new name'],
        ['description', false, 'new description'],
        ['leadMemberId', false, 'new lead member id'],
      ],
    },
    projectArchive: {
      summary: "Archive a project (the UI's 'delete'): reversible soft-remove, NOT a hard delete.",
      params: [['id', true, 'project id (frontend "delete" maps here; no hard delete)']],
    },
    projectMembers: {
      summary: "List a project's members (paged).",
      params: [
        ['id', true, 'project id'],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    projectMemberAdd: {
      summary: 'Add a member to a project with a role (default "member").',
      params: [
        ['id', true, 'project id'],
        ['memberId', true, 'member id to add'],
        ['role', false, 'role (default "member")'],
      ],
    },
    projectMemberRemove: {
      summary: 'Remove a member from a project.',
      params: [
        ['id', true, 'project id'],
        ['memberId', true, 'member id to remove'],
      ],
    },
    // Issue
    issueList: {
      summary: 'List issues across all projects (filter status/priority/query). Global backlog view.',
      params: [
        ['status', false, 'single status filter'],
        ['statuses', false, 'array of statuses'],
        ['priority', false, 'low | medium | high'],
        ['includeArchived', false, 'include archived issues'],
        ['query', false, 'search text'],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    issueListInProject: {
      summary: 'List issues within one project (same filters as issueList, scoped by projectId).',
      params: [
        ['projectId', true, 'project id'],
        ['status', false, ''], ['statuses', false, ''], ['priority', false, ''],
        ['includeArchived', false, ''], ['query', false, ''],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    issueGet: {
      summary: "Fetch one issue's full details/state by id.",
      params: [['id', true, 'issue id']],
    },
    issueCreate: {
      summary: 'Create an issue: ownerMemberId = the human originator (acceptor), leadAgentId = yourself. Starts the guided-autonomy flow.',
      params: [
        ['projectId', true, 'owning project id'],
        ['title', true, 'issue title'],
        ['leadAgentId', true, 'lead agent id (usually yourself)'],
        ['ownerMemberId', true, 'governance/acceptance owner = the human originator'],
        ['description', false, 'markdown description (context, links, acceptance criteria)'],
        ['backlog', false, 'default true; pass false to go straight to in_progress'],
        ['priority', false, 'low | medium | high (default medium)'],
        ['originConversationId', false, 'conversation this issue originated from'],
        ['originMessageId', false, 'message this issue originated from'],
      ],
    },
    issueUpdate: {
      summary: 'Edit issue metadata (title/description/priority). Does NOT change state — use the transition verbs for that.',
      params: [
        ['id', true, 'issue id'],
        ['title', false, ''], ['description', false, ''], ['priority', false, ''],
      ],
    },
    issueActivate: {
      summary: 'Move an issue backlog→in_progress (wakes the Lead based on source). Skips the plan-submission step.',
      params: [
        ['id', true, 'issue id'],
        ['source', false, 'default "lead_chat"'],
      ],
    },
    issueSubmitPlan: {
      summary: 'Lead submits the plan for owner confirmation; requires blueprintId, writes a comment, state→pending_plan.',
      params: [
        ['id', true, 'issue id'],
        ['blueprintId', true, 'blueprint id backing the plan (required by the new flow)'],
        ['planText', false, 'human-readable markdown plan (alias: plan)'],
        ['source', false, 'default "lead_chat"'],
        ['cardMessageId', false, 'text-card message id'],
      ],
    },
    issueAcceptPlan: {
      summary: 'Owner accepts the plan (pending_plan→in_progress). source=text_card_proxy = Lead proxy-clicking accept AFTER the owner OK\'d in chat (vs im = via IM UI, explicit = direct owner action).',
      params: [
        ['id', true, 'issue id'],
        ['source', false, 'im | explicit | text_card_proxy (default text_card_proxy)'],
      ],
    },
    issueDeliver: {
      summary: 'Mark work delivered (in_progress→delivered); then notify the owner to accept. Takes only id.',
      params: [['id', true, 'issue id (in_progress → delivered)']],
    },
    issueResume: {
      summary: 'Reopen after owner feedback/non-acceptance (pending_plan|delivered→in_progress) to re-plan/rework. Never call a reject verb — clarify then resume.',
      params: [
        ['id', true, 'issue id'],
        ['reason', false, 'why resuming (alias: feedback)'],
        ['source', false, 'default "lead_chat"'],
      ],
    },
    issueAcceptDelivered: {
      summary: 'Owner accepts the delivery (delivered→accepted); closes the loop. source=text_card_proxy = Lead proxy-accepting AFTER owner OK\'d in chat (vs im/explicit).',
      params: [
        ['id', true, 'issue id'],
        ['source', false, 'im | explicit | text_card_proxy (default text_card_proxy)'],
      ],
    },
    issueReassignOwner: {
      summary: "Change the issue's acceptance owner (ownerMemberId). Cannot change archived issues.",
      params: [
        ['id', true, 'issue id'],
        ['ownerMemberId', true, 'new owner member id (alias: newOwnerMemberId)'],
      ],
    },
    issueMoveProject: {
      summary: 'Move an entire issue to a different project.',
      params: [
        ['id', true, 'issue id'],
        ['targetProjectId', true, 'destination project id (alias: newProjectId)'],
      ],
    },
    issueTerminate: {
      summary: 'End an issue early (→terminated); server cascades to cancel non-terminal tasks. Does not undo side effects already done.',
      params: [
        ['id', true, 'issue id'],
        ['reason', false, 'termination reason'],
        ['source', false, 'default "lead_chat"'],
      ],
    },
    // Task
    taskList: {
      summary: 'List tasks (filter by project/issue/status). Read-only.',
      params: [
        ['projectId', false, 'filter by project'],
        ['issueId', false, 'filter by issue'],
        ['status', false, 'pending | assigned | running | done | failed | cancelled'],
        ['includeArchived', false, ''],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    taskGet: {
      summary: "Fetch one task's details by id.",
      params: [['id', true, 'task id']],
    },
    taskCreate: {
      summary: 'Create a task under an issue — whoever will execute it creates it. With assigneeId→assigned, without→pending.',
      params: [
        ['projectId', true, 'owning project id'],
        ['issueId', true, 'owning issue id'],
        ['title', true, 'task title'],
        ['description', false, 'markdown description'],
        ['assigneeId', false, 'assignee member id (with it → assigned; without → pending)'],
        ['blueprintStepId', false, 'blueprint step this task realizes'],
        ['dependsOn', false, 'array of upstream task ids (use task.id, not step id)'],
      ],
    },
    taskClaim: {
      summary: 'Claim a task to yourself (assign ownership ONLY). Step 1 of 2 — does not start work or open an attempt (see taskStart).',
      params: [['id', true, 'task id (assign to self; no start, no attempt)']],
    },
    taskStart: {
      summary: 'Begin executing a claimed task (assigned→running); opens an attempt and checks dependsOn. Step 2 after taskClaim.',
      params: [['id', true, 'task id (assigned → running, opens attempt, checks dependsOn)']],
    },
    taskTransition: {
      summary: 'Push a task to a terminal state (done/failed/cancelled). All its attempts must be terminal first.',
      params: [
        ['id', true, 'task id'],
        ['status', true, 'target terminal status: done | failed | cancelled (alias: targetStatus)'],
      ],
    },
    taskStatus: {
      summary: 'Legacy alias of taskTransition.',
      params: [
        ['id', true, 'task id'],
        ['status', true, 'alias of taskTransition (alias: targetStatus)'],
      ],
    },
    taskReassign: {
      summary: 'Reassign an already-claimed task to another member (Lead-only).',
      params: [
        ['id', true, 'task id'],
        ['assigneeId', true, 'new assignee member id (alias: newAssigneeId)'],
      ],
    },
    // Comment
    commentCreate: {
      summary: 'Post a markdown comment on an issue or task (workType+workId). Use to state the output location when delivering.',
      params: [
        ['workType', true, '"issue" | "task"'],
        ['workId', true, 'issue/task id the comment attaches to'],
        ['bodyMarkdown', true, 'markdown body (alias: body)'],
      ],
    },
    commentGet: {
      summary: 'Fetch one comment by id.',
      params: [['id', true, 'comment id']],
    },
    commentList: {
      summary: 'List comments on an issue/task (cursor paged).',
      params: [
        ['workType', true, '"issue" | "task"'],
        ['workId', true, 'issue/task id'],
        ['cursor', false, ''], ['limit', false, ''], ['orderBy', false, ''],
      ],
    },
    // Blueprint
    blueprintCreate: {
      summary: 'Create the plan skeleton for an issue (steps[]). Every issue needs one: one step for simple, multi-step w/ dependsOn for complex.',
      params: [
        ['issueId', true, 'owning issue id'],
        ['steps', true, 'array of steps [{temp_id, description, depends_on_temp_ids?}]'],
        ['estimatedBudget', false, ''],
        ['notes', false, ''],
      ],
    },
    blueprintGet: {
      summary: 'Fetch a blueprint (optionally its steps).',
      params: [
        ['id', true, 'blueprint id'],
        ['includeSteps', false, 'include step list'],
      ],
    },
    blueprintList: {
      summary: "List an issue's blueprints.",
      params: [
        ['issueId', true, 'owning issue id'],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    blueprintSetSteps: {
      summary: 'Replace ALL steps of a blueprint (PUT semantics — full replacement, not append).',
      params: [
        ['blueprintId', true, 'blueprint id (alias: id)'],
        ['steps', true, 'full replacement step array (PUT semantics, not append)'],
      ],
    },
    // Attempt
    attemptCreate: {
      summary: 'Manually open a new attempt on a task. Rarely needed — taskStart opens one automatically; use only to start a fresh retry round.',
      params: [['taskId', true, 'task id (usually opened automatically by task.start)']],
    },
    attemptGet: {
      summary: "Fetch one attempt's details (status/startedAt/failureReason).",
      params: [['id', true, 'attempt id']],
    },
    attemptList: {
      summary: "List a task's attempts (each retry / failure reason).",
      params: [
        ['taskId', true, 'task id'],
        ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
      ],
    },
    attemptTransition: {
      summary: 'Generic attempt state-machine step: push an attempt to a target state (done/failed/blocked/cancelled). Worker reports its result — failed needs failureReason; blocked needs approval ids.',
      params: [
        ['id', true, 'attempt id'],
        ['status', true, 'done | failed | blocked | cancelled (alias: targetStatus)'],
        ['failureReason', false, 'required-ish when status=failed'],
        ['blockedOnApprovalRequestIds', false, 'array; when status=blocked'],
      ],
    },
    // Event binding (scheduled tasks)
    eventBindingCreate: {
      summary: 'Create a cron binding that auto-creates an issue when it fires. ownerMemberId must be the human, not yourself.',
      params: [
        ['cronExpr', true, '5-field cron (minute hour day month weekday)'],
        ['leadMemberId', true, 'must be your own member id'],
        ['ownerMemberId', true, 'the conversation human (cannot be yourself)'],
        ['projectId', true, 'owning project id'],
        ['title', true, 'issue title generated when it fires'],
        ['description', false, 'markdown description/context'],
      ],
    },
    eventBindingList: {
      summary: 'List your scheduled event bindings.',
      params: [],
    },
    eventBindingGet: {
      summary: 'Fetch one event binding by id.',
      params: [['id', true, 'event-binding id']],
    },
    eventBindingDelete: {
      summary: 'Delete a scheduled event binding.',
      params: [['id', true, 'event-binding id']],
    },
  },

  kb: {
    init: {
      summary: 'Initialize KB storage for the org (idempotent bootstrap). Rarely needed.',
      params: [],
    },
    list: {
      summary: 'List knowledge bases (paged). Browse before choosing an output KB.',
      params: [['limit', false, ''], ['offset', false, '']],
    },
    create: {
      summary: 'Create a knowledge base (visibility open/closed/private, default closed). Only when the user asks for a new KB.',
      params: [
        ['name', true, 'KB name (slug derived server-side)'],
        ['visibility', false, 'open | closed | private (default closed)'],
        ['description', false, ''],
        ['icon', false, ''],
      ],
    },
    get: {
      summary: "Fetch one KB's details by kbId.",
      params: [['kbId', true, 'KB id']],
    },
    update: {
      summary: 'Edit KB metadata (name/description/visibility/icon). set* flags allow explicitly clearing a field.',
      params: [
        ['kbId', true, 'KB id'],
        ['name', false, ''],
        ['description', false, ''],
        ['setDescription', false, 'tri-state: explicitly clear vs leave untouched'],
        ['visibility', false, ''],
        ['icon', false, ''],
        ['setIcon', false, 'tri-state: explicitly clear vs leave untouched'],
      ],
    },
    delete: {
      summary: 'Permanently delete a KB (hard physical delete). Prefer archive.',
      params: [['kbId', true, 'KB id (permanent physical delete)']],
    },
    archive: {
      summary: 'Archive a KB (reversible).',
      params: [['kbId', true, 'KB id']],
    },
    unarchive: {
      summary: 'Restore an archived KB.',
      params: [['kbId', true, 'KB id']],
    },
    // Tree
    treeRoots: {
      summary: "List a KB's root tree nodes. Entry point for browsing the directory.",
      params: [['kbId', true, 'KB id']],
    },
    folderCreate: {
      summary: "Create a folder node in a KB's tree (omit parentId for root).",
      params: [
        ['kbId', true, 'KB id'],
        ['name', true, 'folder name (alias: title)'],
        ['parentId', false, 'parent node id (omit for root)'],
      ],
    },
    fileCreate: {
      summary: 'Register a file node from an uploaded artifactId (from uploadMedia). Attaches the file into the tree.',
      params: [
        ['kbId', true, 'KB id'],
        ['name', true, 'file node name'],
        ['artifactId', true, 'artifact id from uploadMedia'],
        ['parentId', false, 'parent folder node id'],
      ],
    },
    nodeGet: {
      summary: 'Fetch one tree node by id.',
      params: [['kbId', true, 'KB id'], ['nodeId', true, 'tree node id (tn-...)']],
    },
    nodeBreadcrumb: {
      summary: "Get a node's ancestor path (breadcrumb).",
      params: [['kbId', true, 'KB id'], ['nodeId', true, 'tree node id']],
    },
    nodeChildren: {
      summary: "List a folder node's children. Use to browse into a folder.",
      params: [['kbId', true, 'KB id'], ['parentId', true, 'parent node id (alias: nodeId)']],
    },
    nodeMove: {
      summary: 'Move a node under a new parent folder.',
      params: [
        ['kbId', true, 'KB id'],
        ['nodeId', true, 'node to move'],
        ['parentId', true, 'new parent node id (alias: newParentId)'],
      ],
    },
    nodeRename: {
      summary: 'Rename a tree node.',
      params: [
        ['kbId', true, 'KB id'],
        ['nodeId', true, 'node id'],
        ['name', true, 'new name (alias: title)'],
      ],
    },
    nodeDelete: {
      summary: 'Delete a tree node.',
      params: [['kbId', true, 'KB id'], ['nodeId', true, 'node id']],
    },
    filePreview: {
      summary: 'Get a preview for a file node.',
      params: [['kbId', true, 'KB id'], ['nodeId', true, 'file node id']],
    },
    fileDownload: {
      summary: 'Get a download URL/stream for one file node (inline vs attachment).',
      params: [
        ['kbId', true, 'KB id'],
        ['nodeId', true, 'file node id'],
        ['inline', false, 'inline vs attachment disposition'],
      ],
    },
    fileBatchDownload: {
      summary: 'Get a bundled download for multiple file nodes.',
      params: [
        ['kbId', true, 'KB id'],
        ['nodeIds', true, 'array of file node ids'],
        ['inline', false, ''],
      ],
    },
    // Pages
    pages: {
      summary: 'List pages (cursor/offset paged). No folder filter — use nodeChildren to browse a folder.',
      params: [['cursor', false, ''], ['limit', false, ''], ['offset', false, '']],
    },
    pageCreate: {
      summary: 'Create a KB page with title + body. Distill deliverables here.',
      params: [
        ['kbId', true, 'KB id'],
        ['title', true, 'page title'],
        ['body', true, 'page content (alias: content / content.body). Empty string allowed but pass real content'],
        ['format', false, 'markdown | plain_text (default markdown)'],
        ['parentId', false, 'parent folder node id (alias: parentNodeId)'],
        ['message', false, 'commit message (alias: commitMessage)'],
      ],
    },
    pageGet: {
      summary: "Fetch a page's metadata + current revision pointer (use pageContent for the body text).",
      params: [['pageId', true, 'page id (pg-...)']],
    },
    pageUpdate: {
      summary: 'Update page METADATA only — title/path. Does NOT change the body; use pageContentWrite for content.',
      params: [
        ['pageId', true, 'page id'],
        ['title', false, 'new title'],
        ['path', false, 'new path'],
      ],
    },
    pageDelete: {
      summary: 'Permanently delete a page (must be trashed first via pageTrash).',
      params: [['pageId', true, 'page id (must be trashed first — see pageTrash)']],
    },
    pageContent: {
      summary: "Read a page's current body content.",
      params: [['pageId', true, 'page id']],
    },
    pageContentWrite: {
      summary: "Write/replace a page's BODY content (the actual text). This is the content editor; pageUpdate only touches title/path.",
      params: [
        ['pageId', true, 'page id'],
        ['body', true, 'new body content (alias: content / content.body)'],
        ['message', false, 'commit message (alias: commitMessage)'],
        ['baseRevisionId', false, 'optimistic-concurrency base revision (from pageGet)'],
        ['autoSave', false, 'default false'],
      ],
    },
    pageTrash: {
      summary: 'Soft-delete a page (→trashed); reversible via pageRestoreTrash.',
      params: [['pageId', true, 'page id (soft delete → trashed)']],
    },
    pageRestoreTrash: {
      summary: 'Restore a trashed page to active. NOT a revision rollback (see pageRestore).',
      params: [['pageId', true, 'page id (trashed → active; NOT a revision restore)']],
    },
    pageFreeze: {
      summary: 'Mark a page read-only (frozen).',
      params: [['pageId', true, 'page id (mark read-only)']],
    },
    pageReferences: {
      summary: 'List pages/nodes that reference this page.',
      params: [['pageId', true, 'page id']],
    },
    pagesTrashed: {
      summary: 'List trashed pages.',
      params: [['limit', false, ''], ['offset', false, '']],
    },
    pageRevisions: {
      summary: "List a page's revision history.",
      params: [['pageId', true, 'page id'], ['limit', false, ''], ['offset', false, '']],
    },
    pageRevision: {
      summary: 'Fetch one specific page revision.',
      params: [['pageId', true, 'page id'], ['revisionId', true, 'revision id']],
    },
    pageDiff: {
      summary: 'Diff a page between two revisions.',
      params: [
        ['pageId', true, 'page id'],
        ['fromRevisionId', true, 'from revision (alias: fromRevision)'],
        ['toRevisionId', true, 'to revision (alias: toRevision)'],
      ],
    },
    pageRestore: {
      summary: "Roll a page's content back to an earlier revision. NOT trash restore (see pageRestoreTrash).",
      params: [
        ['pageId', true, 'page id'],
        ['revisionId', true, 'revision to roll content back to (NOT trash restore)'],
      ],
    },
    search: {
      summary: 'Full-text search KB pages (optionally scoped to one kbId).',
      params: [
        ['query', true, 'search text (alias: q)'],
        ['kbId', false, 'restrict to a KB'],
        ['limit', false, ''],
        ['offset', false, ''],
        ['sort', false, ''],
      ],
    },
    upload: {
      summary: 'Upload a local file into a KB (delegates to the artifact store), returning its tree node.',
      params: [
        ['filePath', true, 'local file path to upload'],
        ['parentId', false, 'parent folder node id'],
        ['contentType', false, 'MIME type override'],
        ['filename', false, 'name override'],
      ],
    },
  },

  comm: {
    listConversations: {
      summary: 'List your conversations (cursor paged). Find a conversation to read or reply in.',
      params: [
        ['cursor', false, 'page cursor (alias: pageToken)'],
        ['limit', false, 'page size (alias: pageSize)'],
        ['includeArchived', false, ''],
      ],
    },
    createDm: {
      summary: 'Open (or get) a DM with another member by peerMemberId.',
      params: [['peerMemberId', true, 'other party member id (aliases: participantId, peerId)']],
    },
    createGroup: {
      summary: 'Create a group conversation with a set of members.',
      params: [
        ['name', true, 'group name (alias: title)'],
        ['memberIds', true, 'member id array (alias: participantIds)'],
        ['description', false, ''],
        ['avatarMediaId', false, ''],
        ['metadata', false, ''],
      ],
    },
    getConversation: {
      summary: "Fetch one conversation's metadata.",
      params: [['conversationId', true, 'conversation id']],
    },
    getMessages: {
      summary: "Fetch a conversation's message history (seq-range paged). Pull context before replying.",
      params: [
        ['conversationId', true, 'conversation id'],
        ['afterSeq', false, 'lower bound seq'],
        ['beforeSeq', false, 'upper bound seq'],
        ['limit', false, ''],
      ],
    },
    send: {
      summary: 'Send a message into a conversation (REST). For the reply hot path prefer the comm_send tool.',
      params: [
        ['conversationId', true, 'conversation id'],
        ['content', true, 'string / markdown / {text} / MessageContent[]'],
        ['replyTo', false, 'parent message id'],
        ['clientMsgId', false, '5-min idempotency key (auto cmsg_<uuid> if omitted)'],
      ],
    },
    getMessage: {
      summary: 'Fetch one message by id. Use to read the full message referenced by a wake notice.',
      params: [
        ['conversationId', true, 'conversation id'],
        ['messageId', true, 'message id'],
      ],
    },
    unread: {
      summary: 'Get the unread count/cursor for a conversation.',
      params: [['conversationId', true, 'conversation id']],
    },
    markRead: {
      summary: 'Advance the read cursor to a seq (mark messages read).',
      params: [
        ['conversationId', true, 'conversation id'],
        ['seq', true, 'read cursor seq'],
      ],
    },
    search: {
      summary: "Full-text search KB pages (comm's only search surface; same as kb.search).",
      params: [
        ['query', true, 'KB page search text (alias: q)'],
        ['kbId', false, ''], ['limit', false, ''], ['offset', false, ''], ['sort', false, ''],
      ],
    },
    sync: {
      summary: 'Pull missed events after a WebSocket reconnect (since a known seq).',
      params: [
        ['sinceSeq', true, 'last known seq'],
        ['deviceId', true, 'device id'],
        ['limit', false, ''],
      ],
    },
    syncOwner: {
      summary: "Reconcile the local owner binding with cws-core's authoritative owner. Config-coupled.",
      params: [['org', false, 'org slug / id / name (optional for single-org)']],
    },
    dmPolicy: {
      summary: 'Read or set the DM access policy (open/allowlist/owner). Omit policy to read the current value.',
      params: [
        ['org', false, 'org selector (optional for single-org)'],
        ['policy', false, 'set to open | allowlist | owner; omit to read current'],
      ],
    },
    dmList: {
      summary: 'Show the current DM policy + allowlist.',
      params: [['org', false, 'org selector']],
    },
    dmAllow: {
      summary: 'Add member id(s) to the DM allowlist.',
      params: [
        ['memberIds', true, 'member id or array to allow (alias: memberId)'],
        ['org', false, 'org selector'],
      ],
    },
    dmRevoke: {
      summary: 'Remove member id(s) from the DM allowlist.',
      params: [
        ['memberIds', true, 'member id or array to remove (alias: memberId)'],
        ['org', false, 'org selector'],
      ],
    },
  },

  core: {
    me: {
      summary: 'Get your own identity/member record. Use to learn your own member id.',
      params: [],
    },
    agentDomain: {
      summary: "Resolve this agent's public base URL for webhook-channel URL building.",
      params: [],
    },
    selfRename: {
      summary: 'Change your own display name (identity-wide).',
      params: [['name', true, 'new display name (aliases: displayName, display_name)']],
    },
    memberList: {
      summary: 'List/search members in the org (filter kind human/agent). Find someone\'s member id.',
      params: [
        ['kind', false, 'human | agent | all (alias: type)'],
        ['status', false, ''],
        ['search', false, 'fuzzy match name/email (alias: q)'],
        ['page', false, ''],
        ['pageSize', false, 'items per page (alias: limit)'],
        ['orderBy', false, ''],
      ],
    },
    memberGet: {
      summary: 'Fetch one member by id.',
      params: [['memberId', true, 'member id']],
    },
    projectMembers: {
      summary: 'List members of a project.',
      params: [['projectId', true, 'project id']],
    },
    agentProfiles: {
      summary: 'Get agent capability profiles (skills/tags) for members in a project. Use to pick an executor.',
      params: [
        ['projectId', true, 'project scope (required unless memberIds given; aliases: project_id)'],
        ['memberIds', true, 'member id or array (required unless projectId given; aliases: memberId, member_id)'],
        ['capabilities', false, 'true → include skills[] + tags[] (else lightweight view)'],
        ['include', false, 'array of extra sections to include'],
      ],
    },
    platformAgentCreate: {
      summary: 'Provision a new platform agent member.',
      params: [
        ['displayName', true, 'agent display name (alias: name)'],
        ['description', false, ''],
        ['metadata', false, ''],
      ],
    },
    platformAgentDelete: {
      summary: 'Delete a platform agent member.',
      params: [['memberId', true, 'agent member id']],
    },
    onboardingSession: {
      summary: 'Get the current onboarding session state.',
      params: [],
    },
    onboardingEvent: {
      summary: 'Record an onboarding milestone event (e.g. d1_activation).',
      params: [
        ['eventType', true, 'd1_activation | d3_im_connected (alias: event_type)'],
        ['occurredAt', false, 'timestamp (alias: occurred_at)'],
        ['meta', false, ''],
      ],
    },
    projectList: {
      summary: 'List projects (directory view, default active). Lighter directory read than tm.projectList.',
      params: [
        ['status', false, 'default "active"'],
        ['page', false, ''],
        ['pageSize', false, 'alias: limit'],
        ['orderBy', false, ''],
      ],
    },
    orgList: {
      summary: 'List organizations you belong to.',
      params: [['orderBy', false, '']],
    },
    orgGet: {
      summary: 'Fetch one organization by id.',
      params: [['orgId', true, 'org id']],
    },
    orgCreate: {
      summary: 'Create a new organization.',
      params: [
        ['name', true, 'org name'],
        ['slug', true, 'org slug'],
        ['displayName', true, 'display name (alias: display_name)'],
      ],
    },
    orgSwitch: {
      summary: 'Switch active org; returns a new scoped access_token.',
      params: [['orgId', true, 'target org id (returns a new scoped access_token)']],
    },
    roleList: {
      summary: 'List assignable roles (scope org/project).',
      params: [['scope', false, 'org | project | omitted (all)']],
    },
    invitationCreate: {
      summary: 'Create an invitation for someone to join the org with a role.',
      params: [
        ['roleId', true, 'role id (from roleList)'],
        ['displayName', true, "invitee's member display name in this org (1–200 chars)"],
        ['email', false, ''],
        ['message', false, ''],
      ],
    },
    invitationList: {
      summary: 'List invitations (filter by status).',
      params: [
        ['status', false, 'pending | accepted | revoked | expired'],
        ['page', false, ''], ['pageSize', false, 'alias: limit'], ['orderBy', false, ''],
      ],
    },
    invitationAccept: {
      summary: 'Accept an invitation using its token.',
      params: [
        ['invitationId', true, 'invitation id'],
        ['token', true, 'token from the invitation link'],
      ],
    },
    invitationRevoke: {
      summary: 'Revoke a pending invitation.',
      params: [['invitationId', true, 'invitation id']],
    },
    frontendUrl: {
      summary: 'Build a browser URL for an app path (local helper, no API call).',
      params: [['path', true, 'app-relative path, e.g. "/knowledge?kb=..&node=.." (alias: p)']],
    },
  },

  conn: {
    list: {
      summary: 'List connections available to this agent (defaults to self).',
      params: [['agentMemberId', false, 'defaults to self (alias: agent_member_id)']],
    },
    acquire: {
      summary: 'Acquire a credential for a connection (returns access token in direct mode, or proxy ref in proxy mode).',
      params: [
        ['connectionId', true, 'connection id (alias: connection_id)'],
        ['agentMemberId', false, 'defaults to self'],
      ],
    },
    proxy: {
      summary: 'Make an HTTP request through a connection (proxy-mode credentials — the connection holds the secret).',
      params: [
        ['connectionId', true, 'connection id (alias: connection_id)'],
        ['method', false, 'HTTP method (default GET)'],
        ['url', false, 'target URL'],
        ['headers', false, 'request headers object'],
        ['body', false, 'request body'],
        ['agentMemberId', false, 'defaults to self'],
      ],
    },
    status: {
      summary: "Get a connection's details (status/owner/scopes).",
      params: [['connectionId', true, 'connection id (alias: connection_id)']],
    },
    cached: {
      summary: 'List locally cached credentials (empty if no storage provider).',
      params: [],
    },
    clearCache: {
      summary: 'Clear cached credentials (one connection, or all if connectionId omitted).',
      params: [['connectionId', false, 'clear one connection; omit to clear all (alias: connection_id)']],
    },
  },
};

/**
 * Method-level notes for places where the SDK method's accepted fields differ
 * from what references/*-operations.md documents. Surfaced in the `list` output
 * so the agent trusts the SDK-accurate schema above. Complementary to `summary`
 * (note = caveat/divergence, summary = purpose).
 */
const METHOD_NOTES = {
  kb: {
    pageUpdate: 'SDK sends only title/path. To change body/content use pageContentWrite (the docs also list content/baseRevisionId here, but this method does not forward them).',
    pages: 'SDK forwards only cursor/limit/offset (no parentId/kbId filter, despite the docs). Use nodeChildren to browse a folder.',
    search: 'SDK forwards only query/kbId/limit/offset/sort. folderId/authorId/format/pageSize/pageToken/sync from the docs are NOT wired here.',
  },
};

/** Extract the [name, required, description] tuples from a spec entry. */
function specParams(spec) {
  return (spec && spec.params) || [];
}

/** Build `[name, required, description]` tuples into schema objects. */
function paramObjects(tuples) {
  return (tuples || []).map(([name, required, description]) => ({ name, required, description }));
}

/**
 * Compact signature string, optionally suffixed with a few-word purpose gloss,
 * e.g. `projectCreate(name*, leadMemberId*, slug?) — new project`.
 */
function signature(method, tuples, gloss) {
  const parts = (tuples || []).map(([name, required]) => `${name}${required ? '*' : '?'}`);
  const sig = `${method}(${parts.join(', ')})`;
  return gloss ? `${sig} — ${gloss}` : sig;
}

/** Methods whose signature is inlined into the dispatch tool's description. */
const HIGHLIGHTS = {
  tm: ['projectList', 'projectCreate', 'issueList', 'issueListInProject', 'issueGet', 'issueCreate',
    'issueSubmitPlan', 'issueAcceptPlan', 'issueDeliver', 'issueAcceptDelivered',
    'taskList', 'taskCreate', 'taskClaim', 'taskStart', 'taskTransition',
    'commentCreate', 'blueprintCreate', 'attemptTransition'],
  kb: ['list', 'create', 'treeRoots', 'folderCreate', 'pages', 'pageCreate', 'pageGet',
    'pageContent', 'pageContentWrite', 'search', 'upload'],
  comm: ['listConversations', 'createDm', 'getMessages', 'getMessage', 'send'],
  core: ['me', 'memberList', 'agentProfiles', 'projectList', 'selfRename', 'orgList'],
  conn: ['list', 'acquire', 'proxy', 'status'],
};

/**
 * Few-word PURPOSE gloss for each HIGHLIGHT verb — just enough to name the
 * action's intent in the static tool description (progressive disclosure keeps
 * the full one-line `summary` in the `list` output, so this stays terse and
 * the static-context cost is bounded to the highlight set, not all ~80 verbs).
 */
const HIGHLIGHT_GLOSSES = {
  tm: {
    projectList: 'browse projects',
    projectCreate: 'new project (explicit only)',
    issueList: 'browse all issues',
    issueListInProject: 'issues in one project',
    issueGet: 'read one issue',
    issueCreate: 'create issue w/ owner=acceptor',
    issueSubmitPlan: 'submit plan (needs blueprint)',
    issueAcceptPlan: 'owner accepts plan',
    issueDeliver: 'in_progress→delivered',
    issueAcceptDelivered: 'owner accepts delivery',
    taskList: 'browse tasks',
    taskCreate: 'create task under issue',
    taskClaim: 'claim ownership (not start)',
    taskStart: 'begin work, opens attempt',
    taskTransition: 'task→terminal state',
    commentCreate: 'comment on issue/task',
    blueprintCreate: 'create plan skeleton',
    attemptTransition: 'generic state-machine transition',
  },
  kb: {
    list: 'browse KBs',
    create: 'new KB (explicit only)',
    treeRoots: 'KB root nodes',
    folderCreate: 'new folder node',
    pages: 'list pages',
    pageCreate: 'new page',
    pageGet: 'page metadata',
    pageContent: 'read page body',
    pageContentWrite: 'write page body',
    search: 'full-text page search',
    upload: 'upload file to KB',
  },
  comm: {
    listConversations: 'browse conversations',
    createDm: 'open a DM',
    getMessages: 'history for context',
    getMessage: 'read one message',
    send: 'send msg (prefer comm_send)',
  },
  core: {
    me: 'your own identity',
    memberList: 'find member ids',
    agentProfiles: 'agent skills/capabilities',
    projectList: 'browse projects',
    selfRename: 'rename yourself',
    orgList: 'list your orgs',
  },
  conn: {
    list: 'list connections',
    acquire: 'get credential',
    proxy: 'request via connection',
    status: 'connection details',
  },
};

/** Build the description string for a dispatch tool (prose + glossed signatures). */
function describeService(key) {
  const base = SERVICE_DESCRIPTIONS[key]
    + ' Call with {"method":"<verb>","params":{...}}. Use {"method":"list"} for the FULL per-method purpose + field schema.';
  const specs = METHOD_SPECS[key];
  const highlights = HIGHLIGHTS[key];
  if (!specs || !highlights || !highlights.length) return base;
  const glosses = HIGHLIGHT_GLOSSES[key] || {};
  const sigs = highlights
    .filter((m) => specs[m])
    .map((m) => signature(m, specParams(specs[m]), glosses[m]))
    .join('; ');
  return `${base}\nCommon methods (\`*\`=required, \`?\`=optional; \`— gloss\` names each verb's purpose; see "list" for the rest + full summaries): ${sigs}`;
}

/** Callable (public, function-valued) method names on a service instance. */
function methodNames(service) {
  const names = new Set();
  // Walk the instance itself (plain-object services) AND its prototype chain
  // (class instances put methods on the prototype, non-enumerable).
  let obj = service;
  while (obj && obj !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(obj)) {
      if (n === 'constructor' || n.startsWith('_')) continue;
      if (typeof service[n] === 'function') names.add(n);
    }
    obj = Object.getPrototypeOf(obj);
  }
  return [...names].sort();
}

/**
 * Rich `list` output: for every callable method, `{name, summary?, params[], note?}`.
 * `summary` is the one-line purpose (present for every spec'd method); `params`
 * is derived from METHOD_SPECS (empty array when we have no spec, so the agent
 * still learns the method exists and takes no/unknown fields).
 */
function listMethods(serviceKey, service) {
  const specs = METHOD_SPECS[serviceKey] || {};
  const notes = METHOD_NOTES[serviceKey] || {};
  return methodNames(service).map((name) => {
    const spec = specs[name];
    const entry = { name };
    if (spec && spec.summary) entry.summary = spec.summary;
    entry.params = paramObjects(specParams(spec));
    if (notes[name]) entry.note = notes[name];
    return entry;
  });
}

function okResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] };
}
function errResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * @param {object} opts
 * @param {{tm,kb,as,comm,core,conn}} opts.services  SDK service client instances
 * @param {import('@openmaxai/openmax-agent-sdk').CwsAgentBridge} [opts.bridge]  for comm_send endpoint parsing
 * @param {string} [opts.defaultOrgId]
 * @param {object} [opts.logger]
 * @returns {{defs: object[], handler: (name:string, args:object)=>Promise<object>}}
 */
export function createMcpTools({ services, bridge, defaultOrgId, logger } = {}) {
  if (!services) throw new Error('createMcpTools requires services');

  const defs = [];
  for (const key of SERVICE_KEYS) {
    if (!services[key]) continue;
    defs.push({
      name: key,
      description: describeService(key),
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'camelCase service method, or "list" to enumerate methods + their purpose/field schemas' },
          params: { type: 'object', description: 'arguments object for the method (see the method schema from "list")' },
        },
        required: ['method'],
      },
    });
  }

  // Dedicated outbound-reply convenience tool (design names it explicitly).
  defs.push({
    name: 'comm_send',
    description: 'Reply to / send a message into a conversation. Provide the `endpoint` from the wake notice '
      + '(or a bare conversation id), the `content` text, and optionally `replyTo` (parent message id) and `orgId`.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'conversation routing endpoint (conversationId[|reply:..][|thread:..])' },
        content: { type: 'string', description: 'message text (markdown auto-detected)' },
        replyTo: { type: 'string', description: 'parent message id to reply to (optional)' },
        orgId: { type: 'string', description: 'org to send as (optional; defaults to the single/default org)' },
      },
      required: ['endpoint', 'content'],
    },
  });

  const handler = async (name, args) => {
    try {
      if (name === 'comm_send') {
        const { endpoint, content, replyTo, orgId } = args;
        if (!endpoint || !content) return errResult('comm_send requires endpoint and content');
        if (!bridge) return errResult('comm_send unavailable: no bridge wired');
        const res = await bridge.send(endpoint, content, {
          orgId: orgId || defaultOrgId,
          replyTo,
        });
        return okResult(res);
      }

      if (SERVICE_KEYS.includes(name)) {
        const service = services[name];
        if (!service) return errResult(`service "${name}" not available`);
        const method = args.method;
        if (!method) return errResult(`${name}: "method" is required`);
        if (method === 'list') return okResult({ service: name, methods: listMethods(name, service) });
        if (typeof service[method] !== 'function' || method.startsWith('_')) {
          return errResult(`${name}: unknown method "${method}". Call {"method":"list"} to see available verbs and their fields.`);
        }
        const result = await service[method](args.params || {});
        return okResult(result);
      }

      return errResult(`unknown tool: ${name}`);
    } catch (e) {
      logger?.warn?.(`tool ${name} failed: ${e.message}`);
      return errResult(e.message || String(e));
    }
  };

  return { defs, handler };
}
