import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const NETWORK_FAILURE = /(?:finish_reason\s*:\s*network_error|network[_ -]error|socket|connection reset|fetch failed)/i;
const EDIT_MISS = /old_(?:string|str) was not found|FS_EDIT_NOT_FOUND/i;

function delay(ms, signal) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolveDelay(); }, { once: true });
  });
}

function sessionKey(payload) {
  return `${payload.agent.session.id}:${payload.turn}:${payload.step}`;
}

function mutationPath(exec) {
  const args = exec.arguments;
  if (!args || typeof args !== 'object') return null;
  if (exec.name === 'edit' || exec.name === 'write') return typeof args.file_path === 'string' ? args.file_path : null;
  if (exec.name === 'str_replace_editor' && ['create', 'str_replace', 'insert'].includes(args.command)) {
    return typeof args.path === 'string' ? args.path : null;
  }
  return null;
}

function insideWorkspace(cwd, candidate) {
  const relation = relative(resolve(cwd), resolve(cwd, candidate));
  return relation === '' || (!relation.startsWith('..') && !relation.includes(':'));
}

function failure(code, message) {
  return {
    isError: true,
    error: { name: 'OCUIResilienceGuard', code, message },
    content: [{ type: 'text', text: `Error: ${message}` }],
    meta: { ocuiGuard: true },
  };
}

function textContent(content) {
  return (content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}

function closestExcerpt(content, oldText) {
  const lines = content.split('\n');
  const needles = new Set(String(oldText).toLowerCase().match(/[a-z0-9_$.-]{3,}/g) || []);
  let best = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index++) {
    const window = lines.slice(index, index + 16).join('\n').toLowerCase();
    let score = 0;
    for (const needle of needles) if (window.includes(needle)) score++;
    if (score > bestScore) { bestScore = score; best = index; }
  }
  const start = Math.max(0, best - 3);
  return lines.slice(start, start + 22).join('\n').slice(0, 3200);
}

export function installResilience(ctx, config = {}) {
  const maxRetries = Number.isSafeInteger(config.networkRetries) ? Math.max(0, Math.min(5, config.networkRetries)) : 3;
  const retryBaseMs = Number.isFinite(config.networkRetryBaseMs) ? Math.max(0, config.networkRetryBaseMs) : 750;
  const retryJitterMs = Number.isFinite(config.networkRetryJitterMs) ? Math.max(0, config.networkRetryJitterMs) : 250;
  const retryCounts = new Map();
  const stats = { retries: 0, recoveredEditNoops: 0, guardedPaths: 0, editHints: 0, lastRecoveryAt: null };

  ctx.on('agent/request-error', async (payload, next) => {
    const { failure: requestFailure, signal } = payload;
    if (signal.aborted || !NETWORK_FAILURE.test(`${requestFailure.code}\n${requestFailure.message}`)) return next();
    const key = sessionKey(payload);
    const chain = retryCounts.get(key) || { attempt: 0, retryId: `ocui-${randomUUID()}` };
    const attempt = chain.attempt + 1;
    if (attempt > maxRetries) return next();
    retryCounts.set(key, { ...chain, attempt });
    stats.retries++;
    stats.lastRecoveryAt = Date.now();
    const waitMs = Math.min(8_000, retryBaseMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * retryJitterMs));
    ctx.logger.warn(`ocui resilience: retrying ${payload.provider} network failure (${attempt}/${maxRetries}) in ${waitMs}ms`);
    payload.agent.session.append('llm/retry', {
      retryId: chain.retryId,
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      mode: 'normal',
      maxRetries,
      policyKey: 'ocui-network-error',
      retry: attempt,
      delayMs: waitMs,
      failure: requestFailure,
    });
    await delay(waitMs, signal);
    if (signal.aborted) return undefined;
    payload.agent.session.append('llm/retry-started', {
      retryId: chain.retryId,
      turn: payload.turn,
      step: payload.step,
      retry: attempt,
    });
    return { kind: 'retry' };
  }, { prepend: true });

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const prefix = `${agent.session.id}:${turn}:`;
    for (const key of retryCounts.keys()) if (key.startsWith(prefix)) retryCounts.delete(key);
  });

  ctx.on('tools/execute', async (exec, next) => {
    const filePath = mutationPath(exec);
    const cwd = exec.agent?.session.header.cwd;
    if (filePath && cwd && !config.allowOutsideWorkspace && !insideWorkspace(cwd, filePath)) {
      stats.guardedPaths++;
      return failure('OCUI_OUTSIDE_WORKSPACE', `Blocked ${exec.name} outside this session workspace (${cwd}): ${filePath}. Open that workspace explicitly before changing it.`);
    }
    if (exec.name === 'edit' && exec.arguments?.old_string === exec.arguments?.new_string) {
      try {
        const target = await ctx.fs.resolve(exec.arguments.file_path, { ...(cwd ? { cwd } : {}), signal: exec.signal });
        const content = await ctx.fs.readText(target, exec.signal);
        stats.recoveredEditNoops++;
        return {
          isError: false,
          value: { path: target.displayPath, before: content, after: content },
          content: [{ type: 'text', text: `No edit was needed; ${target.displayPath} already contains the requested text.` }],
          meta: { ocuiRecoveredNoop: true },
        };
      } catch {
        return next();
      }
    }
    return next();
  }, { global: true, prepend: true });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!result.isError || !['edit', 'str_replace_editor'].includes(exec.name)) return next();
    const rendered = `${result.error?.code || ''}\n${result.error?.message || ''}\n${textContent(result.content)}`;
    if (!EDIT_MISS.test(rendered)) return next();
    const args = exec.arguments || {};
    const filePath = exec.name === 'edit' ? args.file_path : args.path;
    const oldText = exec.name === 'edit' ? args.old_string : args.old_str;
    if (typeof filePath !== 'string' || typeof oldText !== 'string') return next();
    try {
      const cwd = exec.agent?.session.header.cwd;
      const target = await ctx.fs.resolve(filePath, { ...(cwd ? { cwd } : {}), signal: exec.signal });
      const content = await ctx.fs.readText(target, exec.signal);
      const excerpt = closestExcerpt(content, oldText);
      stats.editHints++;
      return {
        kind: 'accept',
        content: [...result.content, {
          type: 'text',
          text: `\nOCUI recovery read the current file automatically. Rebuild the edit from this exact current excerpt, and do not repeat the stale old_string:\n\n${excerpt}`,
        }],
      };
    } catch {
      return next();
    }
  }, { global: true, prepend: true });

  return { snapshot: () => ({ ...stats, activeRetryChains: retryCounts.size }) };
}
