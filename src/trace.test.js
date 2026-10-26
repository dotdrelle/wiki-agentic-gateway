import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimitedWarn, formatGatewayEvent, gatewayTraceMode } from './trace.js';

const ts = '2026-10-16T08:49:06.962Z';
const run = { runId: 'gateway-mvaq7f5k-4', capability: 'agent.maintain', workspace: 'demo' };

test('a refused maintenance action is an ERROR naming the action and its cause', () => {
  const line = formatGatewayEvent({ type: 'maintenance_result', ts, action: 'curate', target: 'wiki', status: 'failed', error: 'maintenance_capability_unavailable: agent.curate' }, { run });
  assert.equal(line, `${ts} ERROR run=gateway-mvaq7f5k-4 cap=agent.maintain ws=demo maintenance_result curate target=wiki status=failed — maintenance_capability_unavailable: agent.curate`);
});

test('degraded and role events are traced; heartbeat and tools are not by default', () => {
  assert.match(formatGatewayEvent({ type: 'degraded', ts, capability: 'maintenance-decision', cause: 'the model ended without calling any maintenance tool' }, { run }), /WARN .* degraded maintenance-decision — the model ended/);
  assert.match(formatGatewayEvent({ type: 'subagent_started', ts, subagent: 'scout' }, { run }), /subagent_started role=scout$/);
  assert.equal(formatGatewayEvent({ type: 'heartbeat', ts }, { run }), null);
  assert.equal(formatGatewayEvent({ type: 'tool_started', ts, tool: 'wiki_read_page' }, { run }), null);
  assert.match(formatGatewayEvent({ type: 'tool_started', ts, tool: 'wiki_read_page' }, { run, mode: 'tools' }), /tool_started wiki_read_page$/);
  assert.equal(gatewayTraceMode({ GATEWAY_TRACE: 'off' }), 'off');
});

test('a repeated 401 is written once per window, with the count it absorbed', () => {
  let clock = 0;
  const lines = [];
  const warn = createRateLimitedWarn({ windowMs: 60_000, now: () => clock, write: (line) => lines.push(line) });
  warn('k', 'gateway: 401 GET /health — bearer token differs from GATEWAY_AUTH_TOKEN');
  clock = 10_000; warn('k', 'again');
  clock = 20_000; warn('k', 'again');
  clock = 61_000; warn('k', 'gateway: 401 GET /health — bearer token differs from GATEWAY_AUTH_TOKEN');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\(\+2 similar in the last 60s\)$/);
});
