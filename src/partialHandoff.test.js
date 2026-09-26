import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecursionLimit, partialRoleHandoff } from './agent.js';

test('a step-limit error is recognised by name or by message', () => {
  assert.equal(isRecursionLimit(Object.assign(new Error('x'), { name: 'GraphRecursionError' })), true);
  assert.equal(isRecursionLimit(new Error('Recursion limit of 40 reached without hitting a stop condition.')), true);
  assert.equal(isRecursionLimit(new Error('HTTP 429')), false);
});

test('a role that hit its step limit hands over what it had read, newest first', async () => {
  // Observed on acpi: the Scout read pages one by one, ran out of steps and,
  // being required, took the curation down with everything it had found.
  const agent = {
    async getState({ configurable }) {
      assert.equal(configurable.thread_id, 'ws:run:scout');
      return { values: { messages: [
        { type: 'human', content: 'find material' },
        { type: 'ai', content: '' },
        { type: 'tool', name: 'wiki_read_pages', content: 'wiki/concepts/a.md …' },
        { type: 'tool', name: 'wiki_read_pages', content: 'wiki/concepts/b.md …' },
      ] } };
    },
  };
  const partial = await partialRoleHandoff(agent, 'ws:run:scout');
  assert.equal(partial.toolResults, 2);
  assert.match(partial.text, /^\[partial — this role hit its step limit after 2 tool result\(s\)/);
  assert.ok(partial.text.indexOf('b.md') < partial.text.indexOf('a.md'), 'newest first');
});

test('a role that gathered nothing still fails', async () => {
  const agent = { async getState() { return { values: { messages: [{ type: 'human', content: 'go' }] } }; } };
  assert.equal(await partialRoleHandoff(agent, 't'), null);
  assert.equal(await partialRoleHandoff({}, 't'), null);
});
