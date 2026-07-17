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
 * A `list` meta-method on each dispatch tool returns that service's callable
 * method names, so the agent can discover the surface at runtime.
 */

const SERVICE_KEYS = ['tm', 'kb', 'as', 'comm', 'core', 'conn'];

const SERVICE_DESCRIPTIONS = {
  tm: 'Task management: projects, issues, tasks, blueprints (cws-work via cws-core). method = a camelCase verb like projectList, issueCreate, taskCreate.',
  kb: 'Knowledge base: KB collections, tree nodes, pages, search, upload. method = a camelCase verb like list, search, pageCreate, fileCreate.',
  as: 'Artifact store: upload/download media, resolve artifact:// URIs, presigned URLs. method = a camelCase verb like uploadMedia, getMediaUrl, downloadMedia.',
  comm: 'Communication: conversations, messages, history, mark-read, sync, DM access control. method = a camelCase verb like getMessages, getMessage, send, listConversations. Prefer the comm_send tool for replies.',
  core: 'Directory/identity: me, member/org listing, agent profiles, self rename. method = a camelCase verb like me, memberList, orgList, selfRename.',
  conn: 'Connection credentials: list/acquire/proxy connection credentials. method = a camelCase verb like list, acquire, proxy, status.',
};

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
      description: SERVICE_DESCRIPTIONS[key]
        + ' Call with {"method":"<verb>","params":{...}}. Use {"method":"list"} to list available verbs.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'camelCase service method, or "list" to enumerate' },
          params: { type: 'object', description: 'arguments object for the method' },
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
        if (method === 'list') return okResult({ service: name, methods: methodNames(service) });
        if (typeof service[method] !== 'function' || method.startsWith('_')) {
          return errResult(`${name}: unknown method "${method}". Call {"method":"list"} to see available verbs.`);
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
