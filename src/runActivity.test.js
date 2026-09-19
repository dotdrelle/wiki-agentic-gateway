import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, tool } from 'langchain';
import { z } from 'zod';
import { createAgentRunner, createPhaseTracker } from './agent.js';
import { createDossierStore } from './dossier.js';

/*
 The two memory lifetimes, asserted on the thread ids that REALLY reach the
 graph — not on a helper the runner might forget to call.

 The main thread is the workspace's memory and persists across runs; the role
 threads are bounded to one run. Before this, the role threads derived from the
 main one, so making the main thread stable would silently have made a Critique
 re-raise an objection settled three runs earlier.
*/
class RecordingSaver extends MemorySaver {
  constructor() {
    super();
    this.threadIds = [];
  }

  async getTuple(config) {
    const id = config?.configurable?.thread_id;
    if (id) this.threadIds.push(String(id));
    return super.getTuple(config);
  }
}

class StubModel extends BaseChatModel {
  _llmType() { return 'stub'; }
  _combineLLMOutput() { return []; }
  bindTools() { return new StubModel({}); }
  async _generate() {
    const message = new AIMessage('done');
    return { generations: [{ message, text: 'done' }], llmOutput: {} };
  }
}

function readTool() {
  return tool(async () => 'page', {
    name: 'wiki__wiki_read_page',
    description: 'read one wiki page',
    schema: z.object({ path: z.string() }),
  });
}

async function runOnce({ saver, runId, memoryScope = null, workspace = 'acme' }) {
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'critique'],
    checkpointer: saver,
    runId,
    memoryScope,
    chatModelOverride: new StubModel({}),
  });
  await runner.run({ objective: 'audit', capability: 'agent.review', workspace });
}

test('two runs of one workspace share the main thread but never a role thread', async () => {
  const saver = new RecordingSaver();
  await runOnce({ saver, runId: 'run-1' });
  await runOnce({ saver, runId: 'run-2' });

  const seen = new Set(saver.threadIds);
  // One main thread for the workspace, across both runs.
  assert.ok(seen.has('acme'), `main thread must be the workspace — saw ${[...seen].join(', ')}`);
  // Role threads carry the run: never shared between run-1 and run-2.
  assert.ok(seen.has('acme:run-1:scout'), 'run-1 scout thread is run-scoped');
  assert.ok(seen.has('acme:run-2:scout'), 'run-2 scout thread is run-scoped');
  assert.ok(!seen.has('acme:scout'), 'a role thread must never be workspace-scoped');
});

test('two workspaces never share a thread', async () => {
  const saver = new RecordingSaver();
  await runOnce({ saver, runId: 'run-1', workspace: 'acme' });
  await runOnce({ saver, runId: 'run-1', workspace: 'other' });

  const seen = new Set(saver.threadIds);
  assert.ok(seen.has('acme') && seen.has('other'));
  for (const id of seen) {
    assert.ok(
      id.startsWith('acme') || id.startsWith('other'),
      `every thread is namespaced by its workspace — saw "${id}"`,
    );
  }
});

test('a refused scope falls back to the workspace and announces itself', async () => {
  const saver = new RecordingSaver();
  const events = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: [],
    checkpointer: saver,
    runId: 'run-9',
    memoryScope: 'other-workspace:alice',
    onEvent: (event) => events.push(event),
    chatModelOverride: new StubModel({}),
  });
  await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'acme' });

  assert.ok(saver.threadIds.includes('acme'), 'the run reads its OWN workspace memory');
  assert.ok(!saver.threadIds.some((id) => id.startsWith('other-workspace')));
  const degraded = events.find((event) => event.type === 'degraded');
  assert.ok(degraded, 'a refused scope is never silent');
  assert.match(degraded.cause, /outside the run's workspace/);
});

test('the normal mono-user run announces nothing', async () => {
  const saver = new RecordingSaver();
  const events = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: [],
    checkpointer: saver,
    runId: 'run-10',
    memoryScope: null,
    onEvent: (event) => events.push(event),
    chatModelOverride: new StubModel({}),
  });
  await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'acme' });
  assert.equal(events.filter((event) => event.type === 'degraded').length, 0);
});

/*
 Role failure (lot 2).

 Before this, ANY role throwing removed the worktree and rethrew: a transport
 error in the Critique destroyed a curation the Scout, Analyst and Redactor had
 already done, diff included. The rule is now the one the collective already
 states — Critique has a right to objection, never to block — extended to its
 failures.
*/
class FailingRoleModel extends BaseChatModel {
  constructor(failFor) {
    super({});
    this.failFor = failFor;
    this.calls = 0;
  }

  _llmType() { return 'failing'; }
  _combineLLMOutput() { return []; }
  bindTools() { return this; }

  async _generate(messages) {
    this.calls += 1;
    const text = messages.map((m) => String(m?.content ?? '')).join('\n');
    if (this.failFor && text.includes(`Your task as the ${this.failFor}`)) {
      throw new Error(`${this.failFor} transport exploded`);
    }
    const message = new AIMessage('done');
    return { generations: [{ message, text: 'done' }], llmOutput: {} };
  }
}

test('an OPTIONAL role that fails degrades the run instead of ending it', async () => {
  const events = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'analyst', 'critique'],
    checkpointer: false,
    runId: 'run-optional',
    onEvent: (event) => events.push(event),
    chatModelOverride: new FailingRoleModel('critique'),
  });

  const output = await runner.run({
    objective: 'audit', capability: 'agent.review', workspace: 'acme',
  });

  // The run produced its answer.
  assert.equal(typeof output.content, 'string');
  // …and it says what it lost, on the result AND on the stream.
  assert.deepEqual(output.degradations.map((entry) => entry.role), ['critique']);
  assert.equal(output.degradations[0].required, false);
  const degraded = events.find((event) => event.type === 'degraded');
  assert.match(degraded.capability, /role:critique/);
  assert.match(degraded.cause, /transport exploded/);
  // The phase that failed still closed, marked not-ok: a reader must not see a
  // phase hanging open forever.
  const closed = events.find((event) => event.type === 'phase_finished' && event.phase === 'critique');
  assert.equal(closed.ok, false);
});

test('a REQUIRED role that fails stops the run', async () => {
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'analyst'],
    checkpointer: false,
    runId: 'run-required',
    chatModelOverride: new FailingRoleModel('scout'),
  });

  await assert.rejects(
    () => runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'acme' }),
    /scout transport exploded/,
  );
});

test('phases open and close in order, and count the tools they used', async () => {
  const events = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'analyst'],
    checkpointer: false,
    runId: 'run-phases',
    onEvent: (event) => events.push(event),
    chatModelOverride: new StubModel({}),
  });
  await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'acme' });

  const phases = events
    .filter((event) => event.type === 'phase_started' || event.type === 'phase_finished')
    .map((event) => `${event.type === 'phase_started' ? '>' : '<'}${event.phase}`);
  assert.deepEqual(phases, ['>discover', '<discover', '>analyse', '<analyse', '>assemble', '<assemble']);
});

test('progress is coalesced: one frame per window, not one per tool', () => {
  const events = [];
  const tracker = createPhaseTracker((event) => events.push(event));
  tracker.start('discover');
  // The first tool emits at once (the window is reset at phase start), the
  // rest inside the interval do not: forty reads must not be forty frames.
  for (let i = 0; i < 40; i += 1) tracker.countTool('wiki__wiki_read_page');
  tracker.finish('discover');

  const progress = events.filter((event) => event.type === 'progress');
  assert.ok(progress.length >= 1, 'the phase still reports it is alive');
  assert.ok(progress.length < 40, `expected coalescing, saw ${progress.length} frames`);
  assert.equal(progress[0].pages, 1);
  // The counts are never lost to the throttle: the phase close carries them.
  const finished = events.find((event) => event.type === 'phase_finished');
  assert.equal(finished.tools, 40);
  assert.equal(finished.pages, 40);
});

function gitWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-retain-root-'));
  const workspace = join(root, name);
  mkdirSync(join(workspace, 'wiki', 'concepts', 'demo'), { recursive: true });
  writeFileSync(join(workspace, 'wiki', 'concepts', 'demo', 'a.md'), '# A\nclaim\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: workspace });
  return { root, workspace };
}

test('an OPTIONAL role failure keeps the worktree the human will review', async () => {
  const { root } = gitWorkspace('retain-demo');
  const previous = process.env.GATEWAY_WORKSPACES_ROOT;
  process.env.GATEWAY_WORKSPACES_ROOT = root;
  try {
    const runner = createAgentRunner({
      model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
      mcpServers: [],
      toolsOverride: [readTool()],
      worktree: true,
      roles: ['scout', 'critique', 'archivist'],
      checkpointer: false,
      runId: 'retain-opt',
      chatModelOverride: new FailingRoleModel('archivist'),
    });
    const output = await runner.run({
      objective: 'audit', capability: 'agent.curate', workspace: 'retain-demo',
    });

    assert.deepEqual(output.degradations.map((entry) => entry.role), ['archivist']);
    // The Redactor's diff — the proposal — must survive the optional failure.
    assert.ok(
      existsSync(join(root, 'retain-demo', '.wiki', 'agent-worktrees', 'retain-opt')),
      'an optional failure never removes the worktree',
    );
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_WORKSPACES_ROOT;
    else process.env.GATEWAY_WORKSPACES_ROOT = previous;
  }
});

test('a REQUIRED role failure removes the worktree it can no longer justify', async () => {
  const { root } = gitWorkspace('drop-demo');
  const previous = process.env.GATEWAY_WORKSPACES_ROOT;
  process.env.GATEWAY_WORKSPACES_ROOT = root;
  try {
    const runner = createAgentRunner({
      model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
      mcpServers: [],
      toolsOverride: [readTool()],
      worktree: true,
      roles: ['scout', 'analyst'],
      checkpointer: false,
      runId: 'drop-req',
      chatModelOverride: new FailingRoleModel('scout'),
    });

    await assert.rejects(
      () => runner.run({ objective: 'audit', capability: 'agent.curate', workspace: 'drop-demo' }),
      /scout transport exploded/,
    );
    assert.ok(
      !existsSync(join(root, 'drop-demo', '.wiki', 'agent-worktrees', 'drop-req')),
      'a required failure leaves no branch nobody will review',
    );
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_WORKSPACES_ROOT;
    else process.env.GATEWAY_WORKSPACES_ROOT = previous;
  }
});

class CapturingModel extends BaseChatModel {
  constructor(sink) {
    super({});
    this.sink = sink;
  }
  _llmType() { return 'capture'; }
  _combineLLMOutput() { return []; }
  bindTools() { return this; }
  async _generate(messages) {
    this.sink.push(messages.map((message) => String(message?.content ?? '')).join('\n'));
    return { generations: [{ message: new AIMessage('done'), text: 'done' }], llmOutput: {} };
  }
}

function tempSaver(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const saver = SqliteSaver.fromConnString(join(dir, 'memory.sqlite'));
  saver.setup();
  return { dir, saver };
}

test('the workspace dossier is written, read by the next run, and evictable', async () => {
  const { dir, saver } = tempSaver('gateway-memory-');
  const dossier = createDossierStore({ db: saver.db });
  // A scope nobody has touched inside the TTL.
  dossier.write('old-workspace', 'old-workspace', { summary: 'old', objections: [] }, new Date(Date.now() - 10 * 24 * 3600 * 1000));
  const prompts = [];
  const notices = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'analyst', 'critique', 'archivist'],
    checkpointer: saver,
    runId: 'mem-1',
    onEvent: (event) => { if (event.type === 'notice') notices.push(event); },
    chatModelOverride: new CapturingModel(prompts),
  });
  const previous = process.env.GATEWAY_MEMORY_TTL_MS;
  process.env.GATEWAY_MEMORY_TTL_MS = String(24 * 3600 * 1000);
  try {
    await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'mem-demo' });

    assert.ok(dossier.read('mem-demo'), 'the run folded its conclusions into the dossier');
    assert.equal(dossier.read('old-workspace'), null, 'the inactive scope is evicted');
    assert.ok(
      notices.some((notice) => notice.topic === 'memory.evicted' && notice.detail === 'old-workspace'),
      'the eviction is announced',
    );

    prompts.length = 0;
    await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'mem-demo' });
    assert.ok(
      prompts.some((text) => text.includes('## Workspace memory')),
      'the next run starts from the dossier',
    );
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_MEMORY_TTL_MS;
    else process.env.GATEWAY_MEMORY_TTL_MS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the main thread is compacted past its checkpoint ceiling, dossier kept', async () => {
  const { dir, saver } = tempSaver('gateway-compact-');
  const dossier = createDossierStore({ db: saver.db });
  const notices = [];
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: [],
    checkpointer: saver,
    runId: 'compact-1',
    onEvent: (event) => { if (event.type === 'notice') notices.push(event); },
    chatModelOverride: new StubModel({}),
  });
  const previous = process.env.GATEWAY_MEMORY_MAX_CHECKPOINTS;
  process.env.GATEWAY_MEMORY_MAX_CHECKPOINTS = '1';
  try {
    await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'compact-demo' });

    const counted = saver.db
      .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?')
      .get('compact-demo');
    assert.equal(Number(counted.n), 0, 'the main thread was rotated');
    assert.ok(dossier.read('compact-demo'), 'the dossier survives the rotation');
    assert.ok(notices.some((notice) => notice.topic === 'memory.compacted'));
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_MEMORY_MAX_CHECKPOINTS;
    else process.env.GATEWAY_MEMORY_MAX_CHECKPOINTS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

class ResolvingModel extends BaseChatModel {
  constructor(role, text) {
    super({});
    this.role = role;
    this.text = text;
  }
  _llmType() { return 'resolving'; }
  _combineLLMOutput() { return []; }
  bindTools() { return this; }
  async _generate(messages) {
    const content = messages.map((message) => String(message?.content ?? '')).join('\n');
    const text = content.includes(`Your task as the ${this.role}`) ? this.text : 'done';
    return { generations: [{ message: new AIMessage(text), text }], llmOutput: {} };
  }
}

test('the Archivist closes an earlier objection explicitly, and silence would keep it', async () => {
  const { dir, saver } = tempSaver('gateway-resolve-');
  const dossier = createDossierStore({ db: saver.db });
  dossier.write('resolve-demo', 'resolve-demo', {
    summary: 'first memory',
    objections: [{ severity: 'blocking', path: 'wiki/concepts/demo/a.md', statement: 'unsourced claim' }],
  });
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: ['scout', 'analyst', 'critique', 'archivist'],
    checkpointer: saver,
    runId: 'resolve-1',
    chatModelOverride: new ResolvingModel(
      'archivist',
      'what this run decided\n[resolved] wiki/concepts/demo/a.md — unsourced claim',
    ),
  });
  try {
    await runner.run({ objective: 'audit', capability: 'agent.curate', workspace: 'resolve-demo' });

    const after = dossier.read('resolve-demo');
    assert.equal(after.objections.length, 0, 'the named objection was closed');
    assert.match(after.summary, /what this run decided/);
    assert.doesNotMatch(after.summary, /\[resolved\]/, 'the instruction is not memory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eviction removes every thread of the scope, including actor and role keys', async () => {
  const { dir, saver } = tempSaver('gateway-evict-');
  const dossier = createDossierStore({ db: saver.db });
  dossier.write('multi-ws', 'multi-ws', { summary: 'old', objections: [] }, new Date(Date.now() - 10 * 24 * 3600 * 1000));
  const insert = saver.db.prepare(
    'INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const id of ['multi-ws', 'multi-ws:alice', 'multi-ws:run-1:scout']) {
    insert.run(id, '', `cp-${id}`, null, 'json', '{}', '{}');
  }
  const runner = createAgentRunner({
    model: { baseUrl: 'http://x', model: 'openai/gpt-test', apiKey: 'k' },
    mcpServers: [],
    toolsOverride: [readTool()],
    roles: [],
    checkpointer: saver,
    runId: 'evict-1',
    chatModelOverride: new StubModel({}),
  });
  const previous = process.env.GATEWAY_MEMORY_TTL_MS;
  process.env.GATEWAY_MEMORY_TTL_MS = String(24 * 3600 * 1000);
  try {
    await runner.run({ objective: 'audit', capability: 'agent.review', workspace: 'keep-ws' });
    const ids = saver.db.prepare('SELECT DISTINCT thread_id FROM checkpoints').all().map((row) => String(row.thread_id));
    assert.ok(ids.includes('keep-ws'), 'the active workspace keeps its thread');
    assert.ok(!ids.some((id) => id.startsWith('multi-ws')), `every key of the evicted scope is gone — saw ${ids.join(', ')}`);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_MEMORY_TTL_MS;
    else process.env.GATEWAY_MEMORY_TTL_MS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
