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
 * Field discovery (so the agent stops guessing param names and mis-reading a
 * cws-core validation error as a permission error): each dispatch tool's
 * `description` carries a compact signature reference for the high-frequency
 * methods (`projectCreate(name*, slug?, ...)`, `*` = required), and the
 * `{method:"list"}` meta-method returns the FULL per-method schema
 * (`{name, params:[{name, required, description}], note?}`) derived from the
 * cws-core operations references, so the agent can pull an exact field list at
 * runtime for any method — not just the high-frequency ones.
 *
 * Ground truth: param NAMES come from the SDK service source
 * (cws-agent-sdk/src/services/*.js); required-ness / semantics come from
 * zylos-openmax/references/*-operations.md. Where the two disagree, the SDK
 * name wins and the divergence is called out in the method `note`.
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
 * Per-method field schema, keyed by service then method.
 * Each param is a compact tuple: [name, required(boolean), description].
 *
 * Param NAMES mirror the SDK service source exactly; required-ness reflects
 * what cws-core actually validates (per references/*-operations.md). When a
 * field is genuinely unclear it is marked optional. `METHOD_NOTES` below flags
 * places where the SDK method accepts fewer/other fields than the docs imply.
 */
const METHOD_SPECS = {
  tm: {
    // Project
    projectList: [
      ['status', false, 'filter: "active" | "archived"'],
      ['query', false, 'search over name/description'],
      ['page', false, 'page number (offset paging)'],
      ['pageSize', false, 'items per page'],
      ['orderBy', false, 'sort key'],
    ],
    projectCreate: [
      ['name', true, 'project name'],
      ['leadMemberId', true, 'lead member id (cws-core requires it)'],
      ['description', false, 'markdown description'],
      ['slug', false, 'url slug (server derives one if omitted)'],
      ['isDefault', false, 'mark as the default/Inbox project'],
      ['knowledgeBaseId', false, 'associated KnowledgeBase id'],
      ['memberIds', false, 'array of member ids to add'],
    ],
    projectGet: [['id', true, 'project id']],
    projectUpdate: [
      ['id', true, 'project id'],
      ['name', false, 'new name'],
      ['description', false, 'new description'],
      ['leadMemberId', false, 'new lead member id'],
    ],
    projectArchive: [['id', true, 'project id (frontend "delete" maps here; no hard delete)']],
    projectMembers: [
      ['id', true, 'project id'],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    projectMemberAdd: [
      ['id', true, 'project id'],
      ['memberId', true, 'member id to add'],
      ['role', false, 'role (default "member")'],
    ],
    projectMemberRemove: [
      ['id', true, 'project id'],
      ['memberId', true, 'member id to remove'],
    ],
    // Issue
    issueList: [
      ['status', false, 'single status filter'],
      ['statuses', false, 'array of statuses'],
      ['priority', false, 'low | medium | high'],
      ['includeArchived', false, 'include archived issues'],
      ['query', false, 'search text'],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    issueListInProject: [
      ['projectId', true, 'project id'],
      ['status', false, ''], ['statuses', false, ''], ['priority', false, ''],
      ['includeArchived', false, ''], ['query', false, ''],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    issueGet: [['id', true, 'issue id']],
    issueCreate: [
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
    issueUpdate: [
      ['id', true, 'issue id'],
      ['title', false, ''], ['description', false, ''], ['priority', false, ''],
    ],
    issueActivate: [
      ['id', true, 'issue id'],
      ['source', false, 'default "lead_chat"'],
    ],
    issueSubmitPlan: [
      ['id', true, 'issue id'],
      ['blueprintId', true, 'blueprint id backing the plan (required by the new flow)'],
      ['planText', false, 'human-readable markdown plan (alias: plan)'],
      ['source', false, 'default "lead_chat"'],
      ['cardMessageId', false, 'text-card message id'],
    ],
    issueAcceptPlan: [
      ['id', true, 'issue id'],
      ['source', false, 'im | explicit | text_card_proxy (default text_card_proxy)'],
    ],
    issueDeliver: [['id', true, 'issue id (in_progress → delivered)']],
    issueResume: [
      ['id', true, 'issue id'],
      ['reason', false, 'why resuming (alias: feedback)'],
      ['source', false, 'default "lead_chat"'],
    ],
    issueAcceptDelivered: [
      ['id', true, 'issue id'],
      ['source', false, 'im | explicit | text_card_proxy (default text_card_proxy)'],
    ],
    issueReassignOwner: [
      ['id', true, 'issue id'],
      ['ownerMemberId', true, 'new owner member id (alias: newOwnerMemberId)'],
    ],
    issueMoveProject: [
      ['id', true, 'issue id'],
      ['targetProjectId', true, 'destination project id (alias: newProjectId)'],
    ],
    issueTerminate: [
      ['id', true, 'issue id'],
      ['reason', false, 'termination reason'],
      ['source', false, 'default "lead_chat"'],
    ],
    // Task
    taskList: [
      ['projectId', false, 'filter by project'],
      ['issueId', false, 'filter by issue'],
      ['status', false, 'pending | assigned | running | done | failed | cancelled'],
      ['includeArchived', false, ''],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    taskGet: [['id', true, 'task id']],
    taskCreate: [
      ['projectId', true, 'owning project id'],
      ['issueId', true, 'owning issue id'],
      ['title', true, 'task title'],
      ['description', false, 'markdown description'],
      ['assigneeId', false, 'assignee member id (with it → assigned; without → pending)'],
      ['blueprintStepId', false, 'blueprint step this task realizes'],
      ['dependsOn', false, 'array of upstream task ids (use task.id, not step id)'],
    ],
    taskClaim: [['id', true, 'task id (assign to self; no start, no attempt)']],
    taskStart: [['id', true, 'task id (assigned → running, opens attempt, checks dependsOn)']],
    taskTransition: [
      ['id', true, 'task id'],
      ['status', true, 'target terminal status: done | failed | cancelled (alias: targetStatus)'],
    ],
    taskStatus: [
      ['id', true, 'task id'],
      ['status', true, 'alias of taskTransition (alias: targetStatus)'],
    ],
    taskReassign: [
      ['id', true, 'task id'],
      ['assigneeId', true, 'new assignee member id (alias: newAssigneeId)'],
    ],
    // Comment
    commentCreate: [
      ['workType', true, '"issue" | "task"'],
      ['workId', true, 'issue/task id the comment attaches to'],
      ['bodyMarkdown', true, 'markdown body (alias: body)'],
    ],
    commentGet: [['id', true, 'comment id']],
    commentList: [
      ['workType', true, '"issue" | "task"'],
      ['workId', true, 'issue/task id'],
      ['cursor', false, ''], ['limit', false, ''], ['orderBy', false, ''],
    ],
    // Blueprint
    blueprintCreate: [
      ['issueId', true, 'owning issue id'],
      ['steps', true, 'array of steps [{temp_id, description, depends_on_temp_ids?}]'],
      ['estimatedBudget', false, ''],
      ['notes', false, ''],
    ],
    blueprintGet: [
      ['id', true, 'blueprint id'],
      ['includeSteps', false, 'include step list'],
    ],
    blueprintList: [
      ['issueId', true, 'owning issue id'],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    blueprintSetSteps: [
      ['blueprintId', true, 'blueprint id (alias: id)'],
      ['steps', true, 'full replacement step array (PUT semantics, not append)'],
    ],
    // Attempt
    attemptCreate: [['taskId', true, 'task id (usually opened automatically by task.start)']],
    attemptGet: [['id', true, 'attempt id']],
    attemptList: [
      ['taskId', true, 'task id'],
      ['page', false, ''], ['pageSize', false, ''], ['orderBy', false, ''],
    ],
    attemptTransition: [
      ['id', true, 'attempt id'],
      ['status', true, 'done | failed | blocked | cancelled (alias: targetStatus)'],
      ['failureReason', false, 'required-ish when status=failed'],
      ['blockedOnApprovalRequestIds', false, 'array; when status=blocked'],
    ],
    // Event binding (scheduled tasks)
    eventBindingCreate: [
      ['cronExpr', true, '5-field cron (minute hour day month weekday)'],
      ['leadMemberId', true, 'must be your own member id'],
      ['ownerMemberId', true, 'the conversation human (cannot be yourself)'],
      ['projectId', true, 'owning project id'],
      ['title', true, 'issue title generated when it fires'],
      ['description', false, 'markdown description/context'],
    ],
    eventBindingList: [],
    eventBindingGet: [['id', true, 'event-binding id']],
    eventBindingDelete: [['id', true, 'event-binding id']],
  },

  kb: {
    init: [],
    list: [['limit', false, ''], ['offset', false, '']],
    create: [
      ['name', true, 'KB name (slug derived server-side)'],
      ['visibility', false, 'open | closed | private (default closed)'],
      ['description', false, ''],
      ['icon', false, ''],
    ],
    get: [['kbId', true, 'KB id']],
    update: [
      ['kbId', true, 'KB id'],
      ['name', false, ''],
      ['description', false, ''],
      ['setDescription', false, 'tri-state: explicitly clear vs leave untouched'],
      ['visibility', false, ''],
      ['icon', false, ''],
      ['setIcon', false, 'tri-state: explicitly clear vs leave untouched'],
    ],
    delete: [['kbId', true, 'KB id (permanent physical delete)']],
    archive: [['kbId', true, 'KB id']],
    unarchive: [['kbId', true, 'KB id']],
    // Tree
    treeRoots: [['kbId', true, 'KB id']],
    folderCreate: [
      ['kbId', true, 'KB id'],
      ['name', true, 'folder name (alias: title)'],
      ['parentId', false, 'parent node id (omit for root)'],
    ],
    fileCreate: [
      ['kbId', true, 'KB id'],
      ['name', true, 'file node name'],
      ['artifactId', true, 'artifact id from uploadMedia'],
      ['parentId', false, 'parent folder node id'],
    ],
    nodeGet: [['kbId', true, 'KB id'], ['nodeId', true, 'tree node id (tn-...)']],
    nodeBreadcrumb: [['kbId', true, 'KB id'], ['nodeId', true, 'tree node id']],
    nodeChildren: [['kbId', true, 'KB id'], ['parentId', true, 'parent node id (alias: nodeId)']],
    nodeMove: [
      ['kbId', true, 'KB id'],
      ['nodeId', true, 'node to move'],
      ['parentId', true, 'new parent node id (alias: newParentId)'],
    ],
    nodeRename: [
      ['kbId', true, 'KB id'],
      ['nodeId', true, 'node id'],
      ['name', true, 'new name (alias: title)'],
    ],
    nodeDelete: [['kbId', true, 'KB id'], ['nodeId', true, 'node id']],
    filePreview: [['kbId', true, 'KB id'], ['nodeId', true, 'file node id']],
    fileDownload: [
      ['kbId', true, 'KB id'],
      ['nodeId', true, 'file node id'],
      ['inline', false, 'inline vs attachment disposition'],
    ],
    fileBatchDownload: [
      ['kbId', true, 'KB id'],
      ['nodeIds', true, 'array of file node ids'],
      ['inline', false, ''],
    ],
    // Pages
    pages: [['cursor', false, ''], ['limit', false, ''], ['offset', false, '']],
    pageCreate: [
      ['kbId', true, 'KB id'],
      ['title', true, 'page title'],
      ['body', true, 'page content (alias: content / content.body). Empty string allowed but pass real content'],
      ['format', false, 'markdown | plain_text (default markdown)'],
      ['parentId', false, 'parent folder node id (alias: parentNodeId)'],
      ['message', false, 'commit message (alias: commitMessage)'],
    ],
    pageGet: [['pageId', true, 'page id (pg-...)']],
    pageUpdate: [
      ['pageId', true, 'page id'],
      ['title', false, 'new title'],
      ['path', false, 'new path'],
    ],
    pageDelete: [['pageId', true, 'page id (must be trashed first — see pageTrash)']],
    pageContent: [['pageId', true, 'page id']],
    pageContentWrite: [
      ['pageId', true, 'page id'],
      ['body', true, 'new body content (alias: content / content.body)'],
      ['message', false, 'commit message (alias: commitMessage)'],
      ['baseRevisionId', false, 'optimistic-concurrency base revision (from pageGet)'],
      ['autoSave', false, 'default false'],
    ],
    pageTrash: [['pageId', true, 'page id (soft delete → trashed)']],
    pageRestoreTrash: [['pageId', true, 'page id (trashed → active; NOT a revision restore)']],
    pageFreeze: [['pageId', true, 'page id (mark read-only)']],
    pageReferences: [['pageId', true, 'page id']],
    pagesTrashed: [['limit', false, ''], ['offset', false, '']],
    pageRevisions: [['pageId', true, 'page id'], ['limit', false, ''], ['offset', false, '']],
    pageRevision: [['pageId', true, 'page id'], ['revisionId', true, 'revision id']],
    pageDiff: [
      ['pageId', true, 'page id'],
      ['fromRevisionId', true, 'from revision (alias: fromRevision)'],
      ['toRevisionId', true, 'to revision (alias: toRevision)'],
    ],
    pageRestore: [
      ['pageId', true, 'page id'],
      ['revisionId', true, 'revision to roll content back to (NOT trash restore)'],
    ],
    search: [
      ['query', true, 'search text (alias: q)'],
      ['kbId', false, 'restrict to a KB'],
      ['limit', false, ''],
      ['offset', false, ''],
      ['sort', false, ''],
    ],
    upload: [
      ['filePath', true, 'local file path to upload'],
      ['parentId', false, 'parent folder node id'],
      ['contentType', false, 'MIME type override'],
      ['filename', false, 'name override'],
    ],
  },

  comm: {
    listConversations: [
      ['cursor', false, 'page cursor (alias: pageToken)'],
      ['limit', false, 'page size (alias: pageSize)'],
      ['includeArchived', false, ''],
    ],
    createDm: [['peerMemberId', true, 'other party member id (aliases: participantId, peerId)']],
    createGroup: [
      ['name', true, 'group name (alias: title)'],
      ['memberIds', true, 'member id array (alias: participantIds)'],
      ['description', false, ''],
      ['avatarMediaId', false, ''],
      ['metadata', false, ''],
    ],
    getConversation: [['conversationId', true, 'conversation id']],
    getMessages: [
      ['conversationId', true, 'conversation id'],
      ['afterSeq', false, 'lower bound seq'],
      ['beforeSeq', false, 'upper bound seq'],
      ['limit', false, ''],
    ],
    send: [
      ['conversationId', true, 'conversation id'],
      ['content', true, 'string / markdown / {text} / MessageContent[]'],
      ['replyTo', false, 'parent message id'],
      ['clientMsgId', false, '5-min idempotency key (auto cmsg_<uuid> if omitted)'],
    ],
    getMessage: [
      ['conversationId', true, 'conversation id'],
      ['messageId', true, 'message id'],
    ],
    unread: [['conversationId', true, 'conversation id']],
    markRead: [
      ['conversationId', true, 'conversation id'],
      ['seq', true, 'read cursor seq'],
    ],
    search: [
      ['query', true, 'KB page search text (alias: q)'],
      ['kbId', false, ''], ['limit', false, ''], ['offset', false, ''], ['sort', false, ''],
    ],
    sync: [
      ['sinceSeq', true, 'last known seq'],
      ['deviceId', true, 'device id'],
      ['limit', false, ''],
    ],
    syncOwner: [['org', false, 'org slug / id / name (optional for single-org)']],
    dmPolicy: [
      ['org', false, 'org selector (optional for single-org)'],
      ['policy', false, 'set to open | allowlist | owner; omit to read current'],
    ],
    dmList: [['org', false, 'org selector']],
    dmAllow: [
      ['memberIds', true, 'member id or array to allow (alias: memberId)'],
      ['org', false, 'org selector'],
    ],
    dmRevoke: [
      ['memberIds', true, 'member id or array to remove (alias: memberId)'],
      ['org', false, 'org selector'],
    ],
  },

  core: {
    me: [],
    agentDomain: [],
    selfRename: [['name', true, 'new display name (aliases: displayName, display_name)']],
    memberList: [
      ['kind', false, 'human | agent | all (alias: type)'],
      ['status', false, ''],
      ['search', false, 'fuzzy match name/email (alias: q)'],
      ['page', false, ''],
      ['pageSize', false, 'items per page (alias: limit)'],
      ['orderBy', false, ''],
    ],
    memberGet: [['memberId', true, 'member id']],
    projectMembers: [['projectId', true, 'project id']],
    agentProfiles: [
      ['projectId', true, 'project scope (required unless memberIds given; aliases: project_id)'],
      ['memberIds', true, 'member id or array (required unless projectId given; aliases: memberId, member_id)'],
      ['capabilities', false, 'true → include skills[] + tags[] (else lightweight view)'],
      ['include', false, 'array of extra sections to include'],
    ],
    platformAgentCreate: [
      ['displayName', true, 'agent display name (alias: name)'],
      ['description', false, ''],
      ['metadata', false, ''],
    ],
    platformAgentDelete: [['memberId', true, 'agent member id']],
    onboardingSession: [],
    onboardingEvent: [
      ['eventType', true, 'd1_activation | d3_im_connected (alias: event_type)'],
      ['occurredAt', false, 'timestamp (alias: occurred_at)'],
      ['meta', false, ''],
    ],
    projectList: [
      ['status', false, 'default "active"'],
      ['page', false, ''],
      ['pageSize', false, 'alias: limit'],
      ['orderBy', false, ''],
    ],
    orgList: [['orderBy', false, '']],
    orgGet: [['orgId', true, 'org id']],
    orgCreate: [
      ['name', true, 'org name'],
      ['slug', true, 'org slug'],
      ['displayName', true, 'display name (alias: display_name)'],
    ],
    orgSwitch: [['orgId', true, 'target org id (returns a new scoped access_token)']],
    roleList: [['scope', false, 'org | project | omitted (all)']],
    invitationCreate: [
      ['roleId', true, 'role id (from roleList)'],
      ['displayName', true, "invitee's member display name in this org (1–200 chars)"],
      ['email', false, ''],
      ['message', false, ''],
    ],
    invitationList: [
      ['status', false, 'pending | accepted | revoked | expired'],
      ['page', false, ''], ['pageSize', false, 'alias: limit'], ['orderBy', false, ''],
    ],
    invitationAccept: [
      ['invitationId', true, 'invitation id'],
      ['token', true, 'token from the invitation link'],
    ],
    invitationRevoke: [['invitationId', true, 'invitation id']],
    frontendUrl: [['path', true, 'app-relative path, e.g. "/knowledge?kb=..&node=.." (alias: p)']],
  },

  conn: {
    list: [['agentMemberId', false, 'defaults to self (alias: agent_member_id)']],
    acquire: [
      ['connectionId', true, 'connection id (alias: connection_id)'],
      ['agentMemberId', false, 'defaults to self'],
    ],
    proxy: [
      ['connectionId', true, 'connection id (alias: connection_id)'],
      ['method', false, 'HTTP method (default GET)'],
      ['url', false, 'target URL'],
      ['headers', false, 'request headers object'],
      ['body', false, 'request body'],
      ['agentMemberId', false, 'defaults to self'],
    ],
    status: [['connectionId', true, 'connection id (alias: connection_id)']],
    cached: [],
    clearCache: [['connectionId', false, 'clear one connection; omit to clear all (alias: connection_id)']],
  },
};

/**
 * Method-level notes for places where the SDK method's accepted fields differ
 * from what references/*-operations.md documents. Surfaced in the `list` output
 * so the agent trusts the SDK-accurate schema above.
 */
const METHOD_NOTES = {
  kb: {
    pageUpdate: 'SDK sends only title/path. To change body/content use pageContentWrite (the docs also list content/baseRevisionId here, but this method does not forward them).',
    pages: 'SDK forwards only cursor/limit/offset (no parentId/kbId filter, despite the docs). Use nodeChildren to browse a folder.',
    search: 'SDK forwards only query/kbId/limit/offset/sort. folderId/authorId/format/pageSize/pageToken/sync from the docs are NOT wired here.',
  },
};

/** Build `[name, required, description]` tuples into schema objects. */
function paramObjects(tuples) {
  return (tuples || []).map(([name, required, description]) => ({ name, required, description }));
}

/** Compact signature string, e.g. `projectCreate(name*, leadMemberId*, slug?)`. */
function signature(method, tuples) {
  const parts = (tuples || []).map(([name, required]) => `${name}${required ? '*' : '?'}`);
  return `${method}(${parts.join(', ')})`;
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

/** Build the description string for a dispatch tool (prose + inlined signatures). */
function describeService(key) {
  const base = SERVICE_DESCRIPTIONS[key]
    + ' Call with {"method":"<verb>","params":{...}}. Use {"method":"list"} for the FULL per-method field schema.';
  const specs = METHOD_SPECS[key];
  const highlights = HIGHLIGHTS[key];
  if (!specs || !highlights || !highlights.length) return base;
  const sigs = highlights
    .filter((m) => specs[m])
    .map((m) => signature(m, specs[m]))
    .join('; ');
  return `${base}\nCommon methods (\`*\`=required, \`?\`=optional; see "list" for the rest): ${sigs}`;
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
 * Rich `list` output: for every callable method, `{name, params[], note?}`.
 * `params` is derived from METHOD_SPECS (empty array when we have no spec, so
 * the agent still learns the method exists and takes no/unknown fields).
 */
function listMethods(serviceKey, service) {
  const specs = METHOD_SPECS[serviceKey] || {};
  const notes = METHOD_NOTES[serviceKey] || {};
  return methodNames(service).map((name) => {
    const entry = { name, params: paramObjects(specs[name]) };
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
          method: { type: 'string', description: 'camelCase service method, or "list" to enumerate methods + their field schemas' },
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
