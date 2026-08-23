import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const NETWORK_FAILURE = /(?:finish_reason\s*:\s*network_error|network[_ -]error|socket|econnreset|connection reset|fetch failed|dns|enotfound)/i;
const TIMEOUT_FAILURE = /(?:timed?\s*out|timeout|etimedout|headers timeout)/i;
const CAPACITY_FAILURE = /(?:http\s*(?:429|502|503|504)|status\s*(?:429|502|503|504)|rate[_ -]?limit|too many requests|temporarily unavailable|service unavailable|overloaded|capacity)/i;
const EDIT_MISS = /old_(?:string|str) was not found|FS_EDIT_NOT_FOUND/i;
const EDIT_DUPLICATE = /old_(?:string|str) matched \d+ times|matched \d+ times/i;
const READ_REQUIRED = /requires reading .* first|read the file, then retry/i;

function retryReason(requestFailure) {
  const rendered = `${requestFailure?.code || ''}\n${requestFailure?.message || ''}`;
  if (/(?:context (?:length|window|capacity)|maximum context|max(?:imum)? tokens|invalid request|unauthorized|forbidden)/i.test(rendered)) return null;
  if (NETWORK_FAILURE.test(rendered)) return 'network';
  if (TIMEOUT_FAILURE.test(rendered)) return 'timeout';
  if (CAPACITY_FAILURE.test(rendered)) return 'capacity';
  return null;
}

function delay(ms, signal) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolveDelay(); }, { once: true });
  });
}

function sessionKey(payload) {
  return `${payload.agent.session.id}:${payload.turn}:${payload.step}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function executionKey(exec) {
  const sessionId = String(exec.agent?.session?.id || 'unknown');
  return `${sessionId}:${exec.name}:${stableStringify(exec.arguments || {})}`;
}

function deterministicEditReason(rendered) {
  if (EDIT_DUPLICATE.test(rendered)) return 'ambiguous';
  if (READ_REQUIRED.test(rendered)) return 'unread';
  if (EDIT_MISS.test(rendered)) return 'stale';
  return null;
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

function occurrenceContexts(content, oldText) {
  if (!oldText) return '';
  const lines = content.split('\n');
  const firstLine = String(oldText).split('\n')[0].trim();
  const matches = [];
  for (let index = 0; index < lines.length; index++) {
    if (firstLine && lines[index].includes(firstLine)) matches.push(index);
  }
  return matches.slice(0, 4).map((index, matchIndex) => {
    const start = Math.max(0, index - 2);
    const excerpt = lines.slice(start, index + 4).map((line, offset) => `${start + offset + 1}: ${line}`).join('\n');
    return `Match ${matchIndex + 1}:\n${excerpt}`;
  }).join('\n\n').slice(0, 4200);
}

export function installResilience(ctx, config = {}) {
  const maxRetries = Number.isSafeInteger(config.networkRetries) ? Math.max(0, Math.min(5, config.networkRetries)) : 3;
  const retryBaseMs = Number.isFinite(config.networkRetryBaseMs) ? Math.max(0, config.networkRetryBaseMs) : 750;
  const retryJitterMs = Number.isFinite(config.networkRetryJitterMs) ? Math.max(0, config.networkRetryJitterMs) : 250;
  const largeWriteGuardChars = Number.isFinite(config.largeWriteGuardChars) ? Math.max(1000, config.largeWriteGuardChars) : 12_000;
  const maxWriteShrinkRatio = Number.isFinite(config.maxWriteShrinkRatio) ? Math.max(0.05, Math.min(0.95, config.maxWriteShrinkRatio)) : 0.25;
  const retryCounts = new Map();
  const failedExecutions = new Map();
  const stats = { retries: 0, retryReasons: { network: 0, timeout: 0, capacity: 0 }, recoveredEditNoops: 0, recoveredLineEndings: 0, guardedPaths: 0, editHints: 0, repeatedFailureBlocks: 0, truncatingWritesBlocked: 0, lastRecoveryAt: null };

  ctx.on('agent/request-error', async (payload, next) => {
    const { failure: requestFailure, signal } = payload;
    const reason = retryReason(requestFailure);
    if (signal?.aborted || !reason) return next();
    const key = sessionKey(payload);
    const chain = retryCounts.get(key) || { attempt: 0, retryId: `ocui-${randomUUID()}` };
    const attempt = chain.attempt + 1;
    if (attempt > maxRetries) return next();
    retryCounts.set(key, { ...chain, attempt });
    stats.retries++;
    stats.retryReasons[reason]++;
    stats.lastRecoveryAt = Date.now();
    const waitMs = Math.min(8_000, retryBaseMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * retryJitterMs));
    ctx.logger.warn(`ocui resilience: retrying ${payload.provider} ${reason} failure (${attempt}/${maxRetries}) in ${waitMs}ms`);
    payload.agent.session.append('llm/retry', {
      retryId: chain.retryId,
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      mode: 'normal',
      maxRetries,
      policyKey: `ocui-${reason}-error`,
      reason,
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
    const executionPrefix = `${agent.session.id}:`;
    for (const key of failedExecutions.keys()) if (key.startsWith(executionPrefix)) failedExecutions.delete(key);
  });

  ctx.on('tools/execute', async (exec, next) => {
    const filePath = mutationPath(exec);
    const cwd = exec.agent?.session.header.cwd;
    if (filePath && cwd && !config.allowOutsideWorkspace && !insideWorkspace(cwd, filePath)) {
      stats.guardedPaths++;
      return failure('OCUI_OUTSIDE_WORKSPACE', `Blocked ${exec.name} outside this session workspace (${cwd}): ${filePath}. Open that workspace explicitly before changing it.`);
    }
    const previousFailure = failedExecutions.get(executionKey(exec));
    if (previousFailure) {
      stats.repeatedFailureBlocks++;
      stats.lastRecoveryAt = Date.now();
      const correction = previousFailure.reason === 'ambiguous'
        ? 'Make the replacement unique with surrounding lines from one occurrence.'
        : previousFailure.reason === 'unread'
          ? 'Read the current file first, then retry.'
          : 'Read the current region and rebuild old_string from the exact current text.';
      return failure('OCUI_REPEATED_FAILED_CALL', `Blocked an unchanged retry of a deterministic failed ${exec.name} call. ${correction} Do not submit identical arguments again.`);
    }
    if (exec.name === 'write' && typeof exec.arguments?.content === 'string' && !config.allowLargeWriteShrink) {
      try {
        const target = await ctx.fs.resolve(exec.arguments.file_path, { ...(cwd ? { cwd } : {}), signal: exec.signal });
        const current = await ctx.fs.readText(target, exec.signal);
        const removed = current.length - exec.arguments.content.length;
        if (current.length >= largeWriteGuardChars && removed > current.length * maxWriteShrinkRatio) {
          stats.truncatingWritesBlocked++;
          stats.lastRecoveryAt = Date.now();
          const percent = Math.round((removed / current.length) * 100);
          return failure('OCUI_TRUNCATING_WRITE', `Blocked a full-file write that would remove ${percent}% of existing ${target.displayPath}. This usually means a generated rewrite lost the file tail. Read the complete file and preserve it, or use focused edits. Set allowLargeWriteShrink only for an intentional replacement.`);
        }
      } catch { /* New files and canonical file errors continue to the write tool. */ }
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
    if (exec.name === 'edit' && typeof exec.arguments?.old_string === 'string' && /\r?\n/.test(exec.arguments.old_string)) {
      try {
        const target = await ctx.fs.resolve(exec.arguments.file_path, { ...(cwd ? { cwd } : {}), signal: exec.signal });
        const content = await ctx.fs.readText(target, exec.signal);
        if (!content.includes(exec.arguments.old_string)) {
          const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
          const adjusted = exec.arguments.old_string.replace(/\r?\n/g, lineEnding);
          if (adjusted !== exec.arguments.old_string && content.includes(adjusted)) {
            exec.arguments.old_string = adjusted;
            stats.recoveredLineEndings++;
            stats.lastRecoveryAt = Date.now();
          }
        }
      } catch { /* Let the canonical tool report file access errors. */ }
    }
    return next();
  }, { global: true, prepend: true });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const filePath = mutationPath(exec);
    const sessionId = String(exec.agent?.session?.id || 'unknown');
    if (!result.isError) {
      const readPath = exec.name === 'read' && (typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : exec.arguments?.path);
      if (typeof readPath === 'string') {
        for (const [key, failed] of failedExecutions) {
          if (key.startsWith(`${sessionId}:`) && failed.reason === 'unread' && failed.filePath === readPath) failedExecutions.delete(key);
        }
      } else if (filePath) {
        for (const [key, failed] of failedExecutions) {
          if (key.startsWith(`${sessionId}:`) && failed.filePath === filePath) failedExecutions.delete(key);
        }
      }
      return next();
    }
    if (!['edit', 'str_replace_editor'].includes(exec.name)) return next();
    const rendered = `${result.error?.code || ''}\n${result.error?.message || ''}\n${textContent(result.content)}`;
    const reason = deterministicEditReason(rendered);
    if (!reason) return next();
    const isDuplicate = reason === 'ambiguous';
    const isUnread = reason === 'unread';
    const args = exec.arguments || {};
    const editPath = exec.name === 'edit' ? args.file_path : args.path;
    const oldText = exec.name === 'edit' ? args.old_string : args.old_str;
    if (typeof editPath !== 'string' || typeof oldText !== 'string') return next();
    failedExecutions.set(executionKey(exec), { reason, filePath: editPath, at: Date.now() });
    try {
      const cwd = exec.agent?.session.header.cwd;
      const target = await ctx.fs.resolve(editPath, { ...(cwd ? { cwd } : {}), signal: exec.signal });
      const content = await ctx.fs.readText(target, exec.signal);
      const excerpt = isDuplicate ? occurrenceContexts(content, oldText) : closestExcerpt(content, oldText);
      stats.editHints++;
      stats.lastRecoveryAt = Date.now();
      const guidance = isDuplicate
        ? 'OCUI found the repeated edit target and mapped its locations. Use surrounding lines from one match to make old_string unique; do not repeat the ambiguous edit:'
        : isUnread
          ? 'OCUI read the current file for diagnosis. The mutation tool still requires an explicit Read call for audit safety; read this file once, then retry against the current text below:'
          : 'OCUI recovery read the current file automatically. Rebuild the edit from this exact current excerpt, and do not repeat the stale old_string:';
      return {
        kind: 'accept',
        content: [...result.content, {
          type: 'text',
          text: `\n${guidance}\n\n${excerpt}`,
        }],
      };
    } catch {
      return next();
    }
  }, { global: true, prepend: true });

  return { snapshot: () => ({ ...stats, activeRetryChains: retryCounts.size, rememberedDeterministicFailures: failedExecutions.size }) };
}
