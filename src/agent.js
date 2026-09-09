import { createDeepAgent, StateBackend } from 'deepagents';
import { createMiddleware, countTokensApproximately } from 'langchain';
import { initChatModel } from 'langchain/chat_models/universal';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import {
  createWorktree,
  createWorktreeBackend,
  removeWorktree,
  worktreeChanges,
  worktreeDiff,
  worktreeFileContent,
  workspaceRootFor,
} from './worktree.js';
import {
  COLLECTIVE_ROLE_NAMES,
  COLLECTIVE_ROLE_SPECS,
  extractObjections,
} from './collective.js';

// Module-level memory: a model that refused sampling parameters once is not
// asked again during this process lifetime — one wasted call per model, not
// per run. Provider-driven, no hardcoded model list.
const samplingRefusedByModel = new Set();

// One checkpointer per process, on the gateway's writable config dir (the
// compose stack mounts .agents-data/gateway there). Threads are keyed by
// WORKSPACE: every run of a workspace resumes the same thread, so the Deep
// Agent keeps its conversation memory across runs and across gateway
// restarts. A run whose request carries no workspace lands on 'default'.
let sharedCheckpointer = null;
function gatewayCheckpointer() {
  if (sharedCheckpointer) return sharedCheckpointer;
  const dir = process.env.GATEWAY_CONFIG_DIR ?? process.cwd();
  sharedCheckpointer = SqliteSaver.fromConnString(join(dir, 'memory.sqlite'));
  return sharedCheckpointer;
}

// ── The frontier ──────────────────────────────────────────────────────────────
//
// deepagents 1.13.2 attaches its own tools UNDER whatever we declare: the
// filesystem set (ls, read_file, write_file, edit_file, delete, glob, grep,
// execute) and a generic `task` subagent. They operate on the in-memory
// StateBackend today, so nothing on the workspace is reachable through them —
// but the model is TOLD it can write, edit and delete, it tries, it narrates
// it, and every turn pays those tool definitions in tokens. The boundary
// below makes the VISIBLE tool set exactly what the run declared, and refuses
// at execution any call that sneaks through. The contract test in
// frontier.test.js pins the visible set, so a future deepagents default
// announces itself instead of reopening the gap silently.
export const GATEWAY_BUILTIN_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
  'execute',
  'task',
];

// The hands a worktree run MAY declare: the filesystem set, minus `execute`
// (no shell) — and `task` stays absent (see the collective note below).
export const GATEWAY_WORKTREE_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
];

// Ceilings that did not exist: today only a 600s task timeout bounds a run.
// recursionLimit caps graph steps; the token budget is estimated before each
// model call (same counter the harness itself uses) and stops the run before
// the NEXT call, so a single huge call may overshoot but the loop cannot run
// away.
const GATEWAY_RECURSION_LIMIT =
  Number.parseInt(process.env.GATEWAY_RECURSION_LIMIT ?? '', 10) || 40;
const GATEWAY_TOKEN_BUDGET =
  Number.parseInt(process.env.GATEWAY_TOKEN_BUDGET ?? '', 10) || 500_000;

export function createGatewayBoundaryMiddleware({
  allowedToolNames = [],
  tokenBudget = GATEWAY_TOKEN_BUDGET,
  onModelCall = null,
} = {}) {
  const allowed = new Set(allowedToolNames.map(String));
  let tokensUsed = 0;
  return createMiddleware({
    name: 'GatewayToolBoundary',
    async wrapModelCall(request, handler) {
      const tools = Array.isArray(request.tools)
        ? request.tools.filter((entry) => allowed.has(String(entry?.name ?? '')))
        : request.tools;
      if (Number.isFinite(tokenBudget) && Array.isArray(request.messages)) {
        tokensUsed += countTokensApproximately(request.messages, tools);
        if (tokensUsed > tokenBudget) {
          const error = new Error(
            `gateway token budget exceeded (${tokensUsed} > ${tokenBudget}); the run is stopped before the next model call`,
          );
          error.name = 'TokenBudgetExceededError';
          throw error;
        }
      }
      onModelCall?.(tools?.map((entry) => String(entry?.name ?? '')) ?? []);
      return handler({ ...request, tools });
    },
    async wrapToolCall(request, handler) {
      const name = String(request?.toolCall?.name ?? '');
      if (name && !allowed.has(name)) {
        throw new Error(
          `tool "${name}" is not in the run's MCP allow-list and was refused at the gateway boundary`,
        );
      }
      return handler(request);
    },
  });
}

// Shared assembly: the runner and the contract test must build the SAME agent,
// or the test would pin a wiring that production does not use.
export function buildGatewayAgent({
  chatModel,
  tools = [],
  systemPrompt = null,
  checkpointer = null,
  tokenBudget = GATEWAY_TOKEN_BUDGET,
  onModelCall = null,
  backend = null,
  allowedExtraToolNames = [],
  middleware = null,
  name = 'agent',
}) {
  const allowedToolNames = [
    ...tools.map((entry) => String(entry?.name ?? '')).filter(Boolean),
    ...allowedExtraToolNames.map(String),
  ];
  return createDeepAgent({
    model: chatModel,
    tools,
    name,
    // The manager's per-run system prompt (role, capability, boundary,
    // profile). Without it, deepagents uses its generic assistant
    // prompt — the "upload your project" hallucination.
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    // Declared, never defaulted. Worktree runs pass a backend confined by
    // the canonical-path check (worktree.js); every other run keeps the
    // in-memory StateBackend — no filesystem, nothing durable.
    backend: backend ?? ((config) => new StateBackend(config)),
    middleware: middleware ?? [
      createGatewayBoundaryMiddleware({ allowedToolNames, tokenBudget, onModelCall }),
    ],
  });
}

// Timeline events: LangChain propagates callbacks into nested agents, so
// every role start/finish and every declared tool call becomes a structured
// SSE event the manager's runtimeEventAdapter already knows how to surface.
function createEventCallbacks({ onEvent, roleNames }) {
  const known = new Set(GATEWAY_WORKTREE_TOOL_NAMES);
  const emitTool = (type, name) => {
    const value = String(name ?? '');
    if (value.startsWith('wiki__') || known.has(value)) {
      onEvent?.({ type, tool: value });
    }
  };
  return [{
    handleAgentStart: (agent) => {
      const name = String(agent?.name ?? '');
      if (roleNames.has(name)) onEvent?.({ type: 'subagent_started', subagent: name });
    },
    handleAgentEnd: (agent) => {
      const name = String(agent?.name ?? '');
      if (roleNames.has(name)) onEvent?.({ type: 'subagent_finished', subagent: name });
    },
    handleToolStart: (tool) => emitTool('tool_started', tool?.name),
    handleToolEnd: (tool) => emitTool('tool_finished', tool?.name),
  }];
}

// ── The collective ───────────────────────────────────────────────────────────
//
// The named roles run as a SEQUENCE of bounded single-agent runs driven by
// the gateway, not as deepagents `subagents`. The decision is documented: the
// deepagents.js 1.13.2 subagent path serializes the model instance on a
// run's second model call (reproduced — the model reaches the bindTools layer
// as a bare dict), the same family as the missing subagent streaming of issue
// #284. Sequencing the roles in OUR code is the same collective the report
// describes — named roles, isolated context, a Critique that objects without
// blocking, a per-role event timeline — without depending on that path, and
// it keeps the boundary middleware on every model call of every role.

const COLLECTIVE_ORDER = ['scout', 'analyst', 'critique', 'redactor', 'archivist'];

function roleAllowList({ role, mcpToolNames, worktreeToolNames }) {
  return role === 'redactor'
    ? [...mcpToolNames, ...worktreeToolNames]
    : mcpToolNames;
}

// The handoff context one role passes to the next: findings so far, bounded
// so a long run cannot grow the prompt without bound.
function handoffSection(label, content) {
  const text = String(content ?? '').trim();
  if (!text) return '';
  const bounded = text.length > 6000 ? `${text.slice(0, 6000)}\n…[handoff truncated]` : text;
  return `\n\n## From ${label}\n${bounded}`;
}

async function invokeOnce({
  agent,
  input,
  threadId,
  signal,
  callbacks,
}) {
  const events = await agent.invoke(
    { messages: [{ role: 'user', content: input }] },
    {
      recursionLimit: GATEWAY_RECURSION_LIMIT,
      ...(signal ? { signal } : {}),
      configurable: { thread_id: threadId },
      ...(callbacks ? { callbacks } : {}),
    },
  );
  const last = [...(events?.messages ?? [])].reverse().find((message) => message?.content);
  return String(last?.content ?? '');
}

export function createAgentRunner({
  model,
  mcpServers = [],
  onEvent = null,
  signal = null,
  workspace = null,
  checkpointer = null,
  worktree = false,
  roles = [],
  runId = null,
  chatModelOverride = null,
  toolsOverride = null,
  onRoleModelCall = null,
}) {
  const baseUrl = model?.baseUrl ?? null;
  const rawName = model?.model ?? model?.name ?? null;
  const apiKey = model?.apiKey ?? null;
  if (!baseUrl || !rawName) {
    throw new Error('the run must carry baseUrl and model (sent by the manager)');
  }

  async function resolveChatModel() {
    const slash = rawName.indexOf('/');
    const provider = slash > 0 ? rawName.slice(0, slash) : (process.env.GATEWAY_MODEL_PROVIDER ?? 'openai');
    // Keep the FULL model id: OpenAI-compatible endpoints like albert expose
    // ids WITH the provider prefix ("openai/gpt-oss-120b" is the id itself).
    // The prefix only tells us which LangChain adapter to instantiate.
    const params = { modelProvider: provider };
    if (apiKey) params.apiKey = apiKey;
    if (baseUrl) params.configuration = { baseURL: baseUrl };
    if (!samplingRefusedByModel.has(rawName)) {
      for (const key of ['temperature', 'topP', 'seed']) {
        const value = Number(model?.[key]);
        if (Number.isFinite(value)) params[key] = value;
      }
    }
    const maxTokens = Number(model?.maxTokens);
    if (Number.isFinite(maxTokens)) params.maxTokens = maxTokens;
    if (typeof model?.reasoningEffort === 'string' && model.reasoningEffort) params.reasoningEffort = model.reasoningEffort;
    return initChatModel(rawName, params);
  }

  return {
    async run({ objective, operation, capability, language, systemPrompt, workspace: runWorkspace = workspace }) {
      // The runtime's EYES, loaded per run. toolsOverride is the offline test
      // seam; production always resolves the MCP pool.
      const tools = toolsOverride ?? (await loadMcpTools(mcpServers));
      const enabledRoles = COLLECTIVE_ORDER.filter((role) =>
        roles.map(String).includes(role),
      );
      const threadBase = String(runWorkspace?.name ?? runWorkspace ?? 'default');
      const threadId = `${threadBase}:${runId ?? 'run'}`;
      const roleSet = new Set(enabledRoles);
      const callbacks = onEvent
        ? createEventCallbacks({ onEvent, roleNames: roleSet })
        : null;

      const runWorktree = worktree
        ? await createWorktree({
            workspaceRoot: workspaceRootFor(runWorkspace),
            runId: runId ?? `run-${Date.now()}`,
          })
        : null;
      const worktreeState = runWorktree;

      const worktreeToolNames = worktreeState ? GATEWAY_WORKTREE_TOOL_NAMES : [];
      const mcpToolNames = tools.map((entry) => String(entry?.name ?? '')).filter(Boolean);

      const baseInput = [
        `Capability: ${capability ?? 'unknown'}`,
        `Operation: ${operation ?? 'run'}`,
        ...(language ? [`Reply in the workspace language: ${language}`] : []),
        '',
        `Objective: ${objective ?? ''}`,
        ...(worktreeState
          ? [
              '',
              `You write on a git branch for this objective. Your file edits land in the workspace review queue as a diff; a human merges them or not. Read the wiki with your MCP tools and correct files with the file tools.`,
            ]
          : []),
      ].join('\n');

      // The collective: each named role gets one bounded run with isolated
      // context (its own system prompt and thread), its own boundary
      // allow-list, and passes its findings to the next role.
      let handoffs = '';
      const roleOutputs = {};
      for (const role of enabledRoles) {
        const spec = COLLECTIVE_ROLE_SPECS[role];
        const allowed = roleAllowList({ role, mcpToolNames, worktreeToolNames });
        const roleAgent = buildGatewayAgent({
          chatModel: chatModelOverride ?? (await resolveChatModel()),
          tools,
          checkpointer: checkpointer ?? gatewayCheckpointer(),
          name: role,
          systemPrompt: spec.systemPrompt,
          ...(worktreeState && role === 'redactor'
            ? { backend: createWorktreeBackend({ worktreePath: worktreeState.path }) }
            : {}),
          middleware: [
            createGatewayBoundaryMiddleware({
              allowedToolNames: allowed,
              ...(onRoleModelCall
                ? { onModelCall: (names) => onRoleModelCall(role, names) }
                : {}),
            }),
          ],
        });
        onEvent?.({ type: 'subagent_started', subagent: role });
        let output;
        try {
          output = await invokeOnce({
            agent: roleAgent,
            input: `${baseInput}${handoffs}\n\nYour task as the ${role}: ${spec.description}`,
            threadId: `${threadId}:${role}`,
            signal,
            callbacks,
          });
        } finally {
          onEvent?.({ type: 'subagent_finished', subagent: role });
        }
        roleOutputs[role] = output;
        handoffs += handoffSection(role, output);
      }

      // The main agent assembles the findings into the final answer. Its
      // thread carries the workspace memory; the collective's runs are the
      // evidence, the assembly is the reply.
      const assembleInput = enabledRoles.length > 0
        ? [
            baseInput,
            '',
            '## Collective findings',
            ...enabledRoles.map((role) => `${role}: ${String(roleOutputs[role] ?? '').slice(0, 8000)}`),
            '',
            'Assemble the findings into ONE final answer. Any "[objection]" lines produced by the Critique MUST be repeated verbatim under a "## Objections" heading — unresolved objections travel with the diff, they never block it.',
          ].join('\n')
        : baseInput;

      const mainAgent = buildGatewayAgent({
        chatModel: chatModelOverride ?? (await resolveChatModel()),
        tools,
        systemPrompt,
        checkpointer: checkpointer ?? gatewayCheckpointer(),
        ...(worktreeState
          ? {
              backend: createWorktreeBackend({ worktreePath: worktreeState.path }),
              allowedExtraToolNames: worktreeToolNames,
            }
          : {}),
      });

      let events;
      const refusedParams = [];
      try {
        events = await mainAgent.invoke(
          { messages: [{ role: 'user', content: assembleInput }] },
          {
            recursionLimit: GATEWAY_RECURSION_LIMIT,
            ...(signal ? { signal } : {}),
            configurable: { thread_id: threadId },
            ...(callbacks ? { callbacks } : {}),
          },
        );
      } catch (error) {
        // Some models refuse sampling parameters (gpt-5 refuses `temperature`;
        // reasoning models expect `thinking` instead). The provider's
        // rejection IS the rule: remember it for this model, retry once
        // without the sampling params, and REPORT the refused params back to
        // the manager so the workspace config can be corrected.
        const message = error instanceof Error ? error.message : String(error);
        if (/temperature|sampling|unsupported value|thinking/i.test(message)) {
          samplingRefusedByModel.add(rawName);
          for (const key of ['temperature', 'topP', 'seed']) {
            if (Number.isFinite(Number(model?.[key]))) refusedParams.push(key);
          }
          events = await mainAgent.invoke(
            { messages: [{ role: 'user', content: assembleInput }] },
            {
              recursionLimit: GATEWAY_RECURSION_LIMIT,
              ...(signal ? { signal } : {}),
              configurable: { thread_id: threadId },
              ...(callbacks ? { callbacks } : {}),
            },
          );
        } else {
          // A failed run must not leave a branch nobody will review.
          if (worktreeState) {
            await removeWorktree({
              workspaceRoot: workspaceRootFor(runWorkspace),
              worktreePath: worktreeState.path,
              branch: worktreeState.branch,
            }).catch(() => {});
          }
          throw error;
        }
      }
      const last = [...(events?.messages ?? [])].reverse().find((message) => message?.content);
      const finalContent = String(last?.content ?? '');
      const objections = extractObjections(finalContent);

      // The proposal the human reviews: changed files, their new content, the
      // unified diff against the branch point, the agent's justification and
      // the unresolved objections. The worktree stays in place until the
      // merge/reject side removes it.
      let worktreeProposal = null;
      if (worktreeState) {
        const changes = await worktreeChanges({ worktreePath: worktreeState.path });
        const diff = await worktreeDiff({ worktreePath: worktreeState.path });
        const workspaceRoot = workspaceRootFor(runWorkspace);
        worktreeProposal = {
          workspace: String(runWorkspace?.name ?? runWorkspace ?? ''),
          branch: worktreeState.branch,
          // Container-local absolute path + the workspace-relative one the
          // merge side (serve, a different container) resolves itself.
          worktreePath: worktreeState.path,
          worktreeRelativePath: relativeWorkspacePath(workspaceRoot, worktreeState.path),
          justification: finalContent,
          ...(objections.length > 0 ? { objections } : {}),
          changedFiles: changes,
          changes: await Promise.all(
            changes.map(async (entry) => ({
              path: entry.path,
              status: entry.status,
              content: await worktreeFileContent({
                worktreePath: worktreeState.path,
                relativePath: entry.path,
              }).catch(() => null),
            })),
          ),
          diff,
        };
      }
      return {
        content: finalContent,
        ...(worktreeProposal ? { worktreeProposal } : {}),
        ...(refusedParams.length > 0 ? { refusedParams } : {}),
      };
    },
  };
}

// The worktree lives inside the workspace (`.wiki/agent-worktrees/<runId>`),
// so its identity travels as a workspace-relative path: the gateway and the
// merge side mount the same tree at different absolute roots.
function relativeWorkspacePath(workspaceRoot, worktreePath) {
  const rel = worktreePath.startsWith(workspaceRoot)
    ? worktreePath.slice(workspaceRoot.length).replace(/^[/\\]+/, '')
    : worktreePath;
  return rel.split('\\').join('/');
}

// The runtime's EYES, per run: the manager sends the active workspace's wiki
// MCP endpoint with its curated read tools. Workspace-scoped endpoints are
// per-run by nature — nothing static here, and nothing outside the declared
// allow-list is exposed. The connection stays alive for the run (the tools
// hold it), so the client is deliberately not closed.
async function loadMcpTools(servers) {
  const connections = {};
  const declared = new Set();
  for (const server of servers ?? []) {
    if (!server?.url) continue;
    const name = String(server.name ?? `server-${Object.keys(connections).length + 1}`);
    connections[name] = {
      transport: String(server.transport ?? 'http'),
      url: String(server.url),
      ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
    };
    for (const toolName of server.tools ?? []) declared.add(String(toolName));
  }
  if (Object.keys(connections).length === 0) return [];
  const client = new MultiServerMCPClient(connections);
  const tools = await client.getTools();
  if (declared.size === 0) return tools;
  return tools.filter((tool) => {
    const name = String(tool.name ?? '');
    const bare = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name;
    return declared.has(name) || declared.has(bare);
  });
}
