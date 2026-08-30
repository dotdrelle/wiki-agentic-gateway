import { createDeepAgent } from 'deepagents';

/**
 * Agent runner — the single integration point with the Deep Agents SDK.
 *
 * The manager never sees this module: it talks to the HTTP contract in
 * server.js. Everything here can be swapped for another engine without the
 * manager noticing.
 *
 * `loadMcpTools` is deliberately left for the deployer: the pool must stay
 * read-only (wiki read tools, optional web search) plus scoped, approval-
 * gated tools (mail). Never expose write paths to the workspace here — the
 * hands are the DAG.
 */
export function createAgentRunner({ model, mcpServers = {}, onTool = null, signal = null }) {
  // The model comes from the RUN: the manager sends the active profile's
  // model (same as the manager's own LLM). There is no local model config.
  const baseUrl = model?.baseUrl ?? null;
  const modelName = model?.model ?? model?.name ?? null;
  const apiKey = model?.apiKey ?? null;
  if (!baseUrl || !modelName) {
    throw new Error('the run must carry baseUrl and model (sent by the manager)');
  }
  const tools = loadMcpTools(mcpServers);

  return {
    async run({ objective, operation, capability }) {
      const agent = createDeepAgent({
        model: modelName,
        modelConfig: { baseUrl, ...(apiKey ? { apiKey } : {}) },
        tools,
      });
      const input = [
        `Capability: ${capability ?? 'unknown'}`,
        `Operation: ${operation ?? 'run'}`,
        '',
        `Objective: ${objective ?? ''}`,
      ].join('\n');
      const events = await agent.invoke(
        { messages: [{ role: 'user', content: input }] },
        { signal: signal ?? undefined },
      );
      onTool?.({ name: 'agent', done: true });
      const last = [...events.messages].reverse().find((message) => message?.content);
      return String(last?.content ?? '');
    },
  };
}

// MCP tool loading stub — wire the pool declared in mcp.config.json here
// (langchain-mcp-adapters or equivalent). Read-only servers only.
function loadMcpTools(mcpServers) {
  const names = Object.keys(mcpServers ?? {});
  if (names.length > 0) {
    console.warn(`MCP pool declared but tool loading is not wired yet: ${names.join(', ')}`);
  }
  return [];
}
