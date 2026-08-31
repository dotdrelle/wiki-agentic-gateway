import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlanExpansionRequest, startGateway } from './server.js';

test('extractPlanExpansionRequest lifts a full-JSON proposal', () => {
  const content = JSON.stringify({
    planExpansionRequest: {
      capability: 'knowledge.update',
      operation: 'ingest',
      objective: 'ingest the pending sources',
    },
    summary: 'proposal follows',
  });
  const request = extractPlanExpansionRequest(content);
  assert.equal(request.capability, 'knowledge.update');
  assert.equal(request.operation, 'ingest');
});

test('extractPlanExpansionRequest lifts a JSON block embedded in prose', () => {
  const content = [
    'Findings: the workspace has pending sources.',
    '{"planExpansionRequest": {"capability": "knowledge.update", "operation": "ingest_apply", "objective": "apply"}}',
    'That is my proposal.',
  ].join('\n');
  const request = extractPlanExpansionRequest(content);
  assert.equal(request.capability, 'knowledge.update');
  assert.equal(request.objective, 'apply');
});

test('extractPlanExpansionRequest ignores prose without a capability', () => {
  assert.equal(extractPlanExpansionRequest('no proposal here, just prose.'), null);
  assert.equal(extractPlanExpansionRequest('{"planExpansionRequest": {"operation": "ingest"}}'), null, 'a proposal without a capability stays prose');
});

test('the gateway serves the manager contract over HTTP', async () => {
  const server = startGateway({
    port: 0,
    config: {
      version: 'test',
      capabilities: [{ name: 'agent.review', operations: ['run'] }],
      authToken: null,
    },
    createRunner: (run, model, request) => ({
      run: async () => `received model ${model?.model ?? 'none'}, mcp servers ${(request?.mcp ?? []).length}, capability ${request?.capability ?? 'none'}`,
    }),
  });
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const capabilities = await fetch(`http://127.0.0.1:${port}/capabilities`).then((r) => r.json());
    assert.equal(capabilities[0].name, 'agent.review');

    const created = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'agent.review',
        operation: 'run',
        objective: 'audit',
        model: { baseUrl: 'http://127.0.0.1:9/v1', model: 'openai/gpt-test', apiKey: 'k' },
        mcp: [{ name: 'wiki', url: 'http://127.0.0.1:3201/mcp', tools: ['wiki_list_pages'] }],
      }),
    }).then((r) => r.json());
    assert.ok(created.runId);

    const status = await fetch(`http://127.0.0.1:${port}/runs/${created.runId}`).then((r) => r.json());
    assert.equal(status.status, 'completed');
    assert.match(status.result.content, /mcp servers 1/);
    assert.match(status.result.content, /model openai\/gpt-test/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
