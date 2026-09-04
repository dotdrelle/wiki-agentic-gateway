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
 * Gateway configuration — ONE file, shared with the manager.
 *
 * The gateway mounts the manager's `agent-runtimes.json` read-only and serves
 * the capabilities of ITS OWN entry (id from `GATEWAY_RUNTIME_ID`, default
 * `deepagents`). Nothing else is configured here:
 *
 * - the model travels with every run (the manager sends the active profile's
 *   model, same LLM as the manager itself);
 * - the MCP pool will do the same: workspace-scoped endpoints are per-run by
 *   nature, so a static pool file can never be right.
 *
 * A missing file, or no matching entry, degrades to the single default
 * `agent.review` above.
 */
export function loadGatewayConfig({
  configDir = process.env.GATEWAY_CONFIG_DIR ?? process.cwd(),
  env = process.env,
} = {}) {
  const runtimeId = String(env.GATEWAY_RUNTIME_ID ?? 'deepagents');
  const file = join(configDir, 'agent-runtimes.json');
  let entries = [];
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      entries = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.runtimes ?? [] : []);
    } catch (error) {
      console.warn(`agent-runtimes.json unreadable: ${error.message}`);
    }
  }
  const entry = entries.find((item) => item?.id === runtimeId)
    ?? entries.find((item) => item?.type === 'deepagents')
    ?? null;
  return {
    version: String(env.GATEWAY_VERSION ?? '0.15.78'),
    capabilities: Array.isArray(entry?.capabilities) && entry.capabilities.length > 0
      ? entry.capabilities
      : DEFAULT_CAPABILITIES,
    authToken: String(env.GATEWAY_AUTH_TOKEN ?? '').trim() || null,
  };
}
