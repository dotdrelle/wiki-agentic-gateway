import { createDeepAgent } from 'deepagents';
import { initChatModel } from 'langchain/chat_models/universal';

/**
 * Agent runner — the single integration point with the Deep Agents SDK.
 *
 * The manager never sees this module: it talks to the HTTP contract in
 * server.js. Everything here can be swapped for another engine without the
 * manager noticing.
 *
 * The model comes from the RUN (the manager sends the active profile's model,
 * `openai/…`-style names included). initChatModel needs an explicit provider
 * for our OpenAI-compatible endpoints, so the `provider/name` prefix is split
 * and passed as `modelProvider` + `configuration.baseURL`.
 */
export function createAgentRunner({ model, mcpServers = {}, onTool = null, signal = null }) {
  const baseUrl = model?.baseUrl ?? null;
  const rawName = model?.model ?? model?.name ?? null;
  const apiKey = model?.apiKey ?? null;
  if (!baseUrl || !rawName) {
    throw new Error('the run must carry baseUrl and model (sent by the manager)');
  }
  const tools = loadMcpTools(mcpServers);

  async function resolveChatModel() {
    const slash = rawName.indexOf('/');
    const provider = slash > 0 ? rawName.slice(0, slash) : (process.env.GATEWAY_MODEL_PROVIDER ?? 'openai');
    // Keep the FULL model id: OpenAI-compatible endpoints like albert expose
    // ids WITH the provider prefix ("openai/gpt-oss-120b" is the id itself).
    // The prefix only tells us which LangChain adapter to instantiate.
    const params = { modelProvider: provider };
    if (apiKey) params.apiKey = apiKey;
    if (baseUrl) params.configuration = { baseURL: baseUrl };
    // Forward the numeric parameters the workspace profile declared — never
    // hardcode a sampling value the workspace did not configure.
    for (const key of ['temperature', 'maxTokens', 'topP', 'seed']) {
      const value = Number(model?.[key]);
      if (Number.isFinite(value)) params[key] = value;
    }
    return initChatModel(rawName, params);
  }

  return {
    async run({ objective, operation, capability, language }) {
      const chatModel = await resolveChatModel();
      const agent = createDeepAgent({ model: chatModel, tools });
      const input = [
        `Capability: ${capability ?? 'unknown'}`,
        `Operation: ${operation ?? 'run'}`,
        ...(language ? [`Reply in the workspace language: ${language}`] : []),
        '',
        `Objective: ${objective ?? ''}`,
      ].join('\n');
      const events = await agent.invoke(
        { messages: [{ role: 'user', content: input }] },
        { signal: signal ?? undefined },
      );
      onTool?.({ name: 'agent', done: true });
      const last = [...(events?.messages ?? [])].reverse().find((message) => message?.content);
      return String(last?.content ?? '');
    },
  };
}

// MCP tool loading stub — wire the pool here (langchain-mcp-adapters or
// equivalent). Read-only servers only.
function loadMcpTools(mcpServers) {
  const names = Object.keys(mcpServers ?? {});
  if (names.length > 0) {
    console.warn(`MCP pool declared but tool loading is not wired yet: ${names.join(', ')}`);
  }
  return [];
}
