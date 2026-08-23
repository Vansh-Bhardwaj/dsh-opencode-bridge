import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  foldSurface,
  isReplacementSurfaceEvent,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {
  RewindBranchNodeView,
  RewindBranchSelectRequest,
  RewindBranchTreeView,
  RewindHiddenRange,
  RewindMessageView,
  RewindModelView,
  RewindRequest,
} from './protocol.ts'

export const REWIND_MARKER_KIND = 'dsh-conversation-rewind'
export const REWIND_MARKER_VERSION = 1
export const REWIND_MARKER_PROVIDER = 'dsh-conversation-rewind'
export const REWIND_MARKER_MODEL = 'surface-rewind'

export interface RewindReplayMarker {
  kind: typeof REWIND_MARKER_KIND
  version: typeof REWIND_MARKER_VERSION
  transactionId: string
  targetSeq: number
  mode: 'rewind' | 'cleanup'
}

const REWIND_REPLAY_MARKER_KEYS = [
  'kind',
  'version',
  'transactionId',
  'targetSeq',
  'mode',
] as const

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
}

/** One complete source-log observation. */
export interface RewindSourceSnapshot {
  session: SessionHeader
  events: SessionEvent[]
}

interface ClosedTurn {
  turn: number
  startIndex: number
  startSeq: number
  endIndex: number
  endSeq: number
  userMessages: SessionEvent<'user/message'>[]
  humanMessages: SessionEvent<'user/message'>[]
}

interface TurnAnalysis {
  closed: ClosedTurn[]
  openTurn: number | null
}

/** Fully validated material needed to replace the current same-Session surface tail. */
export interface RewindPlan {
  target: RewindMessageView
  surfaceNodes: number[]
  shadowedSeqs: number[]
  followups: string[]
  model?: RewindModelView
}

/** Resolved semantic path used for read-only branch browsing. */
export interface RewindBranchQuery {
  messageSeq: number
  currentPath: number[]
  desiredPath: number[]
}

/** @deprecated Use {@link queryConversationBranch}; retained for API compatibility. */
export interface RewindBranchSelectionPlan {
  messageSeq: number
  currentPath: number[]
  desiredPath: number[]
  /** Current-surface message replaced at the first divergence. */
  targetSeq?: number
  surfaceNodes: number[]
  followups: { originSeq: number; text: string }[]
}

/** Business error with a stable HTTP mapping. */
export class ConversationRewindError extends Error {
  override readonly name = 'ConversationRewindError'

  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: { sessionId?: string; replacementSeq?: number },
  ) {
    super(message)
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new ConversationRewindError(code, message, status)
}

function analyzeTurns(events: readonly SessionEvent[]): TurnAnalysis {
  const closed: ClosedTurn[] = []
  let current: Omit<ClosedTurn, 'endIndex' | 'endSeq'> | undefined

  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      fail('INVALID_SESSION', `session event ${String(index)} has seq ${String(event.seq)}`, 409)
    }
    if (event.type === 'turn/start') {
      if (current !== undefined) {
        fail('INVALID_SESSION', `turn ${String(current.turn)} is still open`, 409)
      }
      current = {
        turn: event.data.turn,
        startIndex: index,
        startSeq: event.seq,
        userMessages: [],
        humanMessages: [],
      }
      continue
    }
    if (event.type === 'user/message' && current !== undefined) {
      current.userMessages.push(event)
      if (event.data.source.kind === 'user') current.humanMessages.push(event)
      continue
    }
    if (event.type !== 'turn/end') continue
    if (current === undefined || current.turn !== event.data.turn) {
      fail('INVALID_SESSION', `turn/end ${String(event.data.turn)} has no matching turn/start`, 409)
    }
    closed.push({
      ...current,
      endIndex: index,
      endSeq: event.seq,
    })
    current = undefined
  }

  return { closed, openTurn: current?.turn ?? null }
}

/** Return text only for the deliberately narrow, attachment-safe input shape. */
export function plainUserText(event: SessionEvent<'user/message'>): string | undefined {
  if (event.data.source.kind !== 'user' || event.data.content.length !== 1) return undefined
  const block = event.data.content[0]
  return block?.type === 'text' ? block.text : undefined
}

/** Context that the runtime safely regenerates at a later real request. */
export function isRegeneratedContext(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { kind: string; plugin?: string; form?: string }
  return (source.kind === 'plugin'
      && source.plugin === '@deepseek-ai/dsh-system-prompt'
      && source.form === 'snapshot')
    || (source.kind === 'skill-catalog' && source.form === 'catalog')
}

function editableTurn(turn: ClosedTurn): RewindMessageView | undefined {
  if (turn.humanMessages.length !== 1) return undefined
  const event = turn.humanMessages[0]
  if (event === undefined) return undefined
  const text = plainUserText(event)
  if (text === undefined) return undefined
  return {
    seq: event.seq,
    turn: turn.turn,
    turnStartSeq: turn.startSeq,
    turnEndSeq: turn.endSeq,
    text,
    time: event.time,
  }
}

/**
 * Editing replaces the current Surface starting at the direct user message.
 * Current user-role context before that message remains on the Surface and is
 * therefore safe to retain. Context after it would be shadowed, so only the
 * two Host-owned forms that the next real request regenerates are allowed.
 */
function hasReplaySafeTargetSurface(
  turn: ClosedTurn,
  target: SessionEvent<'user/message'>,
  surface: ReadonlySet<number>,
): boolean {
  if (turn.humanMessages.length !== 1 || turn.humanMessages[0]?.seq !== target.seq) return false
  const targetIndex = turn.userMessages.findIndex(event => event.seq === target.seq)
  if (targetIndex < 0) return false
  return turn.userMessages.slice(targetIndex + 1).every(event => (
    !surface.has(event.seq) || isRegeneratedContext(event)
  ))
}

/** Every current user-role event in a replayed tail is shadowed by the edit. */
function hasReplaySafeTailSurface(
  turn: ClosedTurn,
  human: SessionEvent<'user/message'>,
  surface: ReadonlySet<number>,
): boolean {
  return turn.userMessages.every(event => (
    !surface.has(event.seq)
    || event.seq === human.seq
    || isRegeneratedContext(event)
  ))
}

function latestCallConfig(events: readonly SessionEvent[]): LlmCallConfig | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return event.data.header.config
  }
  return undefined
}

/**
 * Locate the durable single-message enqueue event that introduced the direct
 * user message later claimed by the target turn. Same-Session rewind does not
 * require that enqueue to happen after the preceding turn: DSH may safely park
 * several next-turn messages ahead of time, provided each insertion has one
 * unambiguous identity.
 */
function messageInsertionIndex(
  events: readonly SessionEvent[],
  target: SessionEvent<'user/message'>,
  turnStartIndex: number,
): number | undefined {
  for (let index = turnStartIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced' || event.data.target !== 'next-turn') continue
    if (!event.data.inserted.some(message => message.id === target.data.id)) continue
    if (event.data.inserted.length !== 1) return undefined
    return index
  }
  return undefined
}

/** Project the latest selectable model route without exposing the full request header. */
export function projectModel(events: readonly SessionEvent[]): RewindModelView | undefined {
  const config = latestCallConfig(events)
  if (config === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
  }
}

/** List only completed turns that can be reproduced without attachment or batching ambiguity. */
export function listEditableMessages(events: readonly SessionEvent[]): RewindMessageView[] {
  const surface = new Set(foldSurface(events).nodes)
  const turns = analyzeTurns(events).closed
  return turns.flatMap((turn) => {
    const projected = editableTurn(turn)
    const target = turn.humanMessages[0]
    if (projected === undefined || target === undefined) return []
    if (!surface.has(target.seq) || target.surfaceOp !== 'append') return []
    if (!hasReplaySafeTargetSurface(turn, target, surface)) return []
    return messageInsertionIndex(events, target, turn.startIndex) === undefined
      ? []
      : [projected]
  })
}

function historicallySelectableSeqs(events: readonly SessionEvent[], turns: readonly ClosedTurn[]): Set<number> {
  const selectable = new Set<number>()
  for (const turn of turns) {
    const target = turn.humanMessages[0]
    if (target === undefined || editableTurn(turn) === undefined || target.surfaceOp !== 'append') continue
    const prefix = events.slice(0, turn.endIndex + 1)
    const surface = new Set(foldSurface(prefix).nodes)
    if (!surface.has(target.seq) || !hasReplaySafeTargetSurface(turn, target, surface)) continue
    if (messageInsertionIndex(events, target, turn.startIndex) !== undefined) selectable.add(target.seq)
  }
  return selectable
}

interface BranchReplayMetadata {
  kind: 'dsh-conversation-rewind-branch-replay'
  version: 1
  transactionId: string
  originSeq: number
  text: string
}

type HistoricalBranchNode = Omit<
  RewindBranchNodeView,
  'current' | 'path' | 'branchEnd' | 'turnStartSeq' | 'turnEndSeq'
> & Pick<RewindMessageView, 'turnStartSeq' | 'turnEndSeq'>

const BRANCH_REPLAY_METADATA_KEYS = ['kind', 'version', 'transactionId', 'originSeq', 'text'] as const
const REWIND_WAKE_PREFIX = 'conversation-rewind-wake-'
const BRANCH_UNSAFE_REASON = 'this branch crosses a user turn or context that cannot be replayed safely'
const BRANCH_HIDDEN_REASON = 'the active divergence message is hidden by compaction or another replacement checkpoint'

function isTransactionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** Durable plugin-owned wake tokens certify branch replay metadata after restart. */
function branchReplayTransactions(events: readonly SessionEvent[]): ReadonlyMap<string, number> {
  const transactions = new Map<string, number>()
  for (const event of events) {
    if (
      event.type !== 'agent/inbox/spliced'
      || event.data.target !== 'next-turn'
      || event.data.inserted.length !== 1
      || (event.data.removedCount !== undefined && event.data.removedCount !== 0)
      || event.data.outcome !== undefined
    ) continue
    const message = event.data.inserted[0]
    if (message === undefined) continue
    const source = message.source
    const block = message.content[0]
    if (
      !hasExactOwnKeys(source, ['kind', 'plugin'])
      || source.kind !== 'plugin'
      || source.plugin !== 'dsh-conversation-rewind'
      || message.content.length !== 1
      || block === undefined
      || !hasExactOwnKeys(block, ['type', 'text'])
      || block.type !== 'text'
      || !block.text.startsWith(REWIND_WAKE_PREFIX)
    ) continue
    const transactionId = block.text.slice(REWIND_WAKE_PREFIX.length)
    if (isTransactionId(transactionId) && !transactions.has(transactionId)) {
      transactions.set(transactionId, event.seq)
    }
  }
  return transactions
}

/** Read and strictly validate metadata attached to a same-Session branch replay message. */
function branchReplayMetadata(event: SessionEvent<'user/message'>): BranchReplayMetadata | undefined {
  if (event.data.source.kind !== 'user') return
  const source = event.data.source as unknown as { rewindBranch?: unknown }
  const value = source.rewindBranch
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const candidate = value as Partial<BranchReplayMetadata>
  if (
    Object.keys(value).length !== BRANCH_REPLAY_METADATA_KEYS.length
    || !BRANCH_REPLAY_METADATA_KEYS.every(key => Object.hasOwn(value, key))
    || candidate.kind !== 'dsh-conversation-rewind-branch-replay'
    || candidate.version !== 1
    || !isTransactionId(candidate.transactionId)
    || !Number.isSafeInteger(candidate.originSeq)
    || (candidate.originSeq ?? -1) < 0
    || typeof candidate.text !== 'string'
  ) return
  return candidate as BranchReplayMetadata
}

/** Resolve an origin only when the occurrence is structurally consistent and plugin-certified. */
function branchReplayOrigin(
  event: SessionEvent<'user/message'>,
  parent: number | undefined,
  views: ReadonlyMap<number, HistoricalBranchNode>,
  parentByLogical: ReadonlyMap<number, number | undefined>,
  trustedTransactions: ReadonlyMap<string, number>,
): number | undefined {
  const metadata = branchReplayMetadata(event)
  const certificateSeq = metadata === undefined
    ? undefined
    : trustedTransactions.get(metadata.transactionId)
  if (metadata === undefined || certificateSeq === undefined || certificateSeq >= event.seq) return
  const origin = views.get(metadata.originSeq)
  const text = plainUserText(event)
  if (
    origin === undefined
    || !origin.selectable
    || text === undefined
    || text !== metadata.text
    || text !== origin.text
    || parentByLogical.get(metadata.originSeq) !== parent
  ) return
  return metadata.originSeq
}

function latestLineage(
  nodes: readonly number[],
  lineageBySurfaceSeq: ReadonlyMap<number, number | undefined>,
): number | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const lineage = lineageBySurfaceSeq.get(nodes[index] ?? -1)
    if (lineage !== undefined) return lineage
  }
  return
}

function latestReplaySafe(
  nodes: readonly number[],
  replaySafeBySurfaceSeq: ReadonlyMap<number, boolean>,
): boolean {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const safe = replaySafeBySurfaceSeq.get(nodes[index] ?? -1)
    if (safe !== undefined) return safe
  }
  return true
}

function pathForBranchSeq(
  seq: number,
  bySeq: ReadonlyMap<number, unknown>,
  parentByLogical: ReadonlyMap<number, number | undefined>,
): number[] {
  const path: number[] = []
  const seen = new Set<number>()
  let cursor: number | undefined = seq
  while (cursor !== undefined) {
    if (seen.has(cursor)) fail('INVALID_SESSION', 'the message branch tree contains a cycle', 409)
    if (!bySeq.has(cursor)) fail('INVALID_SESSION', 'the message branch tree has a missing parent', 409)
    seen.add(cursor)
    path.push(cursor)
    cursor = parentByLogical.get(cursor)
  }
  path.reverse()
  return path
}

function visualParentSeq(
  seq: number,
  parentByLogical: ReadonlyMap<number, number | undefined>,
  childCountByLogical: ReadonlyMap<number, number>,
): number | undefined {
  const seen = new Set<number>([seq])
  let cursor = parentByLogical.get(seq)
  while (cursor !== undefined) {
    if (seen.has(cursor)) fail('INVALID_SESSION', 'the message branch tree contains a cycle', 409)
    seen.add(cursor)
    if (parentByLogical.get(cursor) === undefined || (childCountByLogical.get(cursor) ?? 0) > 1) {
      return cursor
    }
    cursor = parentByLogical.get(cursor)
  }
  return
}

interface ProjectedBranchState {
  tree: RewindBranchTreeView
  parentByLogical: ReadonlyMap<number, number | undefined>
}

/** Project every durable ordinary-user path plus the currently active path. */
function projectBranchState(events: readonly SessionEvent[]): ProjectedBranchState {
  // Canonical folding validates the complete log before the lightweight
  // incremental pass derives parent relationships.
  foldSurface(events)
  const turns = analyzeTurns(events).closed
  const messageBySeq = new Map<number, RewindMessageView>()
  const selectable = historicallySelectableSeqs(events, turns)
  const trustedTransactions = branchReplayTransactions(events)
  for (const turn of turns) {
    const message = editableTurn(turn)
    if (message !== undefined) messageBySeq.set(message.seq, message)
  }

  const surface: number[] = []
  const lineageBySurfaceSeq = new Map<number, number | undefined>()
  const replaySafeBySurfaceSeq = new Map<number, boolean>()
  const logicalByOccurrence = new Map<number, number>()
  const parentByLogical = new Map<number, number | undefined>()
  const views = new Map<number, HistoricalBranchNode>()

  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (event.surfaceOp === undefined) continue
    if (event.surfaceOp === 'append') {
      const parent = latestLineage(surface, lineageBySurfaceSeq)
      const prefixSafe = latestReplaySafe(surface, replaySafeBySurfaceSeq)
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        const message = messageBySeq.get(event.seq)
        if (message !== undefined) {
          // A replay occurrence may inherit a logical origin only while the
          // current prefix is itself replay-safe.  Otherwise an unsafe plugin
          // or attachment-bearing context before the occurrence would be
          // erased by the origin's historical `selectable` flag.
          const origin = prefixSafe
            ? branchReplayOrigin(event, parent, views, parentByLogical, trustedTransactions)
            : undefined
          const logicalSeq = origin !== undefined && views.has(origin) ? origin : event.seq
          logicalByOccurrence.set(event.seq, logicalSeq)
          if (!views.has(logicalSeq)) {
            const nodeSelectable = selectable.has(event.seq)
              && prefixSafe
              && (parent === undefined || views.get(parent)?.selectable === true)
            const unavailableReason = nodeSelectable ? undefined : BRANCH_UNSAFE_REASON
            parentByLogical.set(logicalSeq, parent)
            views.set(logicalSeq, {
              seq: logicalSeq,
              ...(parent === undefined ? {} : { parentSeq: parent }),
              turn: message.turn,
              turnStartSeq: message.turnStartSeq,
              turnEndSeq: message.turnEndSeq,
              text: message.text,
              time: message.time,
              selectable: nodeSelectable,
              ...(unavailableReason === undefined ? {} : { unavailableReason }),
            })
          }
          lineageBySurfaceSeq.set(event.seq, logicalSeq)
          replaySafeBySurfaceSeq.set(
            event.seq,
            prefixSafe && views.get(logicalSeq)?.selectable === true,
          )
        } else {
          lineageBySurfaceSeq.set(event.seq, parent)
          replaySafeBySurfaceSeq.set(event.seq, false)
        }
      } else {
        lineageBySurfaceSeq.set(event.seq, parent)
        replaySafeBySurfaceSeq.set(
          event.seq,
          prefixSafe && (event.type !== 'user/message' || isRegeneratedContext(event)),
        )
      }
      surface.push(event.seq)
      continue
    }

    const startIndex = surface.indexOf(event.surfaceOp.start)
    const endIndex = surface.indexOf(event.surfaceOp.end)
    if (startIndex < 0 || endIndex < startIndex) {
      throw new ConversationRewindError('INVALID_SESSION', 'branch projection encountered an invalid replacement range', 409)
    }
    const shadowed = surface.slice(startIndex, endIndex + 1)
    const marker = replayMarker(event)
    let lineage: number | undefined
    if (marker !== undefined) {
      const targetLogical = logicalByOccurrence.get(marker.targetSeq)
      lineage = targetLogical === undefined
        ? latestLineage(surface.slice(0, startIndex), lineageBySurfaceSeq)
        : parentByLogical.get(targetLogical)
    } else {
      lineage = latestLineage(shadowed, lineageBySurfaceSeq)
        ?? latestLineage(surface.slice(0, startIndex), lineageBySurfaceSeq)
    }
    surface.splice(startIndex, endIndex - startIndex + 1, event.seq)
    lineageBySurfaceSeq.set(event.seq, lineage)
    const prefixSafe = latestReplaySafe(surface.slice(0, startIndex), replaySafeBySurfaceSeq)
    const shadowSafe = latestReplaySafe(shadowed, replaySafeBySurfaceSeq)
    replaySafeBySurfaceSeq.set(event.seq, marker !== undefined ? prefixSafe : prefixSafe && shadowSafe)
  }

  // The active surface can contain a compaction/replacement node that hides
  // earlier user occurrences.  Its lineage still points at the logical leaf,
  // so rebuild the complete active path from that lineage rather than only
  // looking at logical occurrences that remain directly visible on `surface`.
  const currentPathReversed: number[] = []
  const currentSeen = new Set<number>()
  let currentCursor = latestLineage(surface, lineageBySurfaceSeq)
  while (currentCursor !== undefined) {
    if (currentSeen.has(currentCursor)) {
      throw new ConversationRewindError('INVALID_SESSION', 'the active message lineage contains a cycle', 409)
    }
    currentSeen.add(currentCursor)
    if (!views.has(currentCursor)) break
    currentPathReversed.push(currentCursor)
    currentCursor = parentByLogical.get(currentCursor)
  }
  const currentPath = currentPathReversed.reverse()
  const current = new Set(currentPath)
  // A branch can be historically safe yet impossible to select from this
  // active Surface.  For example, an attachment-bearing turn may sit between
  // a current ancestor and its next visible text node, or compaction may hide
  // the current divergence user message entirely.  Mark such candidates
  // unavailable in the projection so the UI does not offer an operation that
  // is guaranteed to fail (or leave unsafe context on the Surface).
  const activeLogical = new Set<number>()
  for (const seq of surface) {
    const logical = logicalByOccurrence.get(seq)
    if (logical !== undefined) activeLogical.add(logical)
  }
  const childCountByLogical = new Map<number, number>()
  for (const parent of parentByLogical.values()) {
    if (parent === undefined) continue
    childCountByLogical.set(parent, (childCountByLogical.get(parent) ?? 0) + 1)
  }
  const baseBySeq = new Map<number, RewindBranchNodeView>([...views.values()].map((node) => {
    const displayParent = visualParentSeq(node.seq, parentByLogical, childCountByLogical)
    return [node.seq, {
      seq: node.seq,
      ...(displayParent === undefined ? {} : { parentSeq: displayParent }),
      turn: node.turn,
      turnStartSeq: node.turnStartSeq,
      turnEndSeq: node.turnEndSeq,
      text: node.text,
      time: node.time,
      path: pathForBranchSeq(node.seq, views, parentByLogical),
      branchEnd: (childCountByLogical.get(node.seq) ?? 0) === 0,
      current: current.has(node.seq),
      selectable: node.selectable,
      ...(node.unavailableReason === undefined ? {} : { unavailableReason: node.unavailableReason }),
    }]
  }))
  const projectedBySeq = new Map(baseBySeq)
  for (const node of baseBySeq.values()) {
    if (!node.selectable) continue
    const desiredPath = pathForBranchSeq(node.seq, baseBySeq, parentByLogical)
    let common = 0
    while (
      common < currentPath.length
      && common < desiredPath.length
      && currentPath[common] === desiredPath[common]
    ) common += 1
    if (common >= currentPath.length) continue
    const targetLogical = currentPath[common]
    const targetNode = targetLogical === undefined ? undefined : baseBySeq.get(targetLogical)
    const reason = targetLogical === undefined || !activeLogical.has(targetLogical)
      ? BRANCH_HIDDEN_REASON
      : targetNode?.selectable !== true
        ? (targetNode?.unavailableReason ?? BRANCH_UNSAFE_REASON)
        : undefined
    if (reason !== undefined) {
      projectedBySeq.set(node.seq, {
        ...node,
        selectable: false,
        unavailableReason: reason,
      })
    }
  }
  const nodes = [...projectedBySeq.values()]
    .sort((left, right) => left.time - right.time || left.seq - right.seq)
    .map((node): RewindBranchNodeView => node)
  const currentSeq = currentPath.at(-1)
  return {
    tree: {
      nodes,
      currentPath,
      ...(currentSeq === undefined ? {} : { currentSeq }),
    },
    parentByLogical,
  }
}

/**
 * Project the semantic message paths as visual branch segments. Consecutive
 * messages stay at one indentation level; a root or a node with multiple
 * logical successors anchors the next visible level.
 */
export function projectBranchTree(events: readonly SessionEvent[]): RewindBranchTreeView {
  return projectBranchState(events).tree
}

function validateBranchRequest(request: RewindBranchSelectRequest): void {
  if (request.sessionId.trim() === '') fail('INVALID_REQUEST', 'sessionId is required')
  if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0) {
    fail('INVALID_REQUEST', 'messageSeq must be a non-negative safe integer')
  }
}

/** Resolve a completed branch endpoint without mutating or replaying its Session. */
export function queryConversationBranch(
  snapshot: RewindSourceSnapshot,
  request: RewindBranchSelectRequest,
): RewindBranchQuery {
  validateBranchRequest(request)
  if (snapshot.session.id !== request.sessionId) {
    fail('INVALID_REQUEST', 'sessionId does not match the loaded Session', 409)
  }
  const tree = projectBranchTree(snapshot.events)
  const selected = tree.nodes.find(node => node.seq === request.messageSeq)
  if (selected === undefined) {
    fail('MESSAGE_NOT_FOUND', `branch message seq ${String(request.messageSeq)} is unavailable`, 404)
  }
  if (!selected.branchEnd) {
    fail('BRANCH_NOT_ENDPOINT', 'only the final message of a conversation branch can be opened', 409)
  }
  return {
    messageSeq: selected.seq,
    currentPath: [...tree.currentPath],
    desiredPath: [...selected.path],
  }
}

/** Build the divergence replacement and historical user path for one tree selection. */
export function buildBranchSelectionPlan(
  snapshot: RewindSourceSnapshot,
  request: RewindBranchSelectRequest,
): RewindBranchSelectionPlan {
  validateBranchRequest(request)
  if (snapshot.session.id !== request.sessionId) {
    fail('INVALID_REQUEST', 'sessionId does not match the loaded Session', 409)
  }
  const analysis = analyzeTurns(snapshot.events)
  if (analysis.openTurn !== null) {
    fail('SOURCE_BUSY', `turn ${String(analysis.openTurn)} is still running`, 409)
  }
  const projection = projectBranchState(snapshot.events)
  const tree = projection.tree
  const bySeq = new Map(tree.nodes.map(node => [node.seq, node]))
  const selected = bySeq.get(request.messageSeq)
  if (selected === undefined) {
    fail('MESSAGE_NOT_FOUND', `branch message seq ${String(request.messageSeq)} is unavailable`, 404)
  }
  if (!selected.selectable) {
    fail(
      'BRANCH_UNAVAILABLE',
      selected.unavailableReason ?? 'the selected branch cannot be replayed safely',
      409,
    )
  }

  const desiredPath = pathForBranchSeq(selected.seq, bySeq, projection.parentByLogical)

  let common = 0
  while (
    common < tree.currentPath.length
    && common < desiredPath.length
    && tree.currentPath[common] === desiredPath[common]
  ) common += 1

  const surfaceNodes = [...foldSurface(snapshot.events).nodes]
  const trustedTransactions = branchReplayTransactions(snapshot.events)
  let targetSeq: number | undefined
  if (common < tree.currentPath.length) {
    const targetLogical = tree.currentPath[common]
    const targetNode = bySeq.get(targetLogical)
    for (const seq of surfaceNodes) {
      const event = snapshot.events[seq]
      if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
      const metadata = branchReplayMetadata(event)
      const text = plainUserText(event)
      const certificateSeq = metadata === undefined
        ? undefined
        : trustedTransactions.get(metadata.transactionId)
      const isOriginOccurrence = metadata !== undefined
        && certificateSeq !== undefined
        && certificateSeq < event.seq
        && metadata.originSeq === targetLogical
        && targetNode !== undefined
        && text === metadata.text
        && text === targetNode.text
      if (event.seq === targetLogical || isOriginOccurrence) {
        targetSeq = event.seq
        break
      }
    }
    if (targetSeq === undefined) {
      fail('BRANCH_UNAVAILABLE', BRANCH_HIDDEN_REASON, 409)
    }
    const currentNode = targetLogical === undefined ? undefined : bySeq.get(targetLogical)
    buildRewindPlan(snapshot, {
      sessionId: request.sessionId,
      messageSeq: targetSeq,
      text: currentNode?.text ?? selected.text,
      cascade: 'truncate',
    })
  }

  const followups = desiredPath.slice(common).map((seq) => {
    const node = bySeq.get(seq)
    if (node === undefined || !node.selectable) {
      fail('BRANCH_UNAVAILABLE', 'the selected branch contains a message that cannot be replayed safely', 409)
    }
    return { originSeq: node.seq, text: node.text }
  })
  return {
    messageSeq: selected.seq,
    currentPath: [...tree.currentPath],
    desiredPath,
    ...(targetSeq === undefined ? {} : { targetSeq }),
    surfaceNodes,
    followups,
  }
}

function validateRequest(request: RewindRequest): void {
  if (request.sessionId.trim() === '') fail('INVALID_REQUEST', 'sessionId is required')
  if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0) {
    fail('INVALID_REQUEST', 'messageSeq must be a non-negative safe integer')
  }
  if (request.text.trim() === '') fail('INVALID_REQUEST', 'edited text must not be blank')
  if (request.cascade !== 'truncate' && request.cascade !== 'preserve') {
    fail('INVALID_REQUEST', 'cascade must be "truncate" or "preserve"')
  }
}

function preservedTail(
  events: readonly SessionEvent[],
  turns: readonly ClosedTurn[],
  targetIndex: number,
  surface: ReadonlySet<number>,
  tailSurfaceNodes: readonly number[],
): string[] {
  for (const seq of tailSurfaceNodes) {
    const event = events[seq]
    if (event === undefined) {
      fail('INVALID_SESSION', `surface event ${String(seq)} is missing`, 409)
    }
    if (isReplacementSurfaceEvent(event) && replayMarker(event) === undefined) {
      fail(
        'UNSUPPORTED_TAIL',
        'the preserved tail crosses a compaction or another replacement checkpoint',
        409,
      )
    }
    if (
      event.type === 'user/message'
      && event.data.source.kind !== 'user'
      && !isRegeneratedContext(event)
    ) {
      fail(
        'UNSUPPORTED_TAIL',
        'the preserved tail contains non-regenerated user-role context',
        409,
      )
    }
  }

  const tail: string[] = []
  for (const turn of turns.slice(targetIndex + 1)) {
    const currentHumans = turn.humanMessages.filter(message => surface.has(message.seq))
    if (currentHumans.length === 0) continue
    if (currentHumans.length !== 1) {
      fail(
        'UNSUPPORTED_TAIL',
        `turn ${String(turn.turn)} does not contain exactly one ordinary user message`,
        409,
      )
    }
    const message = currentHumans[0]
    if (message === undefined || !hasReplaySafeTailSurface(turn, message, surface)) {
      fail(
        'UNSUPPORTED_TAIL',
        `turn ${String(turn.turn)} contains additional non-regenerated user-role context`,
        409,
      )
    }
    const text = plainUserText(message)
    if (text === undefined) {
      fail(
        'UNSUPPORTED_TAIL',
        `turn ${String(turn.turn)} contains attachments or non-text content`,
        409,
      )
    }
    tail.push(text)
  }
  return tail
}

/**
 * Build an immutable same-Session rewind plan. The source array and every
 * source event are borrowed read-only; only scalar/text projections are returned.
 */
export function buildRewindPlan(
  snapshot: RewindSourceSnapshot,
  request: RewindRequest,
): RewindPlan {
  validateRequest(request)
  if (snapshot.session.id !== request.sessionId) {
    fail('INVALID_REQUEST', 'sessionId does not match the loaded Session', 409)
  }
  const analysis = analyzeTurns(snapshot.events)
  if (analysis.openTurn !== null) {
    fail('SOURCE_BUSY', `turn ${String(analysis.openTurn)} is still running`, 409)
  }
  const surfaceNodes = [...foldSurface(snapshot.events).nodes]
  const surface = new Set(surfaceNodes)
  const targetIndex = analysis.closed.findIndex(turn =>
    turn.humanMessages.some(event => event.seq === request.messageSeq))
  if (targetIndex === -1) {
    fail('MESSAGE_NOT_FOUND', `message seq ${String(request.messageSeq)} is not in a completed turn`, 404)
  }
  const targetTurn = analysis.closed[targetIndex]
  if (targetTurn === undefined) {
    fail('MESSAGE_NOT_FOUND', `message seq ${String(request.messageSeq)} is not in a completed turn`, 404)
  }
  const targetEvent = targetTurn.humanMessages[0]
  const before = targetEvent === undefined ? undefined : plainUserText(targetEvent)
  if (targetTurn.humanMessages.length !== 1 || targetEvent === undefined || before === undefined) {
    fail('UNSUPPORTED_MESSAGE', 'only a single plain-text user message can be edited', 409)
  }
  if (!surface.has(targetEvent.seq) || targetEvent.surfaceOp !== 'append') {
    fail('MESSAGE_NOT_FOUND', `message seq ${String(request.messageSeq)} is no longer on the current surface`, 404)
  }
  if (!hasReplaySafeTargetSurface(targetTurn, targetEvent, surface)) {
    fail(
      'UNSUPPORTED_MESSAGE',
      'the target turn contains non-regenerated user-role context after the message',
      409,
    )
  }

  const target = editableTurn(targetTurn)
  if (target === undefined) {
    fail('UNSUPPORTED_MESSAGE', 'only a single plain-text user message can be edited', 409)
  }
  const cutIndex = messageInsertionIndex(snapshot.events, targetEvent, targetTurn.startIndex)
  if (cutIndex === undefined) {
    fail(
      'UNSUPPORTED_MESSAGE',
      'the target message has no unambiguous single-message insertion boundary',
      409,
    )
  }
  const targetSurfaceIndex = surfaceNodes.indexOf(targetEvent.seq)
  if (targetSurfaceIndex < 0) {
    fail('MESSAGE_NOT_FOUND', `message seq ${String(request.messageSeq)} is no longer on the current surface`, 404)
  }
  const followups = [
    request.text,
    ...(request.cascade === 'preserve'
      ? preservedTail(
          snapshot.events,
          analysis.closed,
          targetIndex,
          surface,
          surfaceNodes.slice(targetSurfaceIndex + 1),
        )
      : []),
  ]
  return {
    target,
    surfaceNodes,
    shadowedSeqs: surfaceNodes.slice(targetSurfaceIndex),
    followups,
    model: projectModel(snapshot.events),
  }
}

function replayMarker(event: SessionEvent): RewindReplayMarker | undefined {
  if (event.type !== 'assistant/message' || !isReplacementSurfaceEvent(event)) return undefined
  const source = event.data.message.source
  if (
    event.data.message.content.length !== 0
    || source.kind !== 'model'
    || source.provider !== REWIND_MARKER_PROVIDER
    || source.model !== REWIND_MARKER_MODEL
    || source.replayState === null
    || typeof source.replayState !== 'object'
  ) {
    return undefined
  }
  const marker = source.replayState as Partial<RewindReplayMarker>
  if (
    !hasExactOwnKeys(source.replayState, REWIND_REPLAY_MARKER_KEYS)
    || marker.kind !== REWIND_MARKER_KIND
    || marker.version !== REWIND_MARKER_VERSION
    || typeof marker.transactionId !== 'string'
    || marker.transactionId === ''
    || !Number.isSafeInteger(marker.targetSeq)
    || (marker.targetSeq ?? -1) < 0
    || (marker.mode !== 'rewind' && marker.mode !== 'cleanup')
  ) return undefined
  const sourceEventSeqs = event.sourceEventSeqs
  if (
    sourceEventSeqs === undefined
    || event.surfaceOp.start !== marker.targetSeq
    || sourceEventSeqs[0] !== event.surfaceOp.start
    || sourceEventSeqs.at(-1) !== event.surfaceOp.end
  ) return undefined
  return marker as RewindReplayMarker
}

/** List durable raw-transcript ranges hidden by committed rewind markers. */
export function listHiddenRanges(events: readonly SessionEvent[]): RewindHiddenRange[] {
  const ranges = events.flatMap((event): RewindHiddenRange[] => {
    const marker = replayMarker(event)
    if (marker === undefined || marker.targetSeq > event.seq) return []
    return [{ startSeq: marker.targetSeq, endSeq: event.seq }]
  }).sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq)

  const merged: RewindHiddenRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous === undefined || range.startSeq > previous.endSeq) {
      merged.push({ ...range })
    } else {
      previous.endSeq = Math.max(previous.endSeq, range.endSeq)
    }
  }
  return merged
}
