import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CAPABILITIES = [
  {
    name: 'agent.review',
    operations: ['run'],
    description: 'Read-only audit of a wiki workspace: compare source documents against the existing concept pages, identify missing or under-covered classes, and produce a structured gap report. No mutation.',
    aliases: ['audit', 'review', 'analyze', 'compare', 'check'],
  },
];

/**
 * Gateway configuration.
 *
 * Capabilities come from `mcp.config.json` (`capabilities` key) or, when
 * absent, from the single default `agent.review` above.
 *
 * The `model` section here is a FALLBACK only: the manager sends the active
 * profile's model (baseUrl + model + apiKey) with every `POST /runs`, so the
 * gateway always follows the workspace's default LLM or the one selected with
 * `/config use` — no sync, no restart. The MCP pool (read tools only: wiki,
 * optional web search, optional mail) is declared in the same file and handed
 * to the agent runner.
 */
export function loadGatewayConfig({
  configDir = process.cwd(),
  env = process.env,
} = {}) {
  const file = join(configDir, 'mcp.config.json');
  let declared = {};
  if (existsSync(file)) {
    try {
      declared = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`mcp.config.json unreadable: ${error.message}`);
    }
  }
  return {
    version: declared.version ?? '0.15.66',
    capabilities: Array.isArray(declared.capabilities) && declared.capabilities.length > 0
      ? declared.capabilities
      : DEFAULT_CAPABILITIES,
    mcpServers: declared.mcpServers ?? {},
    model: {
      baseUrl: env.GATEWAY_MODEL_BASE_URL ?? declared.model?.baseUrl ?? null,
      apiKey: env.GATEWAY_MODEL_API_KEY ?? declared.model?.apiKey ?? null,
      name: env.GATEWAY_MODEL_NAME ?? declared.model?.name ?? null,
    },
  };
}
