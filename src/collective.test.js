import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, tool } from 'langchain';
import { z } from 'zod';
import { COLLECTIVE_ROLE_GRAPH, createAgentRunner, dependencyRoles } from './agent.js';
import { extractObjections, extractResolutions } from './collective.js';

// Scripted model: responses are consumed in order, the last one repeats.
// FakeListChatModel formats responses as TEXT (tool_calls are dropped), so a
// test that scripts tool use needs a model that returns message INSTANCES.
// bindTools must return a NEW instance (like every real model): the agent
// assembly rebinds the model on every call and rejects models that carry
// tools already bound.
class ScriptedChatModel extends BaseChatModel {
  constructor({ responses, counter }) {
    super({});
    this.responses = responses;
    this.counter = counter ?? { i: 0 };
  }

  _llmType() {
    return 'scripted';
  }

  _combineLLMOutput() {
    return [];
  }

  bindTools(tools) {
    const next = new ScriptedChatModel({ responses: this.responses, counter: this.counter });
    next.tools = [...(this.tools ?? []), ...tools];
    return next;
  }

  async _generate() {
    const response = this.responses[Math.min(this.counter.i, this.responses.length - 1)];
    if (this.counter.i < this.responses.length - 1) this.counter.i += 1;
    const message = typeof response === 'string' ? new AIMessage(response) : response;
    return { generations: [{ message, text: String(message?.content ?? '') }], llmOutput: {} };
  }
}

function fakeMcpTool() {
  return tool(async () => 'page content', {
    name: 'wiki__wiki_read_page',
    description: 'read one wiki page',
    schema: z.object({ path: z.string() }),
  });
}

function gitWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-collective-root-'));
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: workspace });
  mkdirSync(join(workspace, 'wiki', 'concepts', 'demo'), { recursive: true });
  writeFileSync(join(workspace, 'wiki', 'concepts', 'demo', 'a.md'), '# A\nclaim without source\n');
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: workspace });
  return { root, workspace };
}

test('the collective: each named role runs once and its lifecycle is announced', async () => {
  const events = [];
  const model = new ScriptedChatModel({
    responses: [
      'found: wiki/concepts/demo/a.md',
      'analysis: one subject, concept demo',
      '[objection] severity: blocking — wiki/concepts/demo/a.md — unsourced claim',
      'memory: re-verify the claim',
      'assembled\n## Objections\n[objection] severity: blocking — wiki/concepts/demo/a.md — unsourced claim',
    ],
  });
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [fakeMcpTool()],
    roles: ['scout', 'analyst', 'critique', 'archivist'],
    checkpointer: false,
    onEvent: (event) => events.push(event),
    runId: 'collective-1',
    chatModelOverride: model,
  });
  const output = await runner.run({
    objective: 'audit',
    capability: 'agent.review',
    systemPrompt: 'You are Donna.',
    workspace: 'demo',
  });

  assert.match(output.content, /assembled/);
  for (const role of ['scout', 'analyst', 'critique', 'archivist']) {
    assert.ok(
      events.some((event) => event.type === 'subagent_started' && event.subagent === role),
      `${role} start is announced`,
    );
    assert.ok(
      events.some((event) => event.type === 'subagent_finished' && event.subagent === role),
      `${role} finish is announced`,
    );
  }
  const objections = extractObjections(output.content);
  assert.equal(objections.length, 1);
  assert.equal(objections[0].severity, 'blocking');
  // The path is a structured field, not prose: the finding event carries it
  // so a downstream filter (Logs, a future proposal view) names the page.
  const finding = events.find((event) => event.type === 'finding' && event.category === 'objection');
  assert.ok(finding, 'the objection travels as a finding');
  assert.equal(finding.path, 'wiki/concepts/demo/a.md');
  assert.equal(finding.severity, 'blocking');
  assert.equal(finding.summary, 'unsourced claim');
});

test('role frontiers: the Critique never sees the write tools, the Redactor does', async () => {
  const { root } = gitWorkspace('demo');
  const previous = process.env.GATEWAY_WORKSPACES_ROOT;
  process.env.GATEWAY_WORKSPACES_ROOT = root;
  const seen = {};
  const model = new ScriptedChatModel({
    responses: [
      '[objection] severity: non-blocking — wiki/concepts/demo/a.md — duplicated section',
      'rewrote wiki/concepts/demo/a.md',
      'assembled\n## Objections\n[objection] severity: non-blocking — wiki/concepts/demo/a.md — duplicated section',
    ],
  });
  try {
    const runner = createAgentRunner({
      model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
      mcpServers: [],
      toolsOverride: [fakeMcpTool()],
      worktree: true,
      roles: ['critique', 'redactor'],
      checkpointer: false,
      runId: 'collective-2',
      chatModelOverride: model,
      onRoleModelCall: (role, names) => {
        seen[role] = [...(seen[role] ?? []), ...names];
      },
    });
    const output = await runner.run({
      objective: 'curate the workspace',
      capability: 'agent.curate',
      systemPrompt: 'You are Donna.',
      workspace: 'demo',
    });

    assert.match(output.content, /assembled/);
    const critiqueSaw = [...new Set(seen.critique ?? [])];
    const redactorSaw = [...new Set(seen.redactor ?? [])];
    assert.ok(critiqueSaw.includes('wiki__wiki_read_page'), 'the critique reads');
    assert.ok(!critiqueSaw.includes('write_file'), 'the critique never sees write_file');
    assert.ok(!critiqueSaw.includes('delete'), 'the critique never sees delete');
    assert.ok(redactorSaw.includes('write_file'), 'the redactor has the declared hands');
    assert.ok(redactorSaw.includes('wiki__wiki_read_page'), 'the redactor still reads');
    assert.ok(output.worktreeProposal, 'the worktree run yields a proposal');
    assert.equal(output.worktreeProposal.objections.length, 1, 'the objections travel with the proposal');
    assert.equal(output.worktreeProposal.objections[0].severity, 'non-blocking');
  } finally {
    process.env.GATEWAY_WORKSPACES_ROOT = previous;
  }
});

test('the Archivist closes an objection by naming it, and only then', () => {
  // The shape it must reproduce: path and statement.
  assert.deepEqual(
    extractResolutions('memory: re-verify\n[resolved] wiki/concepts/demo/a.md — unsourced claim'),
    [{ path: 'wiki/concepts/demo/a.md', statement: 'unsourced claim' }],
  );
  // A statement-only resolution is allowed; prose without the marker is not.
  assert.deepEqual(extractResolutions('[resolved] unsourced claim'), [{ path: null, statement: 'unsourced claim' }]);
  assert.deepEqual(extractResolutions('I think the claim is probably fine now.'), []);
});

test('the role graph gives each role its transitive handoffs in canonical order', () => {
  assert.deepEqual(COLLECTIVE_ROLE_GRAPH.scout, []);
  assert.deepEqual(COLLECTIVE_ROLE_GRAPH.redteam, [], 'the red team depends on nothing: it reads raw material');
  assert.deepEqual(dependencyRoles('scout', ['scout', 'redteam', 'analyst']), []);
  assert.deepEqual(dependencyRoles('analyst', ['scout', 'redteam', 'analyst']), ['scout']);
  // Canonical order, not finish order: redteam sorts before analyst.
  assert.deepEqual(
    dependencyRoles('redactor', ['scout', 'redteam', 'analyst', 'critique', 'redactor']),
    ['scout', 'redteam', 'analyst', 'critique'],
  );
  assert.deepEqual(
    dependencyRoles('archivist', ['scout', 'redteam', 'analyst', 'critique', 'redactor', 'archivist']),
    ['scout', 'redteam', 'analyst', 'critique', 'redactor'],
  );
  // A dependency that is not enabled does not block its dependent.
  assert.deepEqual(dependencyRoles('analyst', ['analyst']), []);
});
