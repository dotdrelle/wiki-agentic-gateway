import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage, tool } from 'langchain';
import { z } from 'zod';
import {
  GATEWAY_BUILTIN_TOOL_NAMES,
  ROLE_TOOL_POLICY,
  buildGatewayAgent,
  createGatewayBoundaryMiddleware,
  roleAllowList,
  resolveMemoryScope,
} from './agent.js';

// The frontier contract: whatever deepagents attaches by default, the model
// must see EXACTLY the tools the manager sent. This test exercises the same
// buildGatewayAgent wiring production uses, with a fake model — so a future
// deepagents version that adds a default tool (a browser, a shell, another
// subagent) fails HERE, by name, instead of silently widening the frontier.

test('the model sees only the declared MCP tools, never the harness defaults', async () => {
  const seen = [];
  const fakeModel = new FakeListChatModel({
    responses: [new AIMessage({ content: 'done' })],
  });
  const fakeMcpTool = tool(async () => 'ok', {
    name: 'wiki__wiki_read_page',
    description: 'read one wiki page',
    schema: z.object({ path: z.string() }),
  });

  const agent = buildGatewayAgent({
    chatModel: fakeModel,
    tools: [fakeMcpTool],
    onModelCall: (names) => seen.push(...names),
  });
  const result = await agent.invoke(
    { messages: [{ role: 'user', content: 'audit the workspace' }] },
    { recursionLimit: 6 },
  );

  assert.match(String(result.messages?.at(-1)?.content ?? ''), /done/);
  assert.ok(seen.length > 0, 'the model was called at least once');
  const unique = [...new Set(seen)];
  assert.deepEqual(unique, ['wiki__wiki_read_page'], 'the visible tool set is exactly the MCP pool');
  for (const name of GATEWAY_BUILTIN_TOOL_NAMES) {
    assert.ok(!seen.includes(name), `harness default tool "${name}" must never reach the model`);
  }
});

test('the boundary refuses a tool call outside the allow-list as a tool error', async () => {
  const boundary = createGatewayBoundaryMiddleware({
    allowedToolNames: ['wiki__wiki_read_page'],
  });

  const refused = await boundary.wrapToolCall(
    { toolCall: { name: 'write_file', id: 'call-wf' } },
    async () => 'executed',
  );
  assert.equal(refused.tool_call_id, 'call-wf');
  assert.equal(refused.status, 'error');
  assert.match(String(refused.content), /not in the run's MCP allow-list/);
  const result = await boundary.wrapToolCall(
    { toolCall: { name: 'wiki__wiki_read_page' } },
    async () => 'executed',
  );
  assert.equal(result, 'executed');
});

test('a failing tool is returned as a tool error, not thrown out of the run', async () => {
  const boundary = createGatewayBoundaryMiddleware({
    allowedToolNames: ['wiki__wiki_read_page'],
  });

  const failed = await boundary.wrapToolCall(
    { toolCall: { name: 'wiki__wiki_read_page', id: 'call-read' } },
    async () => {
      throw new Error("MCP tool 'wiki_read_page' on server 'wiki' returned an error: Page not found: wiki/concepts/produit/demonstration-anaplan.md");
    },
  );
  // The run survives the failure: the model receives a tool error it can adapt
  // to, instead of the whole curation being lost before any proposal exists.
  assert.equal(failed.tool_call_id, 'call-read');
  assert.equal(failed.status, 'error');
  assert.match(String(failed.content), /Page not found/);

  // An abort is not a tool result: cancellation must still escape.
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(
    boundary.wrapToolCall(
      { toolCall: { name: 'wiki__wiki_read_page', id: 'call-abort' } },
      async () => { throw abort; },
    ),
    /aborted/,
  );
});

test('the boundary enforces the token budget before the next model call', async () => {
  const boundary = createGatewayBoundaryMiddleware({
    allowedToolNames: [],
    tokenBudget: 40,
  });
  const longMessage = { role: 'user', content: 'x'.repeat(400) };
  await assert.rejects(
    boundary.wrapModelCall({ tools: [], messages: [longMessage] }, async (request) => request),
    /token budget exceeded/,
  );
});

// ── Memory scope (lot 1) ─────────────────────────────────────────────────────
//
// A thread key is a READ capability: it decides whose past conversation this
// run resumes. These pin that the gateway owns the namespace and never takes
// the caller's word for it.

test('an absent memory scope is the normal mono-user case, not a degradation', () => {
  const resolved = resolveMemoryScope({ supplied: null, workspace: { name: 'acme' } });
  assert.equal(resolved.scope, 'acme');
  assert.equal(resolved.degraded, null);
  assert.equal(resolveMemoryScope({ supplied: '   ', workspace: 'acme' }).degraded, null);
});

test('a scope may only refine the run workspace, never leave it', () => {
  const refined = resolveMemoryScope({ supplied: 'acme:alice', workspace: { name: 'acme' } });
  assert.equal(refined.scope, 'acme:alice');
  assert.equal(refined.degraded, null);

  for (const hostile of ['other', 'other:alice', 'acme-evil', '../acme', 'acme:../../etc']) {
    const refused = resolveMemoryScope({ supplied: hostile, workspace: { name: 'acme' } });
    assert.equal(refused.scope, 'acme', `"${hostile}" must fall back to the workspace`);
    assert.ok(refused.degraded, `"${hostile}" must announce the refusal`);
  }
});

test('an oversized scope is refused rather than used as a thread key', () => {
  const refused = resolveMemoryScope({ supplied: `acme:${'a'.repeat(400)}`, workspace: 'acme' });
  assert.equal(refused.scope, 'acme');
  assert.match(refused.degraded.cause, /maximum length/);
});

test('the per-role frontier is declared and never widens a read role', () => {
  const mcpToolNames = ['wiki__wiki_read_page', 'wiki__wiki_search_context'];
  const worktreeToolNames = ['read_file', 'write_file', 'edit_file'];

  const redactor = roleAllowList({ role: 'redactor', mcpToolNames, worktreeToolNames });
  assert.deepEqual(redactor, [...mcpToolNames, ...worktreeToolNames]);

  for (const role of ['scout', 'analyst', 'critique', 'archivist']) {
    const reductions = [];
    const allowed = roleAllowList({
      role,
      mcpToolNames,
      worktreeToolNames,
      onReduction: (entry) => reductions.push(entry),
    });
    assert.deepEqual(allowed, mcpToolNames, `${role} sees the read pool only`);
    assert.ok(!allowed.some((name) => worktreeToolNames.includes(name)), `${role} never gets a write tool`);
    // The reduction is journalled: a boundary that narrows in silence is not auditable.
    assert.equal(reductions.length, 1);
    assert.deepEqual(reductions[0].reduced, worktreeToolNames);
  }
});

test('the declared policy is the only source of a role tool class', () => {
  assert.deepEqual(ROLE_TOOL_POLICY.scout, ['read']);
  assert.deepEqual(ROLE_TOOL_POLICY.redactor, ['read', 'worktree']);
  // An unknown role fails closed to reads.
  assert.deepEqual(
    roleAllowList({ role: 'nobody', mcpToolNames: ['wiki__wiki_read_page'], worktreeToolNames: ['write_file'] }),
    ['wiki__wiki_read_page'],
  );
});
