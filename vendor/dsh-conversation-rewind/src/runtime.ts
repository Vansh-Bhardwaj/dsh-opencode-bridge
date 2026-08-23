import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createUserMessage,
  ReasoningEffortId,
  type LlmCallConfig,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  foldSurface,
  isReplacementSurfaceEvent,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  buildRewindPlan,
  ConversationRewindError,
  isRegeneratedContext,
  listEditableMessages,
  listHiddenRanges,
  projectBranchTree,
  projectModel,
  queryConversationBranch,
  REWIND_MARKER_KIND,
  REWIND_MARKER_MODEL,
  REWIND_MARKER_PROVIDER,
  REWIND_MARKER_VERSION,
  type RewindReplayMarker,
} from './core.ts'
import type {
  RewindBranchSelectRequest,
  RewindBranchSelectResult,
  RewindBusinessResult,
  RewindRequest,
  RewindResult,
  RewindSessionView,
} from './protocol.ts'

export const REWIND_TRIGGER_KIND = 'dsh-conversation-rewind-trigger'
export const REWIND_TRIGGER_VERSION = 1

/** Durable transaction payload carried by the internal request guard message. */
export interface RewindTriggerSource {
  kind: typeof REWIND_TRIGGER_KIND
  version: typeof REWIND_TRIGGER_VERSION
  transactionId: string
  targetSeq: number
  surfaceNodes: number[]
  followups: UserMessage[]
}

const REWIND_REPLAY_MARKER_KEYS = [
  'kind',
  'version',
  'transactionId',
  'targetSeq',
  'mode',
] as const

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-conversation-rewind-trigger': RewindTriggerSource
  }
}

interface RewindCommit {
  replacementSeq: number
  shadowedMessages: number
}

type RequestOutcome =
  | { ok: true; value: RewindCommit }
  | { ok: false; value: ConversationRewindError }

interface ActiveTransaction {
  source: RewindTriggerSource
  outcome?: RequestOutcome
}

interface TriggerRecord {
  source: RewindTriggerSource
  message: UserMessage
}

const activeRewinds = new WeakSet<Agent>()
const activeTransactions = new WeakMap<Agent, ActiveTransaction>()
const recoveringAgents = new WeakSet<Agent>()
const guardedContexts = new WeakSet<Context>()

function errorResult<T>(error: ConversationRewindError): RewindBusinessResult<T> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details?.sessionId === undefined ? {} : { sessionId: error.details.sessionId }),
      ...(error.details?.replacementSeq === undefined
        ? {}
        : { replacementSeq: error.details.replacementSeq }),
    },
  }
}

function internalError<T>(ctx: Context, operation: string, cause: unknown): RewindBusinessResult<T> {
  ctx.logger.error(
    `dsh-conversation-rewind ${operation}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
  )
  return {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: `conversation rewind ${operation} failed` },
  }
}

async function readSource(ctx: Context, sessionId: string): Promise<SessionLogSnapshot> {
  try {
    return await ctx.sessionQuery.readSession(SessionId(sessionId))
  } catch (cause: unknown) {
    if (!(cause instanceof SessionQueryError) || cause.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw cause
    throw new ConversationRewindError(
      'SESSION_NOT_FOUND',
      `session "${sessionId}" is unavailable`,
      404,
    )
  }
}

function liveAgent(ctx: Context, sessionId: string): Agent {
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) {
    throw new ConversationRewindError(
      'SESSION_NOT_LIVE',
      'editing history requires the Session to be open and live in this DSH process',
      409,
    )
  }
  return agent
}

function assertOwned(ctx: Context, agent: Agent): void {
  if (ctx.agents.get(agent.id) !== agent) {
    throw new ConversationRewindError(
      'SESSION_NOT_LIVE',
      'the live Session changed while preparing the edit; reopen it and retry',
      409,
    )
  }
}

function snapshotOf(agent: Agent): { session: Agent['session']['header']; events: SessionEvent[] } {
  return { session: agent.session.header, events: [...agent.session.events] }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
}

function ownsPrefix(agent: Agent, messages: readonly UserMessage[]): boolean {
  return messages.every((message, index) => agent.inbox.nextTurn[index]?.id === message.id)
}

function ownsEntireInbox(agent: Agent, messages: readonly UserMessage[]): boolean {
  return agent.inbox.nextStep.length === 0
    && agent.inbox.nextTurn.length === messages.length
    && ownsPrefix(agent, messages)
}

function removeMessages(agent: Agent, messages: readonly UserMessage[]): void {
  for (const message of messages) agent.inbox.remove(message.id)
}

function insertIndividually(agent: Agent, start: number, messages: readonly UserMessage[]): void {
  messages.forEach((message, index) => {
    agent.inbox.splice('next-turn', start + index, 0, [message])
  })
}

function wakeWithRemovedToken(agent: Agent, transactionId: string): void {
  const wakeToken = createUserMessage({
    content: [{ type: 'text', text: `conversation-rewind-wake-${transactionId}` }],
    source: { kind: 'plugin', plugin: 'dsh-conversation-rewind' },
  })
  agent.send(wakeToken, 'next-turn', true)
  agent.inbox.remove(wakeToken.id)
}

function isPlainFollowup(value: unknown): value is UserMessage {
  if (value === null || typeof value !== 'object') return false
  const message = value as Partial<UserMessage>
  if (typeof message.id !== 'string' || message.id === '' || message.role !== 'user') return false
  if (message.source?.kind !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) return false
  const block = message.content[0]
  return block?.type === 'text' && typeof block.text === 'string'
}

/** Validate untrusted durable source data before it can cancel an Agent request. */
export function rewindTriggerSource(message: UserMessage): RewindTriggerSource | undefined {
  const source = message.source as Partial<RewindTriggerSource>
  if (
    source.kind !== REWIND_TRIGGER_KIND
    || source.version !== REWIND_TRIGGER_VERSION
    || typeof source.transactionId !== 'string'
    || source.transactionId === ''
    || !Number.isSafeInteger(source.targetSeq)
    || (source.targetSeq ?? -1) < 0
    || !Array.isArray(source.surfaceNodes)
    || source.surfaceNodes.length === 0
    || !source.surfaceNodes.every(seq => Number.isSafeInteger(seq) && seq >= 0)
    || new Set(source.surfaceNodes).size !== source.surfaceNodes.length
    || !source.surfaceNodes.includes(source.targetSeq ?? -1)
    || !Array.isArray(source.followups)
    || !source.followups.every(isPlainFollowup)
  ) return undefined
  return source as RewindTriggerSource
}

function marker(
  transactionId: string,
  targetSeq: number,
  mode: RewindReplayMarker['mode'],
): RewindReplayMarker {
  return {
    kind: REWIND_MARKER_KIND,
    version: REWIND_MARKER_VERSION,
    transactionId,
    targetSeq,
    mode,
  }
}

function markerOf(event: SessionEvent): RewindReplayMarker | undefined {
  if (event.type !== 'assistant/message' || !isReplacementSurfaceEvent(event)) return undefined
  const message = event.data.message
  if (
    message.content.length !== 0
    || message.source.provider !== REWIND_MARKER_PROVIDER
    || message.source.model !== REWIND_MARKER_MODEL
  ) return undefined
  const replayState = message.source.replayState
  if (replayState === null || typeof replayState !== 'object') return undefined
  const candidate = replayState as Partial<RewindReplayMarker>
  if (
    !hasExactOwnKeys(replayState, REWIND_REPLAY_MARKER_KEYS)
    || candidate.kind !== REWIND_MARKER_KIND
    || candidate.version !== REWIND_MARKER_VERSION
    || typeof candidate.transactionId !== 'string'
    || candidate.transactionId === ''
    || !Number.isSafeInteger(candidate.targetSeq)
    || (candidate.targetSeq ?? -1) < 0
    || (candidate.mode !== 'rewind' && candidate.mode !== 'cleanup')
  ) return undefined
  const sourceEventSeqs = event.sourceEventSeqs
  if (
    sourceEventSeqs === undefined
    || event.surfaceOp.start !== candidate.targetSeq
    || sourceEventSeqs[0] !== event.surfaceOp.start
    || sourceEventSeqs.at(-1) !== event.surfaceOp.end
  ) return undefined
  return candidate as RewindReplayMarker
}

function replacementFor(
  events: readonly SessionEvent[],
  transactionId: string,
  mode?: RewindReplayMarker['mode'],
): SessionEvent<'assistant/message'> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const replay = markerOf(event)
    if (replay?.transactionId === transactionId && (mode === undefined || replay.mode === mode)) return event
  }
  return undefined
}

function fallbackConfig(agent: Agent): LlmCallConfig {
  const model = projectModel(agent.session.events)
  return {
    provider: agent.options.provider ?? model?.provider ?? 'dsh-conversation-rewind',
    model: agent.options.model ?? model?.model ?? 'surface-rewind',
    ...(model?.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model?.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
  }
}

function appendReplacement(
  agent: Agent,
  position: { turn: number; step: number },
  transactionId: string,
  targetSeq: number,
  nodes: readonly number[],
  mode: RewindReplayMarker['mode'],
): number {
  const endSeq = nodes.at(-1)
  if (endSeq === undefined) throw new Error('conversation rewind replacement has no surface nodes')
  return agent.session.append(
    'assistant/message',
    {
      ...position,
      message: createAssistantMessage({
        content: [],
        source: {
          provider: REWIND_MARKER_PROVIDER,
          model: REWIND_MARKER_MODEL,
          replayState: marker(transactionId, targetSeq, mode),
        },
      }),
    },
    {
      surfaceOp: { op: 'replace', start: targetSeq, end: endSeq },
      sourceEventSeqs: [...nodes],
    },
  ).seq
}

function surfaceSnapshot(agent: Agent): { nodes: number[]; events: SessionEvent[] } {
  const events = [...agent.session.events]
  return { nodes: [...foldSurface(events).nodes], events }
}

function isTransactionTrigger(event: SessionEvent | undefined, transactionId: string): boolean {
  return event?.type === 'user/message'
    && rewindTriggerSource(event.data)?.transactionId === transactionId
}

function safeTransactionTail(
  tailNodes: readonly number[],
  events: readonly SessionEvent[],
  transactionId: string,
): boolean {
  if (tailNodes.length === 0 || !isTransactionTrigger(events[tailNodes[0]], transactionId)) return false
  return tailNodes.every((seq) => {
    const event = events[seq]
    return event?.type === 'user/message'
      && (isTransactionTrigger(event, transactionId) || isRegeneratedContext(event))
  })
}

function pendingIds(agent: Agent): Set<string> {
  return new Set([
    ...agent.inbox.nextTurn.map(message => String(message.id)),
    ...agent.inbox.nextStep.map(message => String(message.id)),
  ])
}

function requeueShadowedMessages(
  agent: Agent,
  nodes: readonly number[],
  events: readonly SessionEvent[],
): void {
  const pending = pendingIds(agent)
  const messages = nodes.flatMap((seq): UserMessage[] => {
    const event = events[seq]
    if (event?.type !== 'user/message') return []
    if (rewindTriggerSource(event.data) !== undefined || isRegeneratedContext(event)) return []
    if (pending.has(String(event.data.id))) return []
    pending.add(String(event.data.id))
    return [event.data]
  })
  insertIndividually(agent, 0, messages)
}

function appendCleanup(
  agent: Agent,
  source: RewindTriggerSource,
  position: { turn: number; step: number },
): number | undefined {
  const current = surfaceSnapshot(agent)
  const startIndex = current.nodes.findIndex(seq => isTransactionTrigger(current.events[seq], source.transactionId))
  if (startIndex < 0) return undefined
  const nodes = current.nodes.slice(startIndex)
  requeueShadowedMessages(agent, nodes, current.events)
  const startSeq = nodes[0]
  return startSeq === undefined
    ? undefined
    : appendReplacement(
        agent,
        position,
        source.transactionId,
        startSeq,
        nodes,
        'cleanup',
      )
}

function currentStepTriggers(agent: Agent, turn: number, step: number): TriggerRecord[] {
  const events = agent.session.events
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'step/start' && event.data.turn === turn && event.data.step === step) {
      start = index
      break
    }
  }
  if (start < 0) return []
  return events.slice(start + 1).flatMap((event): TriggerRecord[] => {
    if (event.type !== 'user/message') return []
    const source = rewindTriggerSource(event.data)
    return source === undefined ? [] : [{ source, message: event.data }]
  })
}

function sourceChanged(message: string): ConversationRewindError {
  return new ConversationRewindError('SOURCE_CHANGED', message, 409)
}

function requestOutcome(
  agent: Agent,
  source: RewindTriggerSource,
  position: { turn: number; step: number },
  signal: AbortSignal,
): RequestOutcome {
  const committed = replacementFor(agent.session.events, source.transactionId, 'rewind')
  if (committed !== undefined) {
    appendCleanup(agent, source, position)
    return {
      ok: true,
      value: {
        replacementSeq: committed.seq,
        shadowedMessages: source.surfaceNodes.length - source.surfaceNodes.indexOf(source.targetSeq),
      },
    }
  }

  const current = surfaceSnapshot(agent)
  const prefix = current.nodes.slice(0, source.surfaceNodes.length)
  const tail = current.nodes.slice(source.surfaceNodes.length)
  if (
    signal.aborted
    || !ownsEntireInbox(agent, [])
    || !sameNumbers(prefix, source.surfaceNodes)
    || !safeTransactionTail(tail, current.events, source.transactionId)
  ) {
    appendCleanup(agent, source, position)
    return {
      ok: false,
      value: sourceChanged('the Session surface or inbox changed before the edit could be committed; retry'),
    }
  }

  const targetIndex = current.nodes.indexOf(source.targetSeq)
  if (targetIndex < 0) {
    appendCleanup(agent, source, position)
    return { ok: false, value: sourceChanged('the selected message left the active Session surface; retry') }
  }
  const nodes = current.nodes.slice(targetIndex)
  const replacementSeq = appendReplacement(
    agent,
    position,
    source.transactionId,
    source.targetSeq,
    nodes,
    'rewind',
  )
  return {
    ok: true,
    value: { replacementSeq, shadowedMessages: source.surfaceNodes.length - targetIndex },
  }
}

async function guardedRequest(
  ctx: Context,
  payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>,
): Promise<LlmCallConfig> {
  const { agent, turn, step, signal } = payload
  const active = activeTransactions.get(agent)
  const triggers = currentStepTriggers(agent, turn, step)
  const source = active === undefined
    ? triggers[0]?.source
    : triggers.find(record => record.source.transactionId === active.source.transactionId)?.source
  if (source === undefined) return next()

  // Never delegate an internal trigger to downstream request hooks. They may
  // wait indefinitely or perform unrelated side effects; the current durable
  // route is sufficient provenance for an empty replacement marker.
  const config = fallbackConfig(agent)

  let outcome: RequestOutcome
  try {
    outcome = requestOutcome(agent, source, { turn, step }, signal)
  } catch (cause: unknown) {
    try {
      appendCleanup(agent, source, { turn, step })
    } catch (cleanupCause: unknown) {
      ctx.logger.error(
        `dsh-conversation-rewind cleanup ${agent.id}: ${cleanupCause instanceof Error ? cleanupCause.stack ?? cleanupCause.message : String(cleanupCause)}`,
      )
    }
    outcome = {
      ok: false,
      value: cause instanceof ConversationRewindError
        ? cause
        : sourceChanged('the Session changed while committing the surface rewind; retry'),
    }
    ctx.logger.error(
      `dsh-conversation-rewind replacement ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
    )
  } finally {
    // The guard's primary contract is fail-closed. Cancellation happens for
    // every recognized transaction, even when config resolution or cleanup fails.
    agent.cancel({ kind: 'hook', reason: 'conversation-rewind' }, { keepInbox: true })
  }

  if (active !== undefined && active.source.transactionId === source.transactionId) {
    active.outcome ??= outcome
  } else {
    scheduleRecovery(ctx, agent)
  }
  return config
}

function triggerRecords(events: readonly SessionEvent[]): Map<string, TriggerRecord> {
  const records = new Map<string, TriggerRecord>()
  const remember = (message: UserMessage): void => {
    const source = rewindTriggerSource(message)
    if (source !== undefined) records.set(source.transactionId, { source, message })
  }
  for (const event of events) {
    if (event.type === 'user/message') remember(event.data)
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) remember(message)
    }
  }
  return records
}

/** Exclude fork-inherited parent history from this Session's recovery domain. */
function recoveryEvents(agent: Agent): readonly SessionEvent[] {
  return agent.session.events.slice(agent.session.header.seedLength ?? 0)
}

function idsConsumedAfter(events: readonly SessionEvent[], seq: number): Set<string> {
  const ids = new Set<string>()
  for (const event of events.slice(seq + 1)) {
    if (event.type === 'user/message') ids.add(String(event.data.id))
  }
  return ids
}

async function recoverQueuedFollowups(
  ctx: Context,
  agent: Agent,
  record: TriggerRecord,
  replacementSeq: number,
): Promise<void> {
  const events = [...agent.session.events]
  const consumed = idsConsumedAfter(events, replacementSeq)
  const desiredIds = new Set(record.source.followups.map(message => String(message.id)))
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter(message => desiredIds.has(String(message.id)))
  const pendingSet = new Set(pending.map(message => String(message.id)))
  const missing = record.source.followups.filter(message => (
    !pendingSet.has(String(message.id)) && !consumed.has(String(message.id))
  ))
  if (missing.length === 0 && pending.length === 0) return

  await agent.runMaintenance(async (signal) => {
    signal.throwIfAborted()
    if (activeRewinds.has(agent) || activeTransactions.has(agent)) return
    assertOwned(ctx, agent)
    if (missing.length > 0) {
      const unconsumed = record.source.followups.filter(message => !consumed.has(String(message.id)))
      removeMessages(agent, pending)
      insertIndividually(agent, 0, unconsumed)
      await ctx.sessions.flush(agent.session)
    }
    const currentPending = agent.inbox.nextTurn.some(message => desiredIds.has(String(message.id)))
    if (currentPending) wakeWithRemovedToken(agent, record.source.transactionId)
  })
}

function recoverableOrphan(agent: Agent, source: RewindTriggerSource): boolean {
  const current = surfaceSnapshot(agent)
  const prefix = current.nodes.slice(0, source.surfaceNodes.length)
  const tail = current.nodes.slice(source.surfaceNodes.length)
  return sameNumbers(prefix, source.surfaceNodes)
    && (tail.length === 0 || safeTransactionTail(tail, current.events, source.transactionId))
}

async function recoverOrphanTrigger(ctx: Context, agent: Agent, record: TriggerRecord): Promise<void> {
  if (agent.inbox.nextStep.length > 0 || !recoverableOrphan(agent, record.source)) {
    ctx.logger.error(
      `dsh-conversation-rewind parked orphan ${record.source.transactionId} in ${agent.id}: Session surface is no longer recovery-safe`,
    )
    return
  }
  await agent.runMaintenance(async (signal) => {
    signal.throwIfAborted()
    if (activeRewinds.has(agent) || activeTransactions.has(agent)) return
    assertOwned(ctx, agent)
    const pendingTriggers = agent.inbox.nextTurn.filter(message => (
      rewindTriggerSource(message)?.transactionId === record.source.transactionId
    ))
    removeMessages(agent, pendingTriggers)
    agent.inbox.splice('next-turn', 0, 0, [record.message])
    await ctx.sessions.flush(agent.session)
    wakeWithRemovedToken(agent, record.source.transactionId)
  })
}

async function recoverAgent(ctx: Context, agent: Agent): Promise<void> {
  if (recoveringAgents.has(agent) || activeRewinds.has(agent) || activeTransactions.has(agent)) return
  recoveringAgents.add(agent)
  try {
    await agent.whenIdle()
    if (activeRewinds.has(agent) || activeTransactions.has(agent)) return
    assertOwned(ctx, agent)
    const events = recoveryEvents(agent)
    const records = triggerRecords(events)
    for (const record of records.values()) {
      const cleanup = replacementFor(events, record.source.transactionId, 'cleanup')
      const replacement = replacementFor(events, record.source.transactionId, 'rewind')
      if (replacement !== undefined) {
        await recoverQueuedFollowups(ctx, agent, record, replacement.seq)
      } else if (
        cleanup === undefined
        && (
          agent.inbox.nextTurn.some(message => message.id === record.message.id)
          || events.some(event => (
            event.type === 'user/message' && event.data.id === record.message.id
          ))
        )
      ) {
        await recoverOrphanTrigger(ctx, agent, record)
      }
      if (agent.status !== 'idle') {
        scheduleRecovery(ctx, agent)
        return
      }
    }
  } catch (cause: unknown) {
    ctx.logger.error(
      `dsh-conversation-rewind recovery ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
    )
  } finally {
    recoveringAgents.delete(agent)
  }
}

function scheduleRecovery(ctx: Context, agent: Agent): void {
  void agent.whenIdle().then(
    () => recoverAgent(ctx, agent),
    (cause: unknown) => {
      ctx.logger.error(
        `dsh-conversation-rewind recovery wait ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
      )
    },
  )
}

/** Install the permanent fail-closed trigger guard and orphan recovery hooks once per Context. */
export function installConversationRewindGuard(ctx: Context): void {
  if (guardedContexts.has(ctx)) return
  guardedContexts.add(ctx)
  ctx.on('agent/request', (payload, next) => guardedRequest(ctx, payload, next), { global: true })
  ctx.on('agent/created', ({ agent }) => { scheduleRecovery(ctx, agent) }, { global: true })
  for (const agent of ctx.agents.list()) scheduleRecovery(ctx, agent)
}

async function cleanupBeforeReplacement(
  ctx: Context,
  agent: Agent,
  trigger: UserMessage | undefined,
  operation: string,
): Promise<void> {
  if (trigger !== undefined) agent.inbox.remove(trigger.id)
  try {
    await ctx.sessions.flush(agent.session)
  } catch (cause: unknown) {
    ctx.logger.error(
      `dsh-conversation-rewind ${operation} cleanup checkpoint ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
    )
  }
}

async function cleanupQueuedMessages(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[],
  operation: string,
): Promise<void> {
  removeMessages(agent, messages)
  try {
    await ctx.sessions.flush(agent.session)
  } catch (cause: unknown) {
    ctx.logger.error(
      `dsh-conversation-rewind ${operation} cleanup checkpoint ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
    )
  }
}

function partialError(agent: Agent, replacementSeq: number, message: string): ConversationRewindError {
  return new ConversationRewindError(
    'REWIND_PARTIAL',
    message,
    500,
    { sessionId: agent.id, replacementSeq },
  )
}

async function queueEditedPath(
  ctx: Context,
  agent: Agent,
  source: RewindTriggerSource,
  replacementSeq: number,
): Promise<void> {
  await agent.runMaintenance(async (signal) => {
    signal.throwIfAborted()
    assertOwned(ctx, agent)
    if (replacementFor(agent.session.events, source.transactionId, 'rewind')?.seq !== replacementSeq) {
      throw partialError(
        agent,
        replacementSeq,
        'the original Session was rewound, but its replacement checkpoint changed before the edited prompt could be queued',
      )
    }
    if (!ownsEntireInbox(agent, [])) {
      throw partialError(
        agent,
        replacementSeq,
        'the original Session was rewound, but another pending message arrived before the edited prompt could be queued',
      )
    }
    try {
      // Keep insertion inside the cleanup boundary.  Inbox listeners are
      // synchronous and can reject or mutate a splice before it returns.
      removeMessages(agent, source.followups)
      insertIndividually(agent, 0, source.followups)
      if (!ownsEntireInbox(agent, source.followups)) {
        throw partialError(
          agent,
          replacementSeq,
          'the original Session was rewound, but its edited prompt moved before it could be sent',
        )
      }
      await ctx.sessions.flush(agent.session)
      signal.throwIfAborted()
      assertOwned(ctx, agent)
      if (!ownsPrefix(agent, source.followups) || agent.inbox.nextStep.length > 0) {
        throw partialError(
          agent,
          replacementSeq,
          'the original Session was rewound, but its edited prompt changed while being checkpointed',
        )
      }

      wakeWithRemovedToken(agent, source.transactionId)
      signal.throwIfAborted()
      if (!ownsEntireInbox(agent, source.followups)) {
        throw partialError(
          agent,
          replacementSeq,
          'the original Session was rewound, but another message arrived while waking its edited prompt',
        )
      }
      // The wake token's insertion and removal are durable inbox events.  Do
      // not release maintenance until that pair has reached persistence.
      await ctx.sessions.flush(agent.session)
      signal.throwIfAborted()
      assertOwned(ctx, agent)
      if (!ownsEntireInbox(agent, source.followups)) {
        throw partialError(
          agent,
          replacementSeq,
          'the original Session was rewound, but its edited prompt changed while waking',
        )
      }
    } catch (cause: unknown) {
      await cleanupQueuedMessages(ctx, agent, source.followups, 'edited-path')
      throw cause
    }
  })
}

interface RewindTransactionInput {
  targetSeq: number
  surfaceNodes: number[]
  followups: UserMessage[]
}

/** Commit one guarded surface replacement and optionally queue its real user path. */
async function runRewindTransaction(
  ctx: Context,
  sessionId: string,
  prepare: (snapshot: ReturnType<typeof snapshotOf>, transactionId: string) => RewindTransactionInput,
  requestSignal?: AbortSignal,
): Promise<RewindResult> {
  requestSignal?.throwIfAborted()
  installConversationRewindGuard(ctx)
  const agent = liveAgent(ctx, sessionId)
  if (activeRewinds.has(agent) || activeTransactions.has(agent) || agent.status !== 'idle') {
    throw new ConversationRewindError('SOURCE_BUSY', 'the Session is currently running or being edited', 409)
  }
  activeRewinds.add(agent)

  let trigger: UserMessage | undefined
  let state: ActiveTransaction | undefined
  let maintenanceStarted = false
  try {
    try {
      await agent.runMaintenance(async (signal) => {
        maintenanceStarted = true
        signal.throwIfAborted()
        requestSignal?.throwIfAborted()
        assertOwned(ctx, agent)
        if (!ownsEntireInbox(agent, [])) {
          throw new ConversationRewindError(
            'SOURCE_BUSY',
            'the Session has pending messages, steering, or injected context; let it settle before editing history',
            409,
          )
        }

        const transactionId = randomUUID()
        const prepared = prepare(snapshotOf(agent), transactionId)
        requestSignal?.throwIfAborted()
        const source: RewindTriggerSource = {
          kind: REWIND_TRIGGER_KIND,
          version: REWIND_TRIGGER_VERSION,
          transactionId,
          targetSeq: prepared.targetSeq,
          surfaceNodes: [...prepared.surfaceNodes],
          followups: [...prepared.followups],
        }
        trigger = createUserMessage({
          content: [{ type: 'text', text: `conversation-rewind-trigger-${source.transactionId}` }],
          source,
        })
        state = { source }
        activeTransactions.set(agent, state)
        agent.inbox.splice('next-turn', 0, 0, [trigger])
        try {
          requestSignal?.throwIfAborted()
          await ctx.sessions.flush(agent.session)
          signal.throwIfAborted()
          requestSignal?.throwIfAborted()
          assertOwned(ctx, agent)
          if (!ownsEntireInbox(agent, [trigger])) {
            throw sourceChanged('the Session inbox changed while checkpointing the edit; retry')
          }
          wakeWithRemovedToken(agent, source.transactionId)
        } catch (cause: unknown) {
          await cleanupBeforeReplacement(ctx, agent, trigger, 'prepare')
          throw cause
        }
      })
    } catch (cause: unknown) {
      if (cause instanceof ConversationRewindError) throw cause
      if (!maintenanceStarted || agent.status !== 'idle') {
        throw new ConversationRewindError('SOURCE_BUSY', 'the Session became busy while preparing the edit', 409)
      }
      throw cause
    }

    await agent.whenIdle()
    if (state === undefined) {
      throw new ConversationRewindError('INTERNAL_ERROR', 'the rewind transaction did not initialize', 500)
    }
    if (state.outcome === undefined) {
      await cleanupBeforeReplacement(ctx, agent, trigger, 'unclaimed-trigger')
      throw new ConversationRewindError(
        'REWIND_ABORTED',
        'the internal rewind turn ended before reaching the guarded request boundary',
        409,
      )
    }
    if (!state.outcome.ok) throw state.outcome.value

    const { replacementSeq, shadowedMessages } = state.outcome.value
    try {
      await ctx.sessions.flush(agent.session)
    } catch (cause: unknown) {
      ctx.logger.error(
        `dsh-conversation-rewind replacement checkpoint ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
      )
      throw partialError(
        agent,
        replacementSeq,
        'the original Session was rewound, but its replacement checkpoint could not be confirmed',
      )
    }

    // From this point the internal trigger is durably replaced. Release the
    // request guard before waking the real edited prompt; activeRewinds still
    // serializes another rewind until this method returns.
    if (activeTransactions.get(agent) === state) activeTransactions.delete(agent)
    if (state.source.followups.length > 0) {
      try {
        // The Surface replacement is durable at this point. A disconnected
        // browser must not strand the original Session between truncation and
        // replay, so the transaction converges independently of request aborts.
        await queueEditedPath(ctx, agent, state.source, replacementSeq)
      } catch (cause: unknown) {
        if (cause instanceof ConversationRewindError && cause.code === 'REWIND_PARTIAL') throw cause
        ctx.logger.error(
          `dsh-conversation-rewind edited prompt checkpoint ${agent.id}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
        )
        throw partialError(
          agent,
          replacementSeq,
          'the original Session was rewound, but its edited prompt could not be checkpointed and woken',
        )
      }
    }

    return {
      sessionId: agent.id,
      replacementSeq,
      queuedMessages: state.source.followups.length,
      shadowedMessages,
    }
  } finally {
    if (activeTransactions.get(agent) === state) activeTransactions.delete(agent)
    activeRewinds.delete(agent)
  }
}

/** Append an edited path to the original Session without dispatching the internal trigger to a provider. */
export async function rewindConversation(
  ctx: Context,
  request: RewindRequest,
  signal?: AbortSignal,
): Promise<RewindResult> {
  return runRewindTransaction(ctx, request.sessionId, (snapshot) => {
    const plan = buildRewindPlan(snapshot, request)
    return {
      targetSeq: plan.target.seq,
      surfaceNodes: [...plan.surfaceNodes],
      followups: plan.followups.map(text => createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })),
    }
  }, signal)
}

/** Read one historical branch path without changing the Session or dispatching work. */
export async function selectConversationBranch(
  ctx: Context,
  request: RewindBranchSelectRequest,
  signal?: AbortSignal,
): Promise<RewindBranchSelectResult> {
  signal?.throwIfAborted()
  const live = ctx.agents.get(SessionId(request.sessionId))
  const source = live === undefined
    ? await readSource(ctx, request.sessionId)
    : snapshotOf(live)
  signal?.throwIfAborted()
  const plan = queryConversationBranch(source, request)
  signal?.throwIfAborted()
  return {
    sessionId: request.sessionId,
    messageSeq: plan.messageSeq,
    queuedMessages: 0,
    path: [...plan.desiredPath],
  }
}

/** Browser-facing Remote that preserves stable business errors. */
export class ConversationRewindRuntime extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'conversationRewind')
    installConversationRewindGuard(ctx)
  }

  @Remote
  async list(sessionId: string, signal?: AbortSignal): Promise<RewindBusinessResult<RewindSessionView>> {
    try {
      signal?.throwIfAborted()
      const live = this.ctx.agents.get(SessionId(sessionId))
      const source = live === undefined ? await readSource(this.ctx, sessionId) : snapshotOf(live)
      signal?.throwIfAborted()
      const model = projectModel(source.events)
      return {
        ok: true,
        value: {
          sessionId,
          messages: listEditableMessages(source.events),
          hiddenRanges: listHiddenRanges(source.events),
          branches: projectBranchTree(source.events),
          ...(model === undefined ? {} : { model }),
        },
      }
    } catch (cause: unknown) {
      if (signal?.aborted) throw cause
      return cause instanceof ConversationRewindError
        ? errorResult(cause)
        : internalError(this.ctx, 'list', cause)
    }
  }

  @Remote
  async rewind(request: RewindRequest, signal?: AbortSignal): Promise<RewindBusinessResult<RewindResult>> {
    try {
      return { ok: true, value: await rewindConversation(this.ctx, request, signal) }
    } catch (cause: unknown) {
      if (signal?.aborted) throw cause
      return cause instanceof ConversationRewindError
        ? errorResult(cause)
        : internalError(this.ctx, 'rewind', cause)
    }
  }

  @Remote
  async select(request: RewindBranchSelectRequest, signal?: AbortSignal): Promise<RewindBusinessResult<RewindBranchSelectResult>> {
    try {
      return { ok: true, value: await selectConversationBranch(this.ctx, request, signal) }
    } catch (cause: unknown) {
      if (signal?.aborted) throw cause
      return cause instanceof ConversationRewindError
        ? errorResult(cause)
        : internalError(this.ctx, 'select', cause)
    }
  }
}
