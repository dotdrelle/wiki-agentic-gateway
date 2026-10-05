import test from 'node:test';
import assert from 'node:assert/strict';
import { withExplicitToolChoice } from './agent.js';

test('tool binding always carries an explicit tool_choice', () => {
  const seen = [];
  const model = {
    bindTools(tools, options) {
      seen.push({ tools, options });
      return { tools, options };
    },
  };
  const wrapped = withExplicitToolChoice(model);
  wrapped.bindTools(['a']);
  wrapped.bindTools(['a'], { parallel_tool_calls: false });
  wrapped.bindTools(['a'], { tool_choice: 'required' });
  wrapped.bindTools(['a'], { tool_choice: undefined });
  assert.deepEqual(seen, [
    { tools: ['a'], options: { tool_choice: 'auto' } },
    { tools: ['a'], options: { parallel_tool_calls: false, tool_choice: 'auto' } },
    { tools: ['a'], options: { tool_choice: 'required' } },
    { tools: ['a'], options: { tool_choice: 'auto' } },
  ]);
});

test('a model without bindTools is returned untouched', () => {
  const model = {};
  assert.equal(withExplicitToolChoice(model), model);
});
