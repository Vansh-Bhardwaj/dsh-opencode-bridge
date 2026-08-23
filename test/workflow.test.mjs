import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkflowGuidance, WORKFLOW_GUIDANCE } from '../plugin/lib/workflow.js';

test('installs concise reliability guidance on existing root agents', () => {
  let registered;
  let cleanup;
  const agent = {
    ctx: {
      inject(dependencies, callback) {
        assert.deepEqual(dependencies, ['systemPrompt']);
        callback({ systemPrompt: { section(value) { registered = value; } } });
        return { dispose() {} };
      },
    },
  };
  const ctx = {
    agents: { list: () => [agent], roots: () => [agent] },
    on() {},
    effect(factory) { cleanup = factory(); },
  };
  const state = installWorkflowGuidance(ctx);
  assert.equal(registered.name, 'ocui:workflow-reliability');
  assert.equal(registered.text(), WORKFLOW_GUIDANCE);
  assert.match(registered.text(), /never repeat the identical call unchanged/i);
  assert.match(registered.text(), /full rewrite must preserve the complete file/i);
  assert.deepEqual(state.snapshot(), { enabled: true, agentsGuided: 1, activeAgents: 1 });
  cleanup();
  assert.equal(state.snapshot().activeAgents, 0);
});

test('does not add coding guidance to non-root worker agents', () => {
  let injected = false;
  const worker = { ctx: { inject() { injected = true; } } };
  const ctx = {
    agents: { list: () => [worker], roots: () => [] },
    on() {},
    effect() {},
  };
  const state = installWorkflowGuidance(ctx);
  assert.equal(injected, false);
  assert.equal(state.snapshot().activeAgents, 0);
});
