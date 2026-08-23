import {
  createAssistantMessage,
  createUserMessage,
  type LlmCallConfig,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { foldSurface, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session-query', () => ({
  SessionQueryError: class SessionQueryError extends Error {
    constructor(message: string, readonly code: string) { super(message) }
  },
}))
vi.mock('@deepseek-ai/dsh-typert-protocol', () => ({
  Remote: () => undefined,
  TypertRemoteService: class TypertRemoteService {
    constructor(protected readonly ctx: unknown, _name: string) {}
  },
}))

import {
  buildRewindPlan,
  ConversationRewindError,
  listEditableMessages,
  projectBranchTree,
  REWIND_MARKER_KIND,
  REWIND_MARKER_MODEL,
  REWIND_MARKER_PROVIDER,
  REWIND_MARKER_VERSION,
} from '../src/core.ts'
import {
  ConversationRewindRuntime,
  installConversationRewindGuard,
  REWIND_TRIGGER_KIND,
  REWIND_TRIGGER_VERSION,
  rewindConversation,
  selectConversationBranch,
  type RewindTriggerSource,
} from '../src/runtime.ts'

const header: SessionHeader = {
  version: 0,
  id: 'source' as never,
  createdAt: 1,
  cwd: '/workspace',
}

type RequestHandler = (
  payload: { agent: object; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>,
) => Promise<LlmCallConfig>

interface HarnessOptions {
  flushFailureAt?: number
  firstTurnPrelude?: boolean
  maintenanceConflictAt?: number
  mutateDummySurface?: boolean
  parentSession?: string
  providerGate?: Promise<void>
  sessionId?: string
}

interface AddedTurn {
  message: UserMessage
  seq: number
  preludeSeq?: number
}

function harness(options: HarnessOptions = {}) {
  const events: SessionEvent[] = []
  const sessionHeader: SessionHeader = {
    ...header,
    id: (options.sessionId ?? 'source') as never,
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession as never }),
  }
  const requestHandlers: RequestHandler[] = []
  const logs: string[] = []
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  const providerMessages: UserMessage[] = []
  const providerSurfaces: number[][] = []
  const errors: unknown[] = []
  let flushes = 0
  let maintenanceCalls = 0
  let routeCalls = 0
  let dummyMutated = false

  const append = (type: string, data: unknown, opts?: Record<string, unknown>): SessionEvent => {
    const event = {
      type,
      seq: events.length,
      time: events.length + 1,
      data,
      ...opts,
    } as SessionEvent
    events.push(event)
    return event
  }

  const addClosedTurn = (text: string): AddedTurn => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const turn = events.filter(event => event.type === 'turn/start').length + 1
    const prelude = options.firstTurnPrelude && turn === 1
      ? createUserMessage({
          content: [{ type: 'text', text: 'permission state' }],
          source: { kind: 'plugin', plugin: 'user-approval' },
        })
      : undefined
    if (prelude !== undefined) {
      append('agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 0, inserted: [prelude],
      })
    }
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] })
    append('turn/start', { turn })
    if (prelude !== undefined) {
      append('agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      })
    }
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    append('step/start', { turn, step: 1 })
    const preludeEvent = prelude === undefined
      ? undefined
      : append('user/message', prelude, { surfaceOp: 'append' })
    const user = append('user/message', message, { surfaceOp: 'append' })
    append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer:${text}` }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    append('step/end', { turn, step: 1 })
    append('turn/end', { turn, reason: { kind: 'completed' } })
    return {
      message,
      seq: user.seq,
      ...(preludeEvent === undefined ? {} : { preludeSeq: preludeEvent.seq }),
    }
  }

  class FakeInbox {
    readonly nextTurn: UserMessage[] = []
    readonly nextStep: UserMessage[] = []

    splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
      const list = target === 'next-turn' ? this.nextTurn : this.nextStep
      const resolved = Math.max(0, Math.min(Number.isFinite(start) ? start : list.length, list.length))
      const removed = list.splice(resolved, deleteCount, ...inserted)
      append('agent/inbox/spliced', {
        target,
        start: resolved,
        removedCount: removed.length,
        inserted,
      })
      return removed
    }

    remove(id: UserMessage['id']): boolean {
      for (const target of ['next-step', 'next-turn'] as const) {
        const list = target === 'next-turn' ? this.nextTurn : this.nextStep
        const index = list.findIndex(message => message.id === id)
        if (index >= 0) {
          this.splice(target, index, 1, [])
          return true
        }
      }
      return false
    }
  }

  class FakeAgent {
    readonly id = sessionHeader.id
    readonly options = { provider: 'fixture', model: 'fixture-model' }
    readonly inbox = new FakeInbox()
    readonly session = {
      header: sessionHeader,
      get events(): readonly SessionEvent[] { return events },
      append: (type: string, data: unknown, opts?: Record<string, unknown>) => append(type, data, opts),
    }
    private phase: 'idle' | 'maintenance' | 'running' = 'idle'
    private maintenanceWake = false
    private controller: AbortController | undefined
    private activity: Promise<void> = Promise.resolve()
    private lastTurn = events.filter(event => event.type === 'turn/start').length

    get status(): 'idle' | 'running' {
      return this.phase === 'running' ? 'running' : 'idle'
    }

    send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
      this.inbox.splice(target, Number.POSITIVE_INFINITY, 0, [message])
      if (!wakeup) return
      if (this.phase === 'maintenance') {
        this.maintenanceWake = true
      } else if (this.phase === 'idle') {
        this.startDriver()
      }
    }

    cancel(cause: unknown, cancelOptions: unknown): void {
      cancels.push({ cause, options: cancelOptions })
      this.controller?.abort(cause)
    }

    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      maintenanceCalls += 1
      if (options.maintenanceConflictAt === maintenanceCalls) {
        throw new Error('agent already has active maintenance')
      }
      if (this.phase !== 'idle') throw new Error('agent already has active work')
      this.phase = 'maintenance'
      this.maintenanceWake = false
      const controller = new AbortController()
      const promise = (async () => {
        try {
          return await task(controller.signal)
        } finally {
          const wake = this.maintenanceWake && (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0)
          this.phase = 'idle'
          if (wake) this.startDriver()
        }
      })()
      this.activity = promise.then(() => undefined, () => undefined)
      return promise
    }

    async whenIdle(): Promise<void> {
      let observed: Promise<void>
      do {
        observed = this.activity
        await observed
      } while (observed !== this.activity)
    }

    private startDriver(): void {
      if (this.phase !== 'idle') return
      this.phase = 'running'
      const promise = this.drive().finally(() => { this.phase = 'idle' })
      this.activity = promise
    }

    private async drive(): Promise<void> {
      while (this.inbox.nextTurn.length > 0) {
        this.controller = new AbortController()
        const { signal } = this.controller
        const turn = ++this.lastTurn
        append('turn/start', { turn })
        const claimed = this.inbox.splice('next-turn', 0, 1, [])
        if (claimed.length === 0) {
          append('turn/end', { turn, reason: { kind: 'completed' } })
          continue
        }
        append('step/start', { turn, step: 1 })
        for (const message of claimed) append('user/message', message, { surfaceOp: 'append' })
        if (options.mutateDummySurface && !dummyMutated && claimed[0]?.source.kind === REWIND_TRIGGER_KIND) {
          dummyMutated = true
          const external = createUserMessage({
            content: [{ type: 'text', text: 'concurrent injected context' }],
            source: { kind: 'plugin', plugin: 'external' },
          })
          append('user/message', external, { surfaceOp: 'append' })
        }

        try {
          const config = await dispatchRequest({ agent: this, turn, step: 1, signal })
          if (!signal.aborted) {
            routeCalls += 1
            if (options.providerGate !== undefined) await options.providerGate
            if (!signal.aborted) {
              providerMessages.push(...claimed)
              providerSurfaces.push([...foldSurface(events).nodes])
              append('assistant/message', {
                turn,
                step: 1,
                message: createAssistantMessage({
                  content: [{ type: 'text', text: 'provider response' }],
                  source: { provider: config.provider, model: config.model },
                }),
              }, { surfaceOp: 'append', sourceEventSeqs: [] })
            }
          }
        } catch (cause: unknown) {
          if (!signal.aborted) errors.push(cause)
        } finally {
          append('step/end', { turn, step: 1 })
          append('turn/end', {
            turn,
            reason: signal.aborted
              ? { kind: 'aborted', reason: signal.reason }
              : { kind: 'completed' },
          })
        }
        if (signal.aborted) break
      }
      this.controller = undefined
    }
  }

  const agent = new FakeAgent()
  const dispatchRequest = async (payload: Parameters<RequestHandler>[0]): Promise<LlmCallConfig> => {
    const invoke = (index: number): Promise<LlmCallConfig> => {
      const handler = requestHandlers[index]
      return handler === undefined
        ? Promise.resolve({ provider: 'fixture', model: 'fixture-model' })
        : handler(payload, () => invoke(index + 1))
    }
    return invoke(0)
  }

  const ctx: any = {
    logger: { error: (message: string) => { logs.push(message) } },
    on: (name: string, handler: unknown) => {
      if (name === 'agent/request') requestHandlers.push(handler as RequestHandler)
      return () => true
    },
    agents: {
      get: (id: string) => id === agent.id ? agent : undefined,
      list: () => [agent],
    },
    sessions: {
      flush: async () => {
        flushes += 1
        if (options.flushFailureAt === flushes) throw new Error(`flush ${flushes} failed`)
        return true
      },
    },
    sessionQuery: {
      readSession: async () => ({ session: sessionHeader, events: [...events] }),
    },
  }

  const first = addClosedTurn('first')
  const second = addClosedTurn('second')

  const markCurrentLogAsSeed = (): void => {
    const mutableHeader = agent.session.header as SessionHeader & { seedLength: number }
    mutableHeader.seedLength = events.length
    append('session/end-seed', {})
  }

  return {
    ctx,
    agent,
    events,
    first,
    second,
    logs,
    cancels,
    providerMessages,
    providerSurfaces,
    errors,
    markCurrentLogAsSeed,
    get flushes() { return flushes },
    get maintenanceCalls() { return maintenanceCalls },
    get routeCalls() { return routeCalls },
  }
}

describe('same-Session rewind runtime', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists the current live Session instead of a stale persistence snapshot', async () => {
    const fixture = harness()
    fixture.ctx.sessionQuery.readSession = vi.fn(async () => ({ session: header, events: [] }))
    const runtime = new ConversationRewindRuntime(fixture.ctx)

    const result = await runtime.list('source')

    expect(result).toMatchObject({
      ok: true,
      value: {
        sessionId: 'source',
        messages: [
          expect.objectContaining({ text: 'first' }),
          expect.objectContaining({ text: 'second' }),
        ],
      },
    })
    expect(fixture.ctx.sessionQuery.readSession).not.toHaveBeenCalled()
  })

  it('selects a branch leaf as a pure path query', async () => {
    const fixture = harness()
    const beforeEvents = structuredClone(fixture.events)
    const beforeNextTurn = [...fixture.agent.inbox.nextTurn]
    const beforeNextStep = [...fixture.agent.inbox.nextStep]
    const beforeFlushes = fixture.flushes
    const beforeProviderMessages = [...fixture.providerMessages]
    const beforeProviderSurfaces = fixture.providerSurfaces.map(surface => [...surface])
    const beforeRouteCalls = fixture.routeCalls
    const beforeCancels = [...fixture.cancels]
    const beforeErrors = [...fixture.errors]

    const result = await selectConversationBranch(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.second.seq,
    })

    expect(result).toEqual({
      sessionId: 'source',
      messageSeq: fixture.second.seq,
      queuedMessages: 0,
      path: projectBranchTree(fixture.events).currentPath,
    })
    expect(fixture.events).toEqual(beforeEvents)
    expect(fixture.agent.inbox.nextTurn).toEqual(beforeNextTurn)
    expect(fixture.agent.inbox.nextStep).toEqual(beforeNextStep)
    expect(fixture.flushes).toBe(beforeFlushes)
    expect(fixture.providerMessages).toEqual(beforeProviderMessages)
    expect(fixture.providerSurfaces).toEqual(beforeProviderSurfaces)
    expect(fixture.routeCalls).toBe(beforeRouteCalls)
    expect(fixture.cancels).toEqual(beforeCancels)
    expect(fixture.errors).toEqual(beforeErrors)
  })

  it('does not claim, flush, or dispatch existing inbox work while browsing a leaf', async () => {
    const fixture = harness()
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'already queued' }],
      source: { kind: 'plugin', plugin: 'external' },
    })
    fixture.agent.inbox.splice('next-turn', 0, 0, [pending])
    const beforeEvents = structuredClone(fixture.events)
    const beforeFlushes = fixture.flushes
    const beforeMaintenance = fixture.maintenanceCalls
    const beforeRouteCalls = fixture.routeCalls
    const beforeCancels = [...fixture.cancels]

    const result = await selectConversationBranch(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.second.seq,
    })

    expect(result).toMatchObject({
      sessionId: 'source', messageSeq: fixture.second.seq, queuedMessages: 0,
      path: expect.any(Array),
    })
    expect(fixture.events).toEqual(beforeEvents)
    expect(fixture.agent.inbox.nextTurn).toEqual([pending])
    expect(fixture.agent.inbox.nextStep).toEqual([])
    expect(fixture.flushes).toBe(beforeFlushes)
    expect(fixture.maintenanceCalls).toBe(beforeMaintenance)
    expect(fixture.providerMessages).toEqual([])
    expect(fixture.routeCalls).toBe(beforeRouteCalls)
    expect(fixture.cancels).toEqual(beforeCancels)
  })

  it('rejects a non-leaf branch node without changing the Session', async () => {
    const fixture = harness()
    const beforeEvents = structuredClone(fixture.events)
    const beforeNextTurn = [...fixture.agent.inbox.nextTurn]
    const beforeNextStep = [...fixture.agent.inbox.nextStep]
    const beforeFlushes = fixture.flushes
    const beforeProviderMessages = [...fixture.providerMessages]
    const beforeRouteCalls = fixture.routeCalls
    const beforeCancels = [...fixture.cancels]

    await expect(selectConversationBranch(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq,
    })).rejects.toMatchObject({ code: 'BRANCH_NOT_ENDPOINT', status: 409 })

    expect(fixture.events).toEqual(beforeEvents)
    expect(fixture.agent.inbox.nextTurn).toEqual(beforeNextTurn)
    expect(fixture.agent.inbox.nextStep).toEqual(beforeNextStep)
    expect(fixture.flushes).toBe(beforeFlushes)
    expect(fixture.providerMessages).toEqual(beforeProviderMessages)
    expect(fixture.routeCalls).toBe(beforeRouteCalls)
    expect(fixture.cancels).toEqual(beforeCancels)
  })

  it('reads a persisted Session when the branch is not live', async () => {
    const fixture = harness()
    const persisted = structuredClone(fixture.events)
    fixture.ctx.agents.get = vi.fn(() => undefined)
    fixture.ctx.sessionQuery.readSession = vi.fn(async () => ({ session: header, events: persisted }))
    const beforeNextTurn = [...fixture.agent.inbox.nextTurn]
    const beforeNextStep = [...fixture.agent.inbox.nextStep]
    const beforeFlushes = fixture.flushes
    const beforeProviderMessages = [...fixture.providerMessages]
    const beforeRouteCalls = fixture.routeCalls
    const beforeCancels = [...fixture.cancels]
    const beforeErrors = [...fixture.errors]

    const result = await selectConversationBranch(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.second.seq,
    })

    expect(fixture.ctx.sessionQuery.readSession).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      sessionId: 'source',
      messageSeq: fixture.second.seq,
      queuedMessages: 0,
      path: projectBranchTree(persisted).currentPath,
    })
    expect(fixture.flushes).toBe(beforeFlushes)
    expect(fixture.providerMessages).toEqual(beforeProviderMessages)
    expect(fixture.agent.inbox.nextTurn).toEqual(beforeNextTurn)
    expect(fixture.agent.inbox.nextStep).toEqual(beforeNextStep)
    expect(fixture.routeCalls).toBe(beforeRouteCalls)
    expect(fixture.cancels).toEqual(beforeCancels)
    expect(fixture.errors).toEqual(beforeErrors)
    expect(fixture.events).toEqual(persisted)
  })

  it('keeps an edited sibling available without replaying it on selection', async () => {
    const fixture = harness()
    await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.second.seq,
      text: 'edited second', cascade: 'truncate',
    })
    await fixture.agent.whenIdle()

    const beforeEvents = structuredClone(fixture.events)
    const beforeProviderMessages = [...fixture.providerMessages]
    const beforeFlushes = fixture.flushes
    const beforeRouteCalls = fixture.routeCalls
    const result = await selectConversationBranch(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.second.seq,
    })

    expect(result).toMatchObject({
      sessionId: 'source', messageSeq: fixture.second.seq, queuedMessages: 0,
      path: expect.any(Array),
    })
    expect(fixture.events).toEqual(beforeEvents)
    expect(fixture.providerMessages).toEqual(beforeProviderMessages)
    expect(fixture.flushes).toBe(beforeFlushes)
    expect(fixture.routeCalls).toBe(beforeRouteCalls)
  })

  it('replaces the original Session tail, never sends the trigger, and sends the edited prompt once', async () => {
    const fixture = harness()
    const result = await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })
    await fixture.agent.whenIdle()

    expect(result).toMatchObject({
      sessionId: 'source', queuedMessages: 1, shadowedMessages: expect.any(Number),
    })
    expect(fixture.providerMessages).toHaveLength(1)
    expect(fixture.providerMessages[0]?.source).toEqual({ kind: 'user' })
    expect(fixture.providerMessages[0]?.content).toEqual([{ type: 'text', text: 'edited first' }])
    expect(fixture.routeCalls).toBe(1)
    expect(fixture.cancels).toEqual([{
      cause: { kind: 'hook', reason: 'conversation-rewind' },
      options: { keepInbox: true },
    }])
    expect(fixture.errors).toEqual([])

    const triggerEvent = fixture.events.find(event => (
      event.type === 'user/message' && event.data.source.kind === REWIND_TRIGGER_KIND
    ))
    const replacement = fixture.events[result.replacementSeq]
    expect(triggerEvent?.type).toBe('user/message')
    expect(replacement?.type).toBe('assistant/message')
    expect(replacement?.type === 'assistant/message' && replacement.data.message.content).toEqual([])
    expect(replacement?.type === 'assistant/message' && replacement.data.message.source.replayState)
      .toMatchObject({ kind: REWIND_MARKER_KIND, transactionId: expect.any(String), targetSeq: fixture.first.seq })
    expect((replacement as SessionEvent<'assistant/message'> | undefined)?.sourceEventSeqs).toEqual(
      foldSurface(fixture.events.slice(0, result.replacementSeq)).nodes.slice(
        foldSurface(fixture.events.slice(0, result.replacementSeq)).nodes.indexOf(fixture.first.seq),
      ),
    )
    expect(fixture.providerSurfaces[0]).not.toContain(fixture.first.seq)
    expect(fixture.providerSurfaces[0]).not.toContain(triggerEvent?.seq)

    const edited = fixture.providerMessages[0]
    const insertion = fixture.events.find(event => (
      event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === edited?.id)
    ))
    const dummyEnd = fixture.events.find(event => (
      event.type === 'turn/end' && event.data.reason.kind === 'aborted'
    ))
    expect(insertion?.seq).toBeGreaterThan(dummyEnd?.seq ?? Number.POSITIVE_INFINITY)
    const editable = listEditableMessages(fixture.events)
    const editedView = editable.find(message => message.text === 'edited first')
    expect(editedView).toBeDefined()
    expect(() => buildRewindPlan({ session: header, events: fixture.events }, {
      sessionId: 'source', messageSeq: editedView?.seq ?? -1, text: 'edited twice', cascade: 'truncate',
    })).not.toThrow()
  })

  it('keeps first-turn context before the edited message on the original Session surface', async () => {
    const fixture = harness({ firstTurnPrelude: true })
    const preludeSeq = fixture.first.preludeSeq
    expect(preludeSeq).toEqual(expect.any(Number))
    expect(listEditableMessages(fixture.events)).toEqual([
      expect.objectContaining({ seq: fixture.first.seq, text: 'first' }),
      expect.objectContaining({ seq: fixture.second.seq, text: 'second' }),
    ])

    const result = await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })
    await fixture.agent.whenIdle()

    expect(result.sessionId).toBe(fixture.agent.id)
    expect(fixture.agent.session.header.id).toBe('source')
    expect(fixture.providerSurfaces[0]).toContain(preludeSeq)
    expect(fixture.providerSurfaces[0]).not.toContain(fixture.first.seq)
  })

  it('short-circuits downstream request hooks for the trigger but delegates the real edited request', async () => {
    const fixture = harness()
    installConversationRewindGuard(fixture.ctx)
    let triggerHookCalls = 0
    fixture.ctx.on('agent/request', (
      { agent }: { agent: typeof fixture.agent },
      next: () => Promise<LlmCallConfig>,
    ) => {
      const lastStep = [...agent.session.events].reverse().find(event => event.type === 'step/start')
      const openStepMessages = lastStep === undefined
        ? []
        : agent.session.events.slice(lastStep.seq + 1).filter(event => event.type === 'user/message')
      if (openStepMessages.some(event => event.data.source.kind === REWIND_TRIGGER_KIND)) {
        triggerHookCalls += 1
        return new Promise<LlmCallConfig>(() => {})
      }
      return next()
    })

    const result = await Promise.race([
      rewindConversation(fixture.ctx, {
        sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('rewind timed out in downstream request hook')) }, 250)
      }),
    ])
    await fixture.agent.whenIdle()

    expect(result.sessionId).toBe('source')
    expect(triggerHookCalls).toBe(0)
    expect(fixture.providerMessages).toHaveLength(1)
  })

  it('keeps individually queued preserve messages editable, including the second replayed turn', async () => {
    const fixture = harness()
    await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'preserve',
    })
    await fixture.agent.whenIdle()

    expect(fixture.providerMessages.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'edited first' },
      { type: 'text', text: 'second' },
    ])
    const editable = listEditableMessages(fixture.events)
    const replayedSecond = editable.find(message => message.text === 'second' && message.seq > fixture.second.seq)
    expect(replayedSecond).toBeDefined()

    const secondResult = await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: replayedSecond?.seq ?? -1, text: 'second edited again', cascade: 'truncate',
    })
    await fixture.agent.whenIdle()
    expect(secondResult.sessionId).toBe('source')
    expect(fixture.providerMessages.at(-1)?.content).toEqual([{ type: 'text', text: 'second edited again' }])
  })

  it('fails closed on a changed dummy surface and preserves the concurrent message without provider dispatch', async () => {
    const fixture = harness({ mutateDummySurface: true })

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    await fixture.agent.whenIdle()

    expect(fixture.providerMessages).toEqual([])
    expect(fixture.routeCalls).toBe(0)
    expect(fixture.cancels).toHaveLength(1)
    expect(fixture.agent.inbox.nextTurn.some(message => (
      message.source.kind === 'plugin' && message.source.plugin === 'external'
    ))).toBe(true)
    expect(fixture.errors).toEqual([])
  })

  it('removes its pending trigger when the pre-replacement checkpoint fails', async () => {
    const fixture = harness({ flushFailureAt: 1 })
    const before = [...foldSurface(fixture.events).nodes]

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })).rejects.toThrow('flush 1 failed')

    expect(fixture.agent.inbox.nextTurn.some(message => message.source.kind === REWIND_TRIGGER_KIND)).toBe(false)
    expect(foldSurface(fixture.events).nodes).toEqual(before)
    expect(fixture.providerMessages).toEqual([])
  })

  it('removes its pending trigger when the remote request is cancelled before replacement', async () => {
    const fixture = harness()
    const controller = new AbortController()
    const flush = fixture.ctx.sessions.flush.bind(fixture.ctx.sessions)
    fixture.ctx.sessions.flush = async () => {
      controller.abort(new DOMException('request cancelled', 'AbortError'))
      return flush()
    }
    const before = [...foldSurface(fixture.events).nodes]

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await fixture.agent.whenIdle()

    expect(fixture.agent.inbox.nextTurn.some(message => message.source.kind === REWIND_TRIGGER_KIND)).toBe(false)
    expect(foldSurface(fixture.events).nodes).toEqual(before)
    expect(fixture.providerMessages).toEqual([])
  })

  it('finishes the edited path when the request is cancelled after the replacement is durable', async () => {
    const fixture = harness()
    const controller = new AbortController()
    const flush = fixture.ctx.sessions.flush.bind(fixture.ctx.sessions)
    fixture.ctx.sessions.flush = async () => {
      const result = await flush()
      if (fixture.flushes === 2) {
        controller.abort(new DOMException('request cancelled after commit', 'AbortError'))
      }
      return result
    }

    const result = await rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    }, controller.signal)
    await fixture.agent.whenIdle()

    expect(controller.signal.aborted).toBe(true)
    expect(result).toMatchObject({ sessionId: 'source', queuedMessages: 1 })
    expect(fixture.providerMessages.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'edited first' },
    ])
    expect(fixture.agent.inbox.nextTurn).toEqual([])
    expect(fixture.agent.inbox.nextStep).toEqual([])
  })

  it('refuses to reorder an existing pending next-turn message', async () => {
    const fixture = harness()
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'already queued' }],
      source: { kind: 'user' },
    })
    fixture.agent.inbox.splice('next-turn', 0, 0, [pending])

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })).rejects.toMatchObject({ code: 'SOURCE_BUSY', status: 409 })

    expect(fixture.agent.inbox.nextTurn).toEqual([pending])
    expect(fixture.providerMessages).toEqual([])
    expect(fixture.events.some(event => (
      event.type === 'user/message' && event.data.source.kind === REWIND_TRIGGER_KIND
    ))).toBe(false)
  })

  it('reports an idle-looking maintenance lock conflict as SOURCE_BUSY', async () => {
    const fixture = harness({ maintenanceConflictAt: 1 })

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })).rejects.toMatchObject({ code: 'SOURCE_BUSY', status: 409 })

    expect(fixture.agent.status).toBe('idle')
    expect(fixture.providerMessages).toEqual([])
    expect(fixture.events.some(event => (
      event.type === 'user/message' && event.data.source.kind === REWIND_TRIGGER_KIND
    ))).toBe(false)
  })

  it('reports a same-Session partial result when replacement durability cannot be confirmed', async () => {
    const fixture = harness({ flushFailureAt: 2 })

    await expect(rewindConversation(fixture.ctx, {
      sessionId: 'source', messageSeq: fixture.first.seq, text: 'edited first', cascade: 'truncate',
    })).rejects.toSatisfy((cause: unknown) => (
      cause instanceof ConversationRewindError
      && cause.code === 'REWIND_PARTIAL'
      && cause.details?.sessionId === 'source'
      && typeof cause.details.replacementSeq === 'number'
    ))
    expect(fixture.providerMessages).toEqual([])
  })

  it('recovers a persisted orphan trigger on guard installation without exposing it to the provider', async () => {
    const fixture = harness()
    const followup = createUserMessage({
      content: [{ type: 'text', text: 'recovered edit' }],
      source: { kind: 'user' },
    })
    const source: RewindTriggerSource = {
      kind: REWIND_TRIGGER_KIND,
      version: REWIND_TRIGGER_VERSION,
      transactionId: 'orphan-tx',
      targetSeq: fixture.first.seq,
      surfaceNodes: [...foldSurface(fixture.events).nodes],
      followups: [followup],
    }
    const trigger = createUserMessage({
      content: [{ type: 'text', text: 'orphan trigger' }],
      source,
    })
    fixture.agent.inbox.splice('next-turn', 0, 0, [trigger])

    installConversationRewindGuard(fixture.ctx)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await Promise.resolve()
      await fixture.agent.whenIdle()
    }

    expect(fixture.providerMessages.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'recovered edit' },
    ])
    expect(fixture.providerMessages.some(message => message.source.kind === REWIND_TRIGGER_KIND)).toBe(false)
    expect(fixture.cancels).toHaveLength(1)
    expect(fixture.events.some(event => (
      event.type === 'assistant/message'
      && (event.data.message.source.replayState as { transactionId?: string } | undefined)?.transactionId === 'orphan-tx'
    ))).toBe(true)
  })

  it('recovers an orphan trigger with an empty followup path by committing only the replacement', async () => {
    const fixture = harness()
    const source: RewindTriggerSource = {
      kind: REWIND_TRIGGER_KIND,
      version: REWIND_TRIGGER_VERSION,
      transactionId: 'orphan-empty-tx',
      targetSeq: fixture.second.seq,
      surfaceNodes: [...foldSurface(fixture.events).nodes],
      followups: [],
    }
    const trigger = createUserMessage({
      content: [{ type: 'text', text: 'orphan empty trigger' }],
      source,
    })
    fixture.agent.inbox.splice('next-turn', 0, 0, [trigger])

    installConversationRewindGuard(fixture.ctx)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await Promise.resolve()
      await fixture.agent.whenIdle()
    }

    expect(fixture.providerMessages).toEqual([])
    expect(fixture.routeCalls).toBe(0)
    expect(fixture.agent.inbox.nextTurn).toEqual([])
    expect(fixture.agent.inbox.nextStep).toEqual([])
    expect(fixture.cancels).toHaveLength(1)
    expect(fixture.events.some(event => (
      event.type === 'assistant/message'
      && (event.data.message.source.replayState as { transactionId?: string } | undefined)?.transactionId === 'orphan-empty-tx'
    ))).toBe(true)
    expect(projectBranchTree(fixture.events).currentPath).toEqual([fixture.first.seq])
  })

  it('does not recover parent rewind work inherited by a forked Session seed', async () => {
    const fixture = harness({ sessionId: 'child', parentSession: 'source' })
    const followups = [
      createUserMessage({
        content: [{ type: 'text', text: 'parent edited first' }],
        source: { kind: 'user' },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'parent replayed second' }],
        source: { kind: 'user' },
      }),
    ]
    const source: RewindTriggerSource = {
      kind: REWIND_TRIGGER_KIND,
      version: REWIND_TRIGGER_VERSION,
      transactionId: 'parent-seed-tx',
      targetSeq: fixture.first.seq,
      surfaceNodes: [...foldSurface(fixture.events).nodes],
      followups,
    }
    const trigger = createUserMessage({
      content: [{ type: 'text', text: 'parent persisted trigger' }],
      source,
    })
    fixture.agent.session.append('turn/start', { turn: 3 })
    fixture.agent.session.append('step/start', { turn: 3, step: 1 })
    const triggerEvent = fixture.agent.session.append('user/message', trigger, { surfaceOp: 'append' })
    const currentSurface = [...foldSurface(fixture.events).nodes]
    fixture.agent.session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: {
          provider: REWIND_MARKER_PROVIDER,
          model: REWIND_MARKER_MODEL,
          replayState: {
            kind: REWIND_MARKER_KIND,
            version: REWIND_MARKER_VERSION,
            transactionId: source.transactionId,
            targetSeq: source.targetSeq,
            mode: 'rewind',
          },
        },
      }),
    }, {
      surfaceOp: { op: 'replace', start: source.targetSeq, end: triggerEvent.seq },
      sourceEventSeqs: currentSurface.slice(currentSurface.indexOf(source.targetSeq)),
    })
    fixture.agent.session.append('step/end', { turn: 3, step: 1 })
    fixture.agent.session.append('turn/end', {
      turn: 3,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'conversation-rewind' } },
    })
    fixture.markCurrentLogAsSeed()

    installConversationRewindGuard(fixture.ctx)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await Promise.resolve()
      await fixture.agent.whenIdle()
    }

    expect(fixture.agent.session.header.seedLength).toBeGreaterThan(0)
    expect(fixture.agent.session.header.parentSession).toBe('source')
    expect(fixture.agent.inbox.nextTurn).toEqual([])
    expect(fixture.agent.inbox.nextStep).toEqual([])
    expect(fixture.providerMessages).toEqual([])
    expect(fixture.cancels).toEqual([])
  })

  it('does not trust a persisted replacement marker with extra replay fields during recovery', async () => {
    const fixture = harness()
    const followup = createUserMessage({
      content: [{ type: 'text', text: 'must remain parked' }],
      source: { kind: 'user' },
    })
    const surfaceNodes = [...foldSurface(fixture.events).nodes]
    const source: RewindTriggerSource = {
      kind: REWIND_TRIGGER_KIND,
      version: REWIND_TRIGGER_VERSION,
      transactionId: 'forged-marker-tx',
      targetSeq: fixture.first.seq,
      surfaceNodes,
      followups: [followup],
    }
    const trigger = createUserMessage({
      content: [{ type: 'text', text: 'persisted trigger' }],
      source,
    })
    const triggerEvent = fixture.agent.session.append('user/message', trigger, { surfaceOp: 'append' })
    const currentSurface = [...foldSurface(fixture.events).nodes]
    fixture.agent.session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: {
          provider: REWIND_MARKER_PROVIDER,
          model: REWIND_MARKER_MODEL,
          replayState: {
            kind: REWIND_MARKER_KIND,
            version: REWIND_MARKER_VERSION,
            transactionId: source.transactionId,
            targetSeq: source.targetSeq,
            mode: 'rewind',
            forged: true,
          },
        },
      }),
    }, {
      surfaceOp: { op: 'replace', start: source.targetSeq, end: triggerEvent.seq },
      sourceEventSeqs: currentSurface.slice(currentSurface.indexOf(source.targetSeq)),
    })

    installConversationRewindGuard(fixture.ctx)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await Promise.resolve()
      await fixture.agent.whenIdle()
    }

    expect(fixture.providerMessages).toEqual([])
    expect(fixture.agent.inbox.nextTurn).toEqual([])
    expect(fixture.logs.some(log => log.includes('parked orphan forged-marker-tx'))).toBe(true)
  })
})
