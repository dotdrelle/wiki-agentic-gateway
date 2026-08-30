import { createDeepAgent } from 'deepagents';
import { initChatModel } from 'langchain/chat_models/universal';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

// Module-level memory: a model that refused sampling parameters once is not
// asked again during this process lifetime — one wasted call per model, not
// per run. Provider-driven, no hardcoded model list.
const samplingRefusedByModel = new Set();

export function createAgentRunner({ model, mcpServers = {}, onTool = null, signal = null }) {
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
    // Forward the parameters the workspace profile declared — never hardcode
    // a sampling value the workspace did not configure.
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
    async run({ objective, operation, capability, language, systemPrompt }) {
      const tools = await loadMcpTools(mcpServers);
      const input = [
        `Capability: ${capability ?? 'unknown'}`,
        `Operation: ${operation ?? 'run'}`,
        ...(language ? [`Reply in the workspace language: ${language}`] : []),
        '',
        `Objective: ${objective ?? ''}`,
      ].join('\n');
      const invoke = (chatModel) => {
        const agent = createDeepAgent({
          model: chatModel,
          tools,
          // The manager's per-run system prompt (role, capability, boundary,
          // profile). Without it, deepagents uses its generic assistant
          // prompt — the "upload your project" hallucination.
          ...(systemPrompt ? { systemPrompt } : {}),
        });
        return agent.invoke(
          { messages: [{ role: 'user', content: input }] },
          { signal: signal ?? undefined },
        );
      };
      let events;
      const refusedParams = [];
      try {
        events = await invoke(await resolveChatModel());
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
          events = await invoke(await resolveChatModel());
        } else {
          throw error;
        }
      }
      onTool?.({ name: 'agent', done: true });
      const last = [...(events?.messages ?? [])].reverse().find((message) => message?.content);
      return {
        content: String(last?.content ?? ''),
        ...(refusedParams.length > 0 ? { refusedParams } : {}),
      };
    },
  };
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
