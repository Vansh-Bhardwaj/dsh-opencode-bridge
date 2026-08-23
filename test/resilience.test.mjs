import test from 'node:test';
import assert from 'node:assert/strict';
import { installResilience } from '../plugin/lib/resilience.js';

function fixture(fileContent = 'const current = true;\nfunction exactBlock() {\n  return current;\n}\n') {
  const handlers = new Map();
  const ctx = {
    logger: { warn() {} },
    fs: {
      async resolve(path) { return { displayPath: path }; },
      async readText() { return fileContent; },
    },
    on(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
  };
  return { ctx, handlers };
}

test('retries the exact network_error misclassification with durable retry events', async () => {
  const { ctx, handlers } = fixture();
  const status = installResilience(ctx, { networkRetries: 2, networkRetryBaseMs: 0, networkRetryJitterMs: 0 });
  const events = [];
  const result = await handlers.get('agent/request-error')[0]({
    agent: { session: { id: 'session', append: (type, data) => events.push({ type, data }) } },
    turn: 4,
    step: 7,
    provider: 'opencode-go',
    failure: { code: 'PI_AI_ERROR', message: 'Provider finish_reason: network_error' },
    signal: new AbortController().signal,
  }, () => { throw new Error('narrow recovery delegated unexpectedly'); });
  assert.deepEqual(result, { kind: 'retry' });
  assert.deepEqual(events.map((event) => event.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(events[0].data.maxRetries, 2);
  assert.equal(status.snapshot().retries, 1);
});

test('does not retry unrelated PI_AI_ERROR failures', async () => {
  const { ctx, handlers } = fixture();
  installResilience(ctx, { networkRetryBaseMs: 0, networkRetryJitterMs: 0 });
  const delegated = { kind: 'terminal' };
  const result = await handlers.get('agent/request-error')[0]({
    agent: { session: { id: 'session', append() {} } }, turn: 1, step: 1, provider: 'provider',
    failure: { code: 'PI_AI_ERROR', message: 'invalid request body' }, signal: new AbortController().signal,
  }, async () => delegated);
  assert.equal(result, delegated);
});

test('does not retry a terminal context-capacity error', async () => {
  const { ctx, handlers } = fixture();
  installResilience(ctx, { networkRetryBaseMs: 0, networkRetryJitterMs: 0 });
  const delegated = { kind: 'terminal' };
  const result = await handlers.get('agent/request-error')[0]({
    agent: { session: { id: 'session', append() {} } }, turn: 1, step: 1, provider: 'provider',
    failure: { code: 'PI_AI_ERROR', message: 'model context capacity exceeded' }, signal: new AbortController().signal,
  }, async () => delegated);
  assert.equal(result, delegated);
});

test('retries provider capacity and timeout failures with classified events', async () => {
  for (const [message, reason] of [['HTTP 429 too many requests', 'capacity'], ['request timed out', 'timeout']]) {
    const { ctx, handlers } = fixture();
    const status = installResilience(ctx, { networkRetryBaseMs: 0, networkRetryJitterMs: 0 });
    const events = [];
    const result = await handlers.get('agent/request-error')[0]({
      agent: { session: { id: reason, append: (type, data) => events.push({ type, data }) } },
      turn: 1, step: 1, provider: 'opencode-go', failure: { code: 'PI_AI_ERROR', message }, signal: new AbortController().signal,
    }, async () => ({ kind: 'terminal' }));
    assert.deepEqual(result, { kind: 'retry' });
    assert.equal(events[0].data.reason, reason);
    assert.equal(status.snapshot().retryReasons[reason], 1);
  }
});

test('blocks direct mutation tools outside the session workspace', async () => {
  const { ctx, handlers } = fixture();
  installResilience(ctx);
  const result = await handlers.get('tools/execute')[0]({
    name: 'edit', arguments: { file_path: 'C:\\other\\file.ts', old_string: 'a', new_string: 'b' },
    agent: { session: { header: { cwd: 'C:\\workspace' } } }, signal: new AbortController().signal,
  }, async () => { throw new Error('guard delegated unexpectedly'); });
  assert.equal(result.isError, true);
  assert.equal(result.error.code, 'OCUI_OUTSIDE_WORKSPACE');
});

test('absorbs identical edit pairs as a safe no-op', async () => {
  const { ctx, handlers } = fixture();
  const status = installResilience(ctx);
  const result = await handlers.get('tools/execute')[0]({
    name: 'edit', arguments: { file_path: 'file.ts', old_string: 'same', new_string: 'same' },
    agent: { session: { header: { cwd: 'C:\\workspace' } } }, signal: new AbortController().signal,
  }, async () => { throw new Error('no-op delegated unexpectedly'); });
  assert.equal(result.isError, false);
  assert.equal(result.value.before, result.value.after);
  assert.equal(status.snapshot().recoveredEditNoops, 1);
});

test('repairs a unique edit whose only mismatch is CRLF line endings', async () => {
  const { ctx, handlers } = fixture('alpha\r\nbeta\r\ngamma\r\n');
  const status = installResilience(ctx);
  const exec = {
    name: 'edit', arguments: { file_path: 'file.ts', old_string: 'alpha\nbeta', new_string: 'updated' },
    agent: { session: { header: { cwd: 'C:\\workspace' } } }, signal: new AbortController().signal,
  };
  const delegated = await handlers.get('tools/execute')[0](exec, async () => ({ kind: 'delegated' }));
  assert.deepEqual(delegated, { kind: 'delegated' });
  assert.equal(exec.arguments.old_string, 'alpha\r\nbeta');
  assert.equal(status.snapshot().recoveredLineEndings, 1);
});

test('adds actionable locations after an ambiguous edit failure', async () => {
  const content = 'first\nconst target = true;\nafter first\n\nsecond\nconst target = true;\nafter second\n';
  const { ctx, handlers } = fixture(content);
  const status = installResilience(ctx);
  const result = await handlers.get('tools/post-execute')[0]({
    name: 'edit', arguments: { file_path: 'file.ts', old_string: 'const target = true;', new_string: 'const target = false;' },
    agent: { session: { header: { cwd: 'C:\\workspace' } } }, signal: new AbortController().signal,
  }, {
    isError: true,
    error: { message: 'old_string matched 2 times; provide a more specific old_string' },
    content: [{ type: 'text', text: 'ambiguous edit' }],
  }, async () => ({ kind: 'delegated' }));
  assert.equal(result.kind, 'accept');
  assert.match(result.content.at(-1).text, /Match 1:/);
  assert.match(result.content.at(-1).text, /Match 2:/);
  assert.equal(status.snapshot().editHints, 1);
});
