import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installResilience } from './resilience.js';
import { installWorkflowGuidance } from './workflow.js';

const DEFAULT_VISION_MODEL = 'deepseek-v4-flash-vision-exp';
const VISION_ALIAS = 'qwen-plus-latest';
const DEFAULT_VISION_PROVIDER = 'opencode-go';
const VISION_CONTEXT_PREFIX = '[Vision subagent context]';
const CATALOG_REFRESH_MS = 15 * 60 * 1000;

function rpcError(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

function unwrap(response) {
  return response && response.result ? response.result : rpcError('internal', 'Malformed API proxy response.');
}

function apiRequest(payload) {
  return { rpcId: `ocui-${Date.now()}-${Math.random().toString(36).slice(2)}`, payload };
}

function decodeBase64(data) {
  const decoded = Buffer.from(data, 'base64');
  if (!data || decoded.toString('base64') !== data) {
    const error = new Error('Image upload is not canonical base64.');
    error.code = 'INVALID_IMAGE_BASE64';
    throw error;
  }
  return new Uint8Array(decoded);
}

async function admitImages(attachments, images) {
  return attachments.saveImages(images.map((image) => ({
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...(image.name === undefined ? {} : { name: image.name }),
  })));
}

function attachmentKey(block) {
  const ref = block && block.attachment;
  return String(ref && (ref.id || ref.sha256 || ref.digest || ref.path || JSON.stringify(ref)));
}

function collectImagesFromContent(content, output = []) {
  if (!Array.isArray(content)) return output;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image' && block.attachment) output.push(block);
    if (block.type === 'tool-result') collectImagesFromContent(block.content, output);
  }
  return output;
}

function collectImages(messages) {
  const unique = new Map();
  for (const message of messages || []) {
    for (const image of collectImagesFromContent(message.content)) unique.set(attachmentKey(image), image);
  }
  return [...unique.values()];
}

function replaceImagesInContent(content, description) {
  let inserted = false;
  const visit = (blocks) => (blocks || []).map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'image') {
      if (inserted) return { type: 'text', text: '[Additional attached image covered by the vision context above.]' };
      inserted = true;
      return { type: 'text', text: `${VISION_CONTEXT_PREFIX}\n${description}\n[End vision subagent context]` };
    }
    if (block.type === 'tool-result') return { ...block, content: visit(block.content) };
    return block;
  });
  return visit(content);
}

function replaceImagesInMessages(messages, description) {
  let injected = false;
  return (messages || []).map((message) => {
    const before = collectImagesFromContent(message.content).length;
    if (!before) return message;
    const local = injected ? 'Images in this earlier message are covered by the existing vision context.' : description;
    injected = true;
    return { ...message, content: replaceImagesInContent(message.content, local) };
  });
}

function textFromBlocks(blocks) {
  const chunks = [];
  const visit = (items) => {
    for (const block of items || []) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') chunks.push(block.text);
      if (block.type === 'tool-result') visit(block.content);
    }
  };
  visit(blocks);
  return chunks.join('\n').trim();
}

function userTextFromWire(content) {
  return (content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

function conversationHint(messages) {
  const texts = [];
  for (const message of (messages || []).slice(-8)) {
    const value = textFromBlocks(message.content);
    if (value) texts.push(`${message.role}: ${value}`);
  }
  return texts.join('\n').slice(-8000);
}

function compareQwenPlus(a, b) {
  const version = (id) => {
    const hit = /^qwen([0-9]+(?:\.[0-9]+)*)-plus$/i.exec(id);
    return hit ? hit[1].split('.').map((part) => Number(part) || 0) : [];
  };
  const av = version(a.id);
  const bv = version(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (bv[i] || 0) - (av[i] || 0);
    if (delta) return delta;
  }
  return a.id.localeCompare(b.id);
}

export function apply(ctx, config = {}) {
  const visionProvider = config.visionProvider || DEFAULT_VISION_PROVIDER;
  const configuredVisionModel = config.visionModel || DEFAULT_VISION_MODEL;
  const visionMaxTokens = Number.isSafeInteger(config.visionMaxTokens) ? config.visionMaxTokens : 1600;
  const visionDescriptionChars = Number.isSafeInteger(config.visionDescriptionChars) ? config.visionDescriptionChars : 6000;
  const visionVisibleChars = Number.isSafeInteger(config.visionVisibleChars) ? config.visionVisibleChars : 1800;
  const resilience = installResilience(ctx, config);
  const workflow = installWorkflowGuidance(ctx);
  const descriptionCache = new Map();
  const descriptionInflight = new Map();
  const selectionRefs = new Map();
  const rewrittenRequests = new WeakSet();
  const activeVisionSessions = new Set();
  const delegatedToolContent = new Map();
  let visionRouteCache = null;

  const originalSessions = {
    models: ctx.apiProxy.sessions.models.bind(ctx.apiProxy.sessions),
    prompt: ctx.apiProxy.sessions.prompt.bind(ctx.apiProxy.sessions),
    selectModel: ctx.apiProxy.sessions.selectModel.bind(ctx.apiProxy.sessions),
  };
  const callOriginal = async (method, payload) => unwrap(await originalSessions[method](apiRequest(payload)));

  async function ensureAgent(sessionId) {
    let agent = ctx.agents.get(sessionId);
    if (agent) return { agent };
    const attached = await callOriginal('models', { sessionId });
    if (!attached.ok) return { error: attached };
    agent = ctx.agents.get(sessionId);
    return agent ? { agent } : { error: rpcError('internal', `Session ${sessionId} did not attach an agent.`) };
  }

  function installSelectionRef(agent, selected) {
    const sessionId = String(agent.session.id);
    const existing = selectionRefs.get(sessionId);
    if (existing) {
      existing.current = selected;
      return existing;
    }
    const ref = { current: selected, assembled: undefined };
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const captured = ref.current;
      const assembled = await next();
      ref.assembled = captured;
      if (!captured) return assembled;
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: captured.provider, model: captured.model },
      };
    }, { prepend: true });
    agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      const captured = ref.assembled;
      if (!captured) return resolved;
      const { reasoningEffort: _ignored, ...base } = resolved;
      return {
        ...base,
        provider: captured.provider,
        model: captured.model,
        ...(captured.reasoningEffort === undefined ? {} : { reasoningEffort: captured.reasoningEffort }),
      };
    }, { prepend: true });
    selectionRefs.set(sessionId, ref);
    return ref;
  }

  async function resolveVisionRoute(signal) {
    if (visionRouteCache) return visionRouteCache;
    const models = await ctx.llm.listModels(visionProvider);
    const candidates = [];
    if (configuredVisionModel !== VISION_ALIAS) {
      const exact = models.find((model) => model.id === configuredVisionModel) || { id: configuredVisionModel };
      candidates.push(exact);
    }
    candidates.push(...models.filter((model) => /^qwen[0-9]+(?:\.[0-9]+)*-plus$/i.test(model.id)).sort(compareQwenPlus));
    candidates.push(...models.filter((model) => !candidates.some((candidate) => candidate.id === model.id)));
    for (const candidate of candidates) {
      try {
        const info = await ctx.llm.resolveModelInfo(visionProvider, candidate.id, signal);
        if (info.inputModalities && info.inputModalities.includes('image')) {
          visionRouteCache = { provider: visionProvider, model: candidate.id, name: info.name || candidate.name || candidate.id };
          return visionRouteCache;
        }
      } catch (error) {
        ctx.logger.debug(`ocui vision: skipped ${visionProvider}/${candidate.id}: ${String(error)}`);
      }
    }
    throw new Error(`No image-capable model is available on ${visionProvider}.`);
  }

  async function describeImages(parent, images, userHint, signal) {
    const keys = images.map(attachmentKey).sort();
    const cacheKey = keys.join('|');
    const cached = descriptionCache.get(cacheKey);
    if (cached) return cached;
    if (descriptionInflight.has(cacheKey)) return descriptionInflight.get(cacheKey);
    const pending = (async () => {
      const route = await resolveVisionRoute(signal);
      const numbered = images.map((image, index) => ({
        ...image,
        attachment: image.attachment,
        _visionIndex: index + 1,
      })).map(({ _visionIndex, ...image }) => image);
      const instruction = [
        'You are a vision analyst working as a subagent for another coding assistant.',
        `Analyze all ${images.length} attached image${images.length === 1 ? '' : 's'} and return a self-contained, high-fidelity textual description.`,
        'Preserve visible text exactly when important (UI labels, errors, code, numbers), describe layout and spatial relationships, and identify details relevant to the user request.',
        'If multiple images are attached, label them Image 1, Image 2, and compare them when useful.',
        'Do not modify files or use tools. Return only the visual analysis that the parent agent needs.',
        userHint ? `User/conversation context:\n${userHint}` : '',
      ].filter(Boolean).join('\n\n');
      const run = await ctx.subagents.start('spawn', {
        label: `Vision · ${route.name}`,
        prompt: [{ type: 'text', text: instruction }, ...numbered],
        parent,
        signal,
        agentOptions: { provider: route.provider, model: route.model, maxTokens: visionMaxTokens },
      });
      activeVisionSessions.add(String(run.id));
      try {
        const result = await run.result;
        const output = textFromBlocks(result.output);
        if (!output) throw new Error(result.diagnostic || `Vision subagent stopped with ${result.stopReason}.`);
        const value = { text: output.slice(0, visionDescriptionChars), route };
        descriptionCache.set(cacheKey, value);
        return value;
      } finally {
        activeVisionSessions.delete(String(run.id));
        await run.dispose();
      }
    })();
    descriptionInflight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      descriptionInflight.delete(cacheKey);
    }
  }

  async function describeImagePath(parent, filePath, signal) {
    const route = await resolveVisionRoute(signal);
    const instruction = [
      'You are the vision worker for a text-only parent coding agent.',
      `Use read_image on this exact workspace path: ${filePath}`,
      'Return a self-contained, high-fidelity description for the parent. Preserve important visible text exactly, describe layout and spatial relationships, and call out details relevant to coding or UI work.',
      'Do not modify files. Return only the visual analysis.',
    ].join('\n\n');
    const run = await ctx.subagents.start('spawn', {
      label: `Vision · ${route.name}`,
      prompt: [{ type: 'text', text: instruction }],
      parent,
      signal,
      agentOptions: { provider: route.provider, model: route.model, maxTokens: visionMaxTokens },
    });
    activeVisionSessions.add(String(run.id));
    try {
      const result = await run.result;
      const output = textFromBlocks(result.output);
      if (!output) throw new Error(result.diagnostic || `Vision subagent stopped with ${result.stopReason}.`);
      return { text: output, route };
    } finally {
      activeVisionSessions.delete(String(run.id));
      await run.dispose();
    }
  }

  async function proxyPrompt(payload, signal) {
    const images = (payload.content || []).filter((part) => part.type === 'image');
    if (!images.length) return callOriginal('prompt', payload);
    const found = await ensureAgent(payload.sessionId);
    if (found.error) return found.error;
    try {
      const refs = await admitImages(ctx.attachments, images);
      let nextRef = 0;
      const durableImages = payload.content.filter((part) => part.type === 'image').map(() => ({
        type: 'image',
        attachment: refs[nextRef++],
      }));
      const analysis = await describeImages(found.agent, durableImages, userTextFromWire(payload.content), signal);
      let imageIndex = 0;
      const translated = payload.content.map((part) => part.type === 'image'
        ? { type: 'text', text: `[Attached Image ${++imageIndex} was analyzed by ${analysis.route.name}.]` }
        : part);
      translated.push({
        type: 'text',
        text: `${VISION_CONTEXT_PREFIX}\n${analysis.text.slice(0, visionVisibleChars)}${analysis.text.length > visionVisibleChars ? '\n[Full visual analysis retained by the bridge; visible summary truncated.]' : ''}\n[End vision subagent context]`,
      });
      return callOriginal('prompt', { ...payload, content: translated });
    } catch (error) {
      const reason = error && error.code ? String(error.code) : 'VISION_PROXY_FAILED';
      return rpcError('attachment-error', `Vision proxy could not analyze the attached image: ${String(error && error.message || error)}`, { reason });
    }
  }

  async function selectModel(payload) {
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.provider !== 'string' || typeof payload.model !== 'string') {
      return rpcError('bad-request', 'Invalid model selection payload.');
    }
    const found = await ensureAgent(payload.sessionId);
    if (found.error) return found.error;
    try {
      const resolved = await ctx.llm.resolveCallConfig({
        provider: payload.provider,
        model: payload.model,
        ...(payload.reasoningEffort === undefined ? {} : { reasoningEffort: payload.reasoningEffort }),
      });
      const selected = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      };
      installSelectionRef(found.agent, selected);
      try { await ctx.agentDefaultModel.saveSelection(selected); }
      catch (error) { ctx.logger.warn(`ocui vision: model switched for this session but default save failed: ${String(error)}`); }
      return { ok: true, value: { selected: { ...selected } } };
    } catch (error) {
      return rpcError('model-unavailable', String(error && error.message || error), { provider: payload.provider, model: payload.model });
    }
  }

  ctx.effect(() => {
    ctx.apiProxy.sessions.prompt = async (request) => ({
      rpcId: request.rpcId,
      result: await proxyPrompt(request.payload, new AbortController().signal),
    });
    ctx.apiProxy.sessions.selectModel = async (request) => ({
      rpcId: request.rpcId,
      result: await selectModel(request.payload),
    });
    ctx.apiProxy.sessions.models = async (request) => {
      const response = await originalSessions.models(request);
      const ref = request.payload && selectionRefs.get(String(request.payload.sessionId));
      if (!response.result.ok || !ref || !ref.current) return response;
      return {
        rpcId: request.rpcId,
        result: { ok: true, value: { ...response.result.value, current: { ...ref.current } } },
      };
    };
    return () => {
      ctx.apiProxy.sessions.prompt = originalSessions.prompt;
      ctx.apiProxy.sessions.selectModel = originalSessions.selectModel;
      ctx.apiProxy.sessions.models = originalSessions.models;
    };
  }, 'ocui: vision-aware session API');

  ctx.on('llm/stream', (options, next) => {
    if (rewrittenRequests.has(options) || !options.sessionId || activeVisionSessions.has(String(options.sessionId))) return next();
    const images = collectImages(options.messages);
    if (!images.length) return next();
    return (async function* translateLegacyImages() {
      const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
      if (!info.inputModalities || info.inputModalities.includes('image')) {
        yield* next();
        return;
      }
      const parent = ctx.agents.get(options.sessionId);
      if (!parent) {
        yield* next();
        return;
      }
      const analysis = await describeImages(parent, images, conversationHint(options.messages), options.signal || new AbortController().signal);
      const rewritten = { ...options, messages: replaceImagesInMessages(options.messages, analysis.text) };
      rewrittenRequests.add(rewritten);
      yield* ctx.llm.stream(rewritten);
    })();
  }, { global: true, prepend: true });

  ctx.on('llm/adapters-updated', () => {
    visionRouteCache = null;
  });

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'read_image' || activeVisionSessions.has(String(exec.agent?.session.id))) return next();
    const routed = exec.agent?.session.requestHeader()?.config;
    const provider = routed?.provider ?? exec.agent?.options.provider;
    const model = routed?.model ?? exec.agent?.options.model;
    if (!provider || !model || !exec.agent) return next();
    const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal);
    if (info.inputModalities?.includes('image')) return next();
    const filePath = exec.arguments && typeof exec.arguments === 'object' && typeof exec.arguments.file_path === 'string'
      ? exec.arguments.file_path
      : '';
    if (!filePath.trim()) return next();
    const analysis = await describeImagePath(exec.agent, filePath, exec.signal);
    const text = [
      `[Image analyzed automatically by ${analysis.route.name} for text-only model ${model}.]`,
      analysis.text,
    ].join('\n\n');
    delegatedToolContent.set(String(exec.callId), [{ type: 'text', text }]);
    return {
      isError: false,
      // The around-dispatch contract still validates replacements against the
      // intercepted tool's canonical output schema. Keep that execution-local
      // value schema-compatible while projecting only the worker's text to the
      // text-only parent model.
      value: {
        path: filePath,
        image: {
          attachmentId: `delegated-vision-${Date.now()}`,
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
          name: 'delegated-vision-description.txt',
        },
      },
      content: [{ type: 'text', text }],
      meta: { delegatedVision: true, provider: analysis.route.provider, model: analysis.route.model },
    };
  }, { global: true, prepend: true });

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const key = String(exec.callId);
    const content = delegatedToolContent.get(key);
    if (!content) return next();
    delegatedToolContent.delete(key);
    return { kind: 'accept', content };
  }, { global: true, prepend: true });

  let catalogSyncRunning = false;
  async function refreshCatalog() {
    if (catalogSyncRunning) return;
    catalogSyncRunning = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 60_000);
    try {
      const script = join(homedir(), '.dsh', 'sync-dsh-models.py');
      const bundledPython = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
      const candidates = [];
      if (existsSync(bundledPython)) candidates.push(bundledPython);
      try { candidates.push(await ctx.subprocess.resolveExecutable('python', undefined, abort.signal)); }
      catch { /* A bundled runtime may still be available. */ }
      if (!candidates.length) throw new Error('No Python runtime is available for sync-dsh-models.py');
      let lastError;
      for (const python of [...new Set(candidates)]) {
        try {
          const handle = ctx.subprocess.spawn({
            argv: [python, script, '--quiet'],
            cwd: homedir(),
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 16_384 },
              stderr: { maxBytes: 16_384 },
            },
            graceMs: 2_000,
            signal: abort.signal,
          });
          const outcome = await handle.done;
          if (outcome.exitCode === 0) { lastError = undefined; break; }
          const detail = handle.collected.stderr?.readFrom(0).text.trim();
          lastError = new Error(detail || `Python exited with ${outcome.exitCode}`);
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      ctx.logger.warn(`ocui catalog refresh could not run: ${String(error && error.message || error)}`);
    } finally {
      clearTimeout(timeout);
      catalogSyncRunning = false;
    }
  }

  ctx.effect(() => {
    const stopInitial = ctx.timer.setTimeout(() => void refreshCatalog(), 3_000);
    const stopInterval = ctx.timer.setInterval(() => void refreshCatalog(), CATALOG_REFRESH_MS);
    return () => { stopInitial(); stopInterval(); };
  }, 'ocui: automatic OpenCode catalog refresh');

  // OpenCode Go usage limits used by the sidebar UI.

  let cache = null;
  let cacheAt = 0;
  let inflight = null;
  let gen = 0;

  ctx.connection.rpc.handle('/ocui', async (endpoint) => {
    if (endpoint === 'status') return { ok: true, value: { ok: true, resilience: resilience.snapshot(), workflow: workflow.snapshot(), vision: { provider: visionProvider, configuredModel: configuredVisionModel, route: visionRouteCache } } };
    if (endpoint !== 'usage') return rpcError('internal', 'unknown OCUI endpoint: ' + endpoint);
    if (cache && Date.now() - cacheAt < 30000) return { ok: true, value: cache };
    if (inflight) return inflight;
    const mine = ++gen;
    inflight = (async () => {
      let result;
      try {
        const credential = await ctx.credentials.resolve('OPENCODE_GO_API_KEY');
        if (!credential) throw new Error('OpenCode Go credential is not configured in DSH');
        const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
          headers: { Authorization: `Bearer ${credential.value}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`OpenCode usage endpoint returned HTTP ${response.status}`);
        const payload = await response.json();
        result = payload && payload.usage
          ? { ok: true, usage: payload.usage }
          : { ok: false, error: 'OpenCode usage endpoint returned no usage windows' };
      } catch (error) {
        result = { ok: false, error: String(error && error.message || error) };
      }
      if (mine === gen) { cache = result; cacheAt = Date.now(); }
      return { ok: true, value: result };
    })();
    try { return await inflight; } finally { inflight = null; }
  }, { authority: 'loopback' });
}

export const inject = [
  'agentDefaultModel', 'agents', 'apiProxy', 'attachments', 'connection', 'credentials',
  'fs', 'llm', 'subagents', 'subprocess', 'timer', 'tools',
];
