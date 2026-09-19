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

test('the gateway refuses a run naming a capability it does not serve', async () => {
  const server = startGateway({
    port: 0,
    config: {
      version: 'test',
      capabilities: [{ name: 'agent.review', operations: ['run'] }],
      authToken: null,
    },
    createRunner: () => ({ run: async () => 'must not run' }),
  });
  const port = server.address().port;
  const post = (body) => fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const model = { baseUrl: 'http://127.0.0.1:9/v1', model: 'openai/gpt-test' };
  try {
    // A gateway degraded to its default capability must not silently run a
    // governed capability without its approval gate.
    const unknown = await post({ capability: 'agent.research', operation: 'run', objective: 'x', model });
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json();
    assert.match(unknownBody.error, /unknown capability "agent.research"/);
    assert.deepEqual(unknownBody.served, ['agent.review']);

    const nameless = await post({ operation: 'run', objective: 'x', model });
    assert.equal(nameless.status, 400);
    assert.match((await nameless.json()).error, /must name a capability/);

    const badOperation = await post({ capability: 'agent.review', operation: 'plan', objective: 'x', model });
    assert.equal(badOperation.status, 400);
    assert.match((await badOperation.json()).error, /operation "plan" not offered/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Lot 0: transport observable ──────────────────────────────────────────────

function reviewConfig() {
  return {
    version: 'test',
    capabilities: [{ name: 'agent.review', operations: ['run'] }],
    authToken: null,
  };
}

async function startReview(extra = {}) {
  const runner = extra.runner ?? (() => ({ run: async () => 'done' }));
  const server = startGateway({ port: 0, config: reviewConfig(), createRunner: runner });
  return { server, port: server.address().port };
}

async function launchReview(port) {
  const created = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'agent.review',
      operation: 'run',
      objective: 'audit',
      model: { baseUrl: 'http://127.0.0.1:9/v1', model: 'openai/gpt-test', apiKey: 'k' },
    }),
  }).then((response) => response.json());
  for (let i = 0; i < 100; i += 1) {
    const status = await fetch(`http://127.0.0.1:${port}/runs/${created.runId}`).then((r) => r.json());
    if (status.status === 'completed') return created.runId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not complete');
}

async function collectSse(url) {
  const response = await fetch(url);
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => {
      const line = block.split('\n').find((entry) => entry.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : null;
    })
    .filter(Boolean);
}

test('the stream announces its epoch first and replays strictly after the cursor', async () => {
  const { server, port } = await startReview();
  try {
    const runId = await launchReview(port);
    const all = await collectSse(`http://127.0.0.1:${port}/runs/${runId}/events`);
    assert.equal(all[0].type, 'stream_epoch', 'the epoch frame comes first');
    assert.ok(all.some((event) => event.type === 'run_completed'));

    const after = await collectSse(`http://127.0.0.1:${port}/runs/${runId}/events?after=1`);
    const replayed = after.filter((event) => Number.isFinite(event.sequence)).map((event) => event.sequence);
    assert.ok(replayed.length > 0);
    assert.ok(replayed.every((sequence) => sequence > 1), `no event at or before the cursor — saw ${replayed.join(', ')}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an epoch mismatch ends the stream with a degraded and no replay', async () => {
  const { server, port } = await startReview();
  try {
    const runId = await launchReview(port);
    const frames = await collectSse(`http://127.0.0.1:${port}/runs/${runId}/events?epoch=another-instance`);
    assert.equal(frames[0].type, 'stream_epoch');
    const degraded = frames.find((event) => event.type === 'degraded');
    assert.ok(degraded, 'the restart is announced');
    assert.match(degraded.cause, /restarted/);
    assert.ok(!frames.some((event) => event.type === 'run_completed'), 'no event is replayed across an epoch change');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the run buffer is bounded, and a stale cursor is told what it lost', async () => {
  const previous = process.env.GATEWAY_MAX_RUN_EVENTS;
  // One retained event forces a real drop (sequences 0 and 1 leave), so the
  // cursor of a client that only saw sequence 0 is genuinely behind the buffer.
  process.env.GATEWAY_MAX_RUN_EVENTS = '1';
  const { server, port } = await startReview();
  try {
    const runId = await launchReview(port);
    const plain = await collectSse(`http://127.0.0.1:${port}/runs/${runId}/events`);
    const facts = plain.filter((event) => event.type !== 'stream_epoch' && event.type !== 'degraded');
    assert.equal(facts.length, 1, 'the buffer holds at most the ceiling');

    const stale = await collectSse(`http://127.0.0.1:${port}/runs/${runId}/events?after=0`);
    assert.ok(
      stale.some((event) => event.type === 'degraded' && /left the runtime buffer/.test(event.cause)),
      'a cursor older than the buffer is told events were lost',
    );
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_MAX_RUN_EVENTS;
    else process.env.GATEWAY_MAX_RUN_EVENTS = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a finished run closes its stream and is purged after its TTL', async () => {
  const previous = process.env.GATEWAY_RUN_TTL_MS;
  process.env.GATEWAY_RUN_TTL_MS = '1';
  const { server, port } = await startReview();
  try {
    const runId = await launchReview(port);
    const text = await fetch(`http://127.0.0.1:${port}/runs/${runId}/events`).then((response) => response.text());
    assert.match(text, /run_completed/, 'the stream closed on its own with the terminal event');
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const status = await fetch(`http://127.0.0.1:${port}/runs/${runId}`);
    assert.equal(status.status, 404, 'the finished run was purged');
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_RUN_TTL_MS;
    else process.env.GATEWAY_RUN_TTL_MS = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});
