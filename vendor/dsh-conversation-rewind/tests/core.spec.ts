import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface, type SessionEvent, type SessionHeader, type SurfaceOp } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  buildBranchSelectionPlan,
  buildRewindPlan,
  ConversationRewindError,
  listEditableMessages,
  listHiddenRanges,
  projectBranchTree,
  queryConversationBranch,
  REWIND_MARKER_KIND,
  REWIND_MARKER_MODEL,
  REWIND_MARKER_PROVIDER,
  REWIND_MARKER_VERSION,
} from '../src/core.ts'

const header: SessionHeader = { version: 0, id: 'source' as never, createdAt: 1, cwd: '/tmp' }

function message(id: string, text: string) {
  return {
    id: id as never,
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [{ type: 'text' as const, text }],
  }
}

function pluginMessage(id: string, text: string, plugin = 'fixture') {
  return {
    id: id as never,
    role: 'user' as const,
    source: { kind: 'plugin' as const, plugin },
    content: [{ type: 'text' as const, text }],
  }
}

function systemSnapshot(id: string) {
  return {
    id: id as never,
    role: 'user' as const,
    source: {
      kind: 'plugin' as const,
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot' as const,
      sections: [{ name: 'fixture', text: 'runtime context' }],
    },
    content: [{ type: 'text' as const, text: 'runtime context' }],
  }
}

function skillCatalog(id: string) {
  return {
    id: id as never,
    role: 'user' as const,
    source: {
      kind: 'skill-catalog' as const,
      form: 'catalog' as const,
      entries: [{ name: 'fixture-skill', description: 'fixture' }],
    },
    content: [{ type: 'text' as const, text: 'available skills' }],
  }
}

function append<T extends SessionEvent['type']>(
  events: SessionEvent[],
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  surfaceOp?: SurfaceOp,
  sourceEventSeqs?: number[],
): Extract<SessionEvent, { type: T }> {
  const event = {
    type,
    seq: events.length,
    time: events.length + 1,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  } as Extract<SessionEvent, { type: T }>
  events.push(event)
  return event
}

function completeTurn(
  events: SessionEvent[],
  turn: number,
  id: string,
  text: string,
  prompt = message(id, text),
): number {
  append(events, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt] })
  append(events, 'turn/start', { turn })
  append(events, 'step/start', { turn, step: 1 })
  append(events, 'agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
  const user = append(events, 'user/message', prompt, 'append')
  append(events, 'assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `reply:${text}` }],
      source: { provider: 'fixture', model: 'fixture-model' },
    }),
  }, 'append', [])
  append(events, 'step/end', { turn, step: 1 })
  append(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  return user.seq
}

function completeTurnWithContext(
  events: SessionEvent[],
  turn: number,
  id: string,
  text: string,
  context: SessionEvent<'user/message'>['data'],
  prompt = message(id, text),
): number {
  append(events, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [context] })
  append(events, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt] })
  append(events, 'turn/start', { turn })
  append(events, 'agent/inbox/spliced', {
    target: 'next-step', start: 0, removedCount: 1, inserted: [],
  })
  append(events, 'agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
  append(events, 'step/start', { turn, step: 1 })
  append(events, 'user/message', context, 'append')
  const user = append(events, 'user/message', prompt, 'append')
  append(events, 'assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `reply:${text}` }],
      source: { provider: 'fixture', model: 'fixture-model' },
    }),
  }, 'append', [])
  append(events, 'step/end', { turn, step: 1 })
  append(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  return user.seq
}

function source(...texts: string[]) {
  const events: SessionEvent[] = []
  texts.forEach((text, index) => { completeTurn(events, index + 1, `m${index + 1}`, text) })
  return { session: header, events }
}

function appendReplacementTurn(
  events: SessionEvent[],
  targetSeq: number,
  transactionId = 'tx-1',
  mode: 'rewind' | 'cleanup' = 'rewind',
  replayExtras: Record<string, unknown> = {},
): number {
  const turn = events.filter(event => event.type === 'turn/start').length + 1
  const trigger = {
    id: `trigger-${transactionId}` as never,
    role: 'user' as const,
    source: { kind: 'plugin' as const, plugin: 'dsh-conversation-rewind' },
    content: [{ type: 'text' as const, text: 'internal trigger' }],
  }
  append(events, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [trigger] })
  append(events, 'turn/start', { turn })
  append(events, 'step/start', { turn, step: 1 })
  append(events, 'agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
  const triggerEvent = append(events, 'user/message', trigger, 'append')
  const surface = foldSurface(events).nodes
  const start = surface.indexOf(targetSeq)
  const shadowed = surface.slice(start)
  const replacement = append(events, 'assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [],
      source: {
        provider: REWIND_MARKER_PROVIDER,
        model: REWIND_MARKER_MODEL,
        replayState: {
          kind: REWIND_MARKER_KIND,
          version: REWIND_MARKER_VERSION,
          transactionId,
          targetSeq,
          mode,
          ...replayExtras,
        },
      },
    }),
  }, { op: 'replace', start: targetSeq, end: triggerEvent.seq }, [...shadowed])
  append(events, 'step/end', { turn, step: 1 })
  append(events, 'turn/end', {
    turn,
    reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'conversation-rewind' } },
  })
  return replacement.seq
}

function branchReplayMessage(id: string, text: string, transactionId: string, originSeq: number) {
  const replay = message(id, text)
  ;(replay.source as unknown as { rewindBranch: unknown }).rewindBranch = {
    kind: 'dsh-conversation-rewind-branch-replay',
    version: 1,
    transactionId,
    originSeq,
    text,
  }
  return replay
}

function appendWakeToken(
  events: SessionEvent[],
  transactionId: string,
  target: 'next-turn' | 'next-step' = 'next-turn',
  extra: SessionEvent<'user/message'>['data'][] = [],
): void {
  append(events, 'agent/inbox/spliced', {
    target,
    start: 0,
    inserted: [
      pluginMessage(
        `wake-${transactionId}-${target}`,
        `conversation-rewind-wake-${transactionId}`,
        'dsh-conversation-rewind',
      ),
      ...extra.map((data, index) => ({
        ...data,
        id: `wake-extra-${transactionId}-${String(index)}` as never,
      })),
    ],
  })
}

function appendCompaction(events: SessionEvent[], startSeq: number, endSeq: number, text = 'summary'): number {
  const turn = events.filter(event => event.type === 'turn/start').length + 1
  append(events, 'turn/start', { turn })
  append(events, 'step/start', { turn, step: 1 })
  const surface = foldSurface(events).nodes
  const start = surface.indexOf(startSeq)
  const end = surface.indexOf(endSeq)
  if (start < 0 || end < start) throw new Error('missing compaction range')
  const compacted = append(events, 'assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'fixture', model: 'fixture-model' },
    }),
  }, { op: 'replace', start: surface[start]!, end: surface[end]! }, surface.slice(start, end + 1))
  append(events, 'step/end', { turn, step: 1 })
  append(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  return compacted.seq
}

describe('same-Session rewind planning', () => {
  it('edits a seeded first prompt while preserving claimed context before it', () => {
    const events: SessionEvent[] = []
    const approval = pluginMessage('approval', 'permission state', 'user-approval')
    const prompt = message('first', 'hello')
    append(events, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [approval] })
    append(events, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt] })
    append(events, 'turn/start', { turn: 1 })
    append(events, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    })
    append(events, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
    append(events, 'step/start', { turn: 1, step: 1 })
    const approvalEvent = append(events, 'user/message', approval, 'append')
    const userEvent = append(events, 'user/message', prompt, 'append')
    append(events, 'user/message', systemSnapshot('system-context'), 'append')
    append(events, 'user/message', skillCatalog('skill-context') as never, 'append')
    append(events, 'assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'reply:hello' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, 'append', [])
    append(events, 'step/end', { turn: 1, step: 1 })
    append(events, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    append(events, 'session/end-seed', {})
    const snapshot = {
      session: {
        ...header,
        parentSession: 'parent' as never,
        seedLength: events.length - 1,
      },
      events,
    }

    expect(listEditableMessages(events)).toEqual([
      expect.objectContaining({ seq: userEvent.seq, turn: 1, text: 'hello' }),
    ])

    const plan = buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: userEvent.seq, text: 'hello edited', cascade: 'truncate',
    })
    expect(plan.shadowedSeqs[0]).toBe(userEvent.seq)
    expect(plan.shadowedSeqs).not.toContain(approvalEvent.seq)
    expect(plan.followups).toEqual(['hello edited'])
  })

  it('rejects a target when non-regenerated context after it would be shadowed', () => {
    const snapshot = source('one')
    const target = snapshot.events.find(event => event.type === 'user/message') as SessionEvent<'user/message'>
    const turnEndIndex = snapshot.events.findIndex(event => event.type === 'turn/end')
    snapshot.events.splice(turnEndIndex, 0, {
      type: 'user/message',
      seq: turnEndIndex,
      time: turnEndIndex + 1,
      data: pluginMessage('unsafe-suffix', 'must not disappear'),
      surfaceOp: 'append',
    })
    snapshot.events = snapshot.events.map((event, seq) => ({
      ...event,
      seq,
      time: seq + 1,
    })) as SessionEvent[]

    expect(listEditableMessages(snapshot.events)).toEqual([])
    expect(() => buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: target.seq, text: 'ONE', cascade: 'truncate',
    })).toThrowError(/non-regenerated user-role context after the message/)
  })

  it('requires an unambiguous single-message next-turn insertion boundary', () => {
    const snapshot = source('one')
    const insertion = snapshot.events.find(event => event.type === 'agent/inbox/spliced')
    if (insertion?.type !== 'agent/inbox/spliced') throw new Error('missing fixture insertion')
    insertion.data.inserted.push(pluginMessage('batched', 'ambiguous batch'))
    const target = snapshot.events.find(event => event.type === 'user/message') as SessionEvent<'user/message'>

    expect(listEditableMessages(snapshot.events)).toEqual([])
    expect(() => buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: target.seq, text: 'ONE', cascade: 'truncate',
    })).toThrowError(/unambiguous single-message insertion boundary/)
  })

  it('replaces the current surface from the target through the tail and preserves later prompts on request', () => {
    const snapshot = source('one', 'two', 'three')
    const target = listEditableMessages(snapshot.events)[1]!
    const plan = buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: target.seq, text: 'TWO', cascade: 'preserve',
    })

    expect(plan.target.text).toBe('two')
    expect(plan.shadowedSeqs).toEqual(foldSurface(snapshot.events).nodes.slice(2))
    expect(plan.followups).toEqual(['TWO', 'three'])
    expect(plan.surfaceNodes).toEqual(foldSurface(snapshot.events).nodes)
  })

  it('fails closed when preserve would cross a plugin-only turn before a later prompt', () => {
    const events: SessionEvent[] = []
    const targetSeq = completeTurn(events, 1, 'one', 'one')
    const context = pluginMessage('approval', 'permission state', 'user-approval')
    append(events, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [context] })
    append(events, 'turn/start', { turn: 2 })
    append(events, 'step/start', { turn: 2, step: 1 })
    append(events, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
    append(events, 'user/message', context, 'append')
    append(events, 'assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'approval reply' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, 'append', [])
    append(events, 'step/end', { turn: 2, step: 1 })
    append(events, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    completeTurn(events, 3, 'three', 'three')

    expect(() => buildRewindPlan({ session: header, events }, {
      sessionId: 'source', messageSeq: targetSeq, text: 'ONE', cascade: 'preserve',
    })).toThrowError(/non-regenerated user-role context/)
  })

  it.each([false, true])('fails closed when preserve crosses a compaction-hidden %s prompt', attachment => {
    const events: SessionEvent[] = []
    const targetSeq = completeTurn(events, 1, 'one', 'one')
    const hiddenPrompt = message('hidden', attachment ? 'picture' : 'two')
    if (attachment) {
      hiddenPrompt.content = [{
        type: 'image',
        attachment: {
          attachmentId: 'hidden-attachment' as never,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          bytes: 1,
        },
      }] as never
    }
    const hiddenSeq = completeTurn(events, 2, 'hidden', attachment ? 'picture' : 'two', hiddenPrompt)
    completeTurn(events, 3, 'three', 'three')
    const hiddenAssistant = events.find(event => (
      event.type === 'assistant/message' && event.data.turn === 2
    ))
    if (hiddenAssistant?.type !== 'assistant/message') throw new Error('missing hidden prompt reply')
    appendCompaction(events, hiddenSeq, hiddenAssistant.seq, 'compacted hidden prompt')

    expect(() => buildRewindPlan({ session: header, events }, {
      sessionId: 'source', messageSeq: targetSeq, text: 'ONE', cascade: 'preserve',
    })).toThrowError(/replacement checkpoint/)
  })

  it('keeps each newly queued edited prompt eligible for another edit', () => {
    const snapshot = source('one', 'two')
    const original = listEditableMessages(snapshot.events)[0]!
    appendReplacementTurn(snapshot.events, original.seq)
    const editedSeq = completeTurn(snapshot.events, 4, 'edited-1', 'ONE')

    expect(listEditableMessages(snapshot.events)).toEqual([
      expect.objectContaining({ seq: editedSeq, text: 'ONE' }),
    ])

    const second = buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: editedSeq, text: 'ONE AGAIN', cascade: 'truncate',
    })
    expect(second.target.seq).toBe(editedSeq)
    expect(second.followups).toEqual(['ONE AGAIN'])
  })

  it('does not expose shadowed old-path messages as editable', () => {
    const snapshot = source('one', 'two')
    const old = listEditableMessages(snapshot.events)
    appendReplacementTurn(snapshot.events, old[0]!.seq)
    completeTurn(snapshot.events, 4, 'edited', 'ONE')

    expect(listEditableMessages(snapshot.events).map(item => item.text)).toEqual(['ONE'])
  })

  it('plans by surface position when a prior replacement makes surface seqs non-monotonic', () => {
    const snapshot = source('one', 'two', 'three')
    const first = listEditableMessages(snapshot.events)[0]!
    const turn = 4
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    const prefix = foldSurface(snapshot.events).nodes.slice(0, 2)
    const compacted = append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'summary' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, { op: 'replace', start: prefix[0]!, end: prefix[1]! }, [...prefix])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    const target = listEditableMessages(snapshot.events).find(item => item.text === 'two')!
    const plan = buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: target.seq, text: 'TWO', cascade: 'truncate',
    })

    expect(plan.surfaceNodes[0]).toBe(compacted.seq)
    expect(plan.surfaceNodes[0]).toBeGreaterThan(target.seq)
    expect(plan.shadowedSeqs[0]).toBe(target.seq)
    expect(plan.target.seq).not.toBe(first.seq)
  })

  it('rejects attachment-bearing messages', () => {
    const snapshot = source('one')
    const user = snapshot.events.find(event => event.type === 'user/message') as SessionEvent<'user/message'>
    snapshot.events[user.seq] = {
      ...user,
      data: {
        ...user.data,
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'a' as never,
            mediaType: 'image/png',
            width: 1,
            height: 1,
            bytes: 1,
          },
        }],
      },
    }
    expect(() => buildRewindPlan(snapshot, {
      sessionId: 'source', messageSeq: user.seq, text: 'new', cascade: 'truncate',
    })).toThrowError(ConversationRewindError)
  })
})

describe('same-Session message branch planning', () => {
  function secondMessageBranch() {
    const snapshot = source('one', 'two')
    const [one, two] = listEditableMessages(snapshot.events)
    if (one === undefined || two === undefined) throw new Error('missing branch fixture messages')
    appendReplacementTurn(snapshot.events, two.seq, 'edit-second')
    const editedSeq = completeTurn(snapshot.events, 4, 'edited-second', 'TWO')
    return { snapshot, one, two, editedSeq }
  }

  it('keeps the shadowed path and projects the edited sibling as the current branch', () => {
    const { snapshot, one, two, editedSeq } = secondMessageBranch()

    expect(projectBranchTree(snapshot.events)).toEqual({
      nodes: [
        expect.objectContaining({
          seq: one.seq,
          turnStartSeq: one.turnStartSeq,
          turnEndSeq: one.turnEndSeq,
          text: 'one',
          path: [one.seq],
          branchEnd: false,
          selectable: true,
          current: true,
        }),
        expect.objectContaining({
          seq: two.seq,
          parentSeq: one.seq,
          text: 'two',
          path: [one.seq, two.seq],
          branchEnd: true,
          selectable: true,
          current: false,
        }),
        expect.objectContaining({
          seq: editedSeq,
          parentSeq: one.seq,
          text: 'TWO',
          path: [one.seq, editedSeq],
          branchEnd: true,
          selectable: true,
          current: true,
        }),
      ],
      currentPath: [one.seq, editedSeq],
      currentSeq: editedSeq,
    })
  })

  it('keeps an unedited branch segment at one visual level without losing its semantic path', () => {
    const snapshot = source('one', 'two', 'three')
    const [one, two, three] = listEditableMessages(snapshot.events)
    if (one === undefined || two === undefined || three === undefined) {
      throw new Error('missing branch-segment fixture messages')
    }
    appendReplacementTurn(snapshot.events, two.seq, 'edit-middle')
    const editedSeq = completeTurn(snapshot.events, 5, 'edited-middle', 'TWO')

    const tree = projectBranchTree(snapshot.events)
    expect(tree.nodes.find(node => node.seq === one.seq)).not.toHaveProperty('parentSeq')
    expect(tree.nodes.find(node => node.seq === two.seq)?.parentSeq).toBe(one.seq)
    expect(tree.nodes.find(node => node.seq === three.seq)?.parentSeq).toBe(one.seq)
    expect(tree.nodes.find(node => node.seq === editedSeq)?.parentSeq).toBe(one.seq)
    expect(tree.nodes.find(node => node.seq === two.seq)).toMatchObject({
      path: [one.seq, two.seq],
      branchEnd: false,
    })
    expect(tree.nodes.find(node => node.seq === three.seq)).toMatchObject({
      path: [one.seq, two.seq, three.seq],
      branchEnd: true,
    })
    expect(tree.nodes.find(node => node.seq === editedSeq)).toMatchObject({
      path: [one.seq, editedSeq],
      branchEnd: true,
    })
    expect(tree.currentPath).toEqual([one.seq, editedSeq])

    const query = queryConversationBranch(snapshot, {
      sessionId: 'source', messageSeq: three.seq,
    })
    expect(query).toEqual({
      messageSeq: three.seq,
      currentPath: [one.seq, editedSeq],
      desiredPath: [one.seq, two.seq, three.seq],
    })
    try {
      queryConversationBranch(snapshot, { sessionId: 'source', messageSeq: two.seq })
      throw new Error('expected a non-endpoint query to fail')
    } catch (cause: unknown) {
      expect(cause).toMatchObject({
        code: 'BRANCH_NOT_ENDPOINT',
        status: 409,
        message: expect.stringMatching(/final message/),
      })
    }
  })

  it('queries an unsafe completed endpoint while a later turn is still open', () => {
    const events: SessionEvent[] = []
    const oneSeq = completeTurn(events, 1, 'one-unsafe-query', 'one')
    const twoSeq = completeTurnWithContext(
      events,
      2,
      'two-unsafe-query',
      'two',
      pluginMessage('unsafe-query-context', 'permission state', 'user-approval'),
    )
    append(events, 'turn/start', { turn: 3 })
    const snapshot = { session: header, events }
    const node = projectBranchTree(events).nodes.find(candidate => candidate.seq === twoSeq)

    expect(node).toMatchObject({
      path: [oneSeq, twoSeq],
      branchEnd: true,
      selectable: false,
    })
    expect(queryConversationBranch(snapshot, {
      sessionId: 'source', messageSeq: twoSeq,
    })).toEqual({
      messageSeq: twoSeq,
      currentPath: [oneSeq, twoSeq],
      desiredPath: [oneSeq, twoSeq],
    })
  })

  it('treats selecting the current leaf as a no-op', () => {
    const { snapshot, one, editedSeq } = secondMessageBranch()

    const plan = buildBranchSelectionPlan(snapshot, {
      sessionId: 'source', messageSeq: editedSeq,
    })

    expect(plan).toMatchObject({
      messageSeq: editedSeq,
      currentPath: [one.seq, editedSeq],
      desiredPath: [one.seq, editedSeq],
      followups: [],
    })
    expect(plan).not.toHaveProperty('targetSeq')
  })

  it('truncates at the next current message when selecting an ancestor', () => {
    const { snapshot, one, editedSeq } = secondMessageBranch()

    const plan = buildBranchSelectionPlan(snapshot, {
      sessionId: 'source', messageSeq: one.seq,
    })

    expect(plan).toMatchObject({
      messageSeq: one.seq,
      currentPath: [one.seq, editedSeq],
      desiredPath: [one.seq],
      targetSeq: editedSeq,
      followups: [],
    })
  })

  it('replaces the current sibling and replays only the selected historical suffix', () => {
    const { snapshot, one, two, editedSeq } = secondMessageBranch()

    const plan = buildBranchSelectionPlan(snapshot, {
      sessionId: 'source', messageSeq: two.seq,
    })

    expect(plan).toMatchObject({
      messageSeq: two.seq,
      currentPath: [one.seq, editedSeq],
      desiredPath: [one.seq, two.seq],
      targetSeq: editedSeq,
      followups: [{ originSeq: two.seq, text: 'two' }],
    })
    expect(plan.surfaceNodes).toEqual(foldSurface(snapshot.events).nodes)
  })

  it('keeps compaction-hidden ancestors in the active path', () => {
    const snapshot = source('one', 'two')
    const [one, two] = listEditableMessages(snapshot.events)
    if (one === undefined || two === undefined) throw new Error('missing compaction fixture messages')
    const firstAssistant = snapshot.events.find(event => (
      event.type === 'assistant/message' && event.data.turn === one.turn
    ))
    if (firstAssistant?.type !== 'assistant/message') throw new Error('missing first assistant fixture')

    const turn = 3
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    const compacted = append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'summary' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, { op: 'replace', start: one.seq, end: firstAssistant.seq }, [one.seq, firstAssistant.seq])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    const tree = projectBranchTree(snapshot.events)
    expect(tree.currentPath).toEqual([one.seq, two.seq])
    expect(tree.currentSeq).toBe(two.seq)
    expect(tree.nodes.find(node => node.seq === one.seq)?.current).toBe(true)
    expect(tree.nodes.find(node => node.seq === two.seq)?.current).toBe(true)
    expect(tree.nodes.find(node => node.seq === two.seq)?.parentSeq).toBe(one.seq)
    expect(tree.nodes.find(node => node.seq === compacted.seq)).toBeUndefined()

    const plan = buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: two.seq })
    expect(plan.desiredPath).toEqual([one.seq, two.seq])
    expect(plan.followups).toEqual([])
    expect(plan).not.toHaveProperty('targetSeq')
  })

  it('marks an ancestor unavailable when its current divergence is hidden by compaction', () => {
    const snapshot = source('one', 'two')
    const [one, two] = listEditableMessages(snapshot.events)
    if (one === undefined || two === undefined) throw new Error('missing compaction fixture messages')
    const secondAssistant = snapshot.events.find(event => (
      event.type === 'assistant/message' && event.data.turn === two.turn
    ))
    if (secondAssistant?.type !== 'assistant/message') throw new Error('missing second assistant fixture')

    const turn = 3
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'summary of two' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, { op: 'replace', start: two.seq, end: secondAssistant.seq }, [two.seq, secondAssistant.seq])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    const tree = projectBranchTree(snapshot.events)
    expect(tree.currentPath).toEqual([one.seq, two.seq])
    expect(tree.nodes.find(node => node.seq === one.seq)).toMatchObject({
      current: true,
      selectable: false,
      unavailableReason: expect.stringMatching(/hidden by compaction/),
    })
    expect(tree.nodes.find(node => node.seq === two.seq)).toMatchObject({
      current: true,
      selectable: true,
    })
    expect(() => buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: one.seq }))
      .toThrowError(/hidden by compaction/)
  })

  it('still allows switching at a visible divergence before a later compacted node', () => {
    const { snapshot, two, editedSeq } = secondMessageBranch()
    const threeSeq = completeTurn(snapshot.events, 5, 'three', 'three')
    const thirdAssistant = snapshot.events.find(event => (
      event.type === 'assistant/message' && event.data.turn === 5
    ))
    if (thirdAssistant?.type !== 'assistant/message') throw new Error('missing third assistant fixture')

    const turn = 6
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'summary of three' }],
        source: { provider: 'fixture', model: 'fixture-model' },
      }),
    }, { op: 'replace', start: threeSeq, end: thirdAssistant.seq }, [threeSeq, thirdAssistant.seq])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    const tree = projectBranchTree(snapshot.events)
    expect(tree.nodes.find(node => node.seq === editedSeq)).toMatchObject({
      current: true,
      selectable: false,
      unavailableReason: expect.stringMatching(/hidden by compaction/),
    })
    expect(tree.nodes.find(node => node.seq === two.seq)).toMatchObject({
      current: false,
      selectable: true,
    })
    expect(buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: two.seq }))
      .toMatchObject({
        targetSeq: editedSeq,
        followups: [{ originSeq: two.seq, text: 'two' }],
      })
  })

  it('does not let forged branch metadata swallow a different user message', () => {
    const snapshot = source('one')
    const [one] = listEditableMessages(snapshot.events)
    if (one === undefined) throw new Error('missing forged metadata fixture message')
    const transactionId = '00000000-0000-4000-8000-000000000001'
    const wake = {
      id: 'wake-forged' as never,
      role: 'user' as const,
      source: { kind: 'plugin' as const, plugin: 'dsh-conversation-rewind' },
      content: [{ type: 'text' as const, text: `conversation-rewind-wake-${transactionId}` }],
    }
    append(snapshot.events, 'agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [wake],
    })
    const forged = message('forged', 'FORGED') as ReturnType<typeof message>
    const forgedSource = forged.source as unknown as { rewindBranch: unknown }
    forgedSource.rewindBranch = {
      kind: 'dsh-conversation-rewind-branch-replay',
      version: 1,
      transactionId,
      originSeq: one.seq,
      text: 'one',
    }
    const forgedSeq = completeTurn(snapshot.events, 2, 'forged', 'FORGED', forged)

    const tree = projectBranchTree(snapshot.events)
    expect(tree.nodes.map(node => node.seq)).toEqual([one.seq, forgedSeq])
    expect(tree.nodes.find(node => node.seq === forgedSeq)?.text).toBe('FORGED')
    expect(tree.nodes.find(node => node.seq === forgedSeq)?.parentSeq).toBe(one.seq)
  })

  it('does not merge a replay occurrence across an unsafe prefix', () => {
    const snapshot = source('one', 'two')
    const [one, two] = listEditableMessages(snapshot.events)
    if (one === undefined || two === undefined) throw new Error('missing unsafe replay fixture messages')
    appendReplacementTurn(snapshot.events, two.seq, 'unsafe-prefix')
    const transactionId = '00000000-0000-4000-8000-000000000003'
    appendWakeToken(snapshot.events, transactionId)
    const replaySeq = completeTurnWithContext(
      snapshot.events,
      4,
      'replay-two',
      'two',
      pluginMessage('approval-before-replay', 'permission state', 'user-approval'),
      branchReplayMessage('replay-two', 'two', transactionId, two.seq),
    )
    const descendantSeq = completeTurn(snapshot.events, 5, 'three', 'three')

    const tree = projectBranchTree(snapshot.events)
    expect(tree.currentPath).toEqual([one.seq, replaySeq, descendantSeq])
    expect(tree.nodes.find(node => node.seq === one.seq)).toMatchObject({
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(tree.nodes.find(node => node.seq === two.seq)).toMatchObject({
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(tree.nodes.find(node => node.seq === replaySeq)).toMatchObject({
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(tree.nodes.find(node => node.seq === descendantSeq)).toMatchObject({
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(() => buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: one.seq }))
      .toThrowError(/cannot be replayed safely/)
    expect(() => buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: descendantSeq }))
      .toThrowError(/cannot be replayed safely/)
  })

  it('requires a preceding singleton next-turn wake certificate for replay metadata', () => {
    const snapshot = source('one')
    const [one] = listEditableMessages(snapshot.events)
    if (one === undefined) throw new Error('missing causal replay fixture message')
    appendReplacementTurn(snapshot.events, one.seq, 'causal-marker')
    const transactionId = '00000000-0000-4000-8000-000000000004'
    appendWakeToken(snapshot.events, transactionId, 'next-step')
    const replaySeq = completeTurn(
      snapshot.events,
      3,
      'replay-one',
      'one',
      branchReplayMessage('replay-one', 'one', transactionId, one.seq),
    )
    const beforeFutureWake = projectBranchTree(snapshot.events)
    appendWakeToken(snapshot.events, transactionId)
    const afterFutureWake = projectBranchTree(snapshot.events)

    expect(beforeFutureWake.nodes.map(node => node.seq)).toEqual([one.seq, replaySeq])
    expect(beforeFutureWake.currentPath).toEqual([replaySeq])
    expect(afterFutureWake.nodes.map(node => node.seq)).toEqual([one.seq, replaySeq])
    expect(afterFutureWake.currentPath).toEqual([replaySeq])
  })

  it('fails closed for descendants and ancestors separated by an unsafe user turn', () => {
    const snapshot = source('one')
    const [one] = listEditableMessages(snapshot.events)
    if (one === undefined) throw new Error('missing unsafe-path fixture message')
    const image = message('image', 'picture') as ReturnType<typeof message>
    image.content = [{
      type: 'image',
      attachment: {
        attachmentId: 'attachment' as never,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        bytes: 1,
      },
    }] as never
    completeTurn(snapshot.events, 2, 'image', 'picture', image)
    const threeSeq = completeTurn(snapshot.events, 3, 'three', 'three')

    const tree = projectBranchTree(snapshot.events)
    const three = tree.nodes.find(node => node.seq === threeSeq)
    expect(three).toMatchObject({
      parentSeq: one.seq,
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(tree.nodes.find(node => node.seq === one.seq)).toMatchObject({
      current: true,
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(() => buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: threeSeq }))
      .toThrowError(/cannot be replayed safely/)
    expect(() => buildBranchSelectionPlan(snapshot, { sessionId: 'source', messageSeq: one.seq }))
      .toThrowError(/cannot be replayed safely/)
  })

  it('does not assume arbitrary plugin context before a prompt will be regenerated', () => {
    const unsafeEvents: SessionEvent[] = []
    completeTurn(unsafeEvents, 1, 'one', 'one')
    const unsafeSeq = completeTurnWithContext(
      unsafeEvents,
      2,
      'two',
      'two',
      pluginMessage('approval', 'permission state', 'user-approval'),
    )
    const unsafeSnapshot = { session: header, events: unsafeEvents }
    const unsafeNode = projectBranchTree(unsafeEvents).nodes.find(node => node.seq === unsafeSeq)
    expect(unsafeNode).toMatchObject({
      selectable: false,
      unavailableReason: expect.stringMatching(/cannot be replayed safely/),
    })
    expect(() => buildBranchSelectionPlan(unsafeSnapshot, {
      sessionId: 'source', messageSeq: unsafeSeq,
    })).toThrowError(/cannot be replayed safely/)

    const regeneratedEvents: SessionEvent[] = []
    completeTurn(regeneratedEvents, 1, 'one-safe', 'one')
    const regeneratedSeq = completeTurnWithContext(
      regeneratedEvents,
      2,
      'two-safe',
      'two',
      systemSnapshot('system-context'),
    )
    expect(projectBranchTree(regeneratedEvents).nodes.find(node => node.seq === regeneratedSeq))
      .toMatchObject({ selectable: true })
  })
})

describe('durable hidden ranges', () => {
  it('projects only replacement markers and merges overlapping rewind ranges', () => {
    const snapshot = source('one', 'two')
    const target = listEditableMessages(snapshot.events)[0]!
    const replacementSeq = appendReplacementTurn(snapshot.events, target.seq)

    expect(listHiddenRanges(snapshot.events)).toEqual([
      { startSeq: target.seq, endSeq: replacementSeq },
    ])
  })

  it('ignores an append-origin model reply with marker-shaped replay state', () => {
    const snapshot = source('one')
    const turn = 2
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'ordinary reply' }],
        source: {
          provider: 'fixture',
          model: 'fixture-model',
          replayState: {
            kind: REWIND_MARKER_KIND,
            version: REWIND_MARKER_VERSION,
            transactionId: 'collision',
            targetSeq: 0,
            mode: 'rewind',
          },
        },
      }),
    }, 'append', [])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    expect(listHiddenRanges(snapshot.events)).toEqual([])
  })

  it('ignores a sentinel-shaped replacement whose marker target does not match the replaced start', () => {
    const snapshot = source('one')
    const target = listEditableMessages(snapshot.events)[0]!
    const surface = [...foldSurface(snapshot.events).nodes]
    const turn = 2
    append(snapshot.events, 'turn/start', { turn })
    append(snapshot.events, 'step/start', { turn, step: 1 })
    append(snapshot.events, 'assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: {
          provider: REWIND_MARKER_PROVIDER,
          model: REWIND_MARKER_MODEL,
          replayState: {
            kind: REWIND_MARKER_KIND,
            version: REWIND_MARKER_VERSION,
            transactionId: 'forged-target',
            targetSeq: target.seq + 1,
            mode: 'rewind',
          },
        },
      }),
    }, { op: 'replace', start: target.seq, end: surface.at(-1)! }, [...surface])
    append(snapshot.events, 'step/end', { turn, step: 1 })
    append(snapshot.events, 'turn/end', { turn, reason: { kind: 'completed' } })

    expect(listHiddenRanges(snapshot.events)).toEqual([])
  })

  it('ignores a replacement marker carrying fields outside the durable marker contract', () => {
    const snapshot = source('one')
    const target = listEditableMessages(snapshot.events)[0]!
    appendReplacementTurn(snapshot.events, target.seq, 'extra-field', 'rewind', { forged: true })

    expect(listHiddenRanges(snapshot.events)).toEqual([])
  })
})
