/** Wire compatibility for same-Session rewind; the client editor always sends `truncate`. */
export type RewindCascade = 'truncate' | 'preserve'

/** One completed, safely editable ordinary user turn. */
export interface RewindMessageView {
  seq: number
  turn: number
  turnStartSeq: number
  turnEndSeq: number
  text: string
  time: number
}

/** Route information currently selected by the Session. */
export interface RewindModelView {
  provider: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
}

/** Raw transcript seq range hidden by one durable rewind marker. */
export interface RewindHiddenRange {
  startSeq: number
  endSeq: number
}

/** One logical ordinary-user node in the append-only branch tree. */
export interface RewindBranchNodeView {
  /** Stable seq of the first durable occurrence of this logical message. */
  seq: number
  /** Visual tree parent; `path` preserves the unflattened semantic ancestry. */
  parentSeq?: number
  turn: number
  /** Durable boundaries of the completed turn containing this message. */
  turnStartSeq: number
  turnEndSeq: number
  text: string
  time: number
  /** Full semantic path to this node, independent of visual tree flattening. */
  path: number[]
  /** Whether this is the final ordinary-user message on its semantic branch. */
  branchEnd: boolean
  /** Whether this node belongs to the currently active Session path. */
  current: boolean
  /** Legacy replay-safety hint; read-only branch browsing uses `branchEnd`. */
  selectable: boolean
  /** Stable human-readable explanation when this node is not selectable. */
  unavailableReason?: string
}

/** Flat, parent-linked projection consumed by the visual message tree. */
export interface RewindBranchTreeView {
  nodes: RewindBranchNodeView[]
  currentPath: number[]
  currentSeq?: number
}

/** Browser projection of one Session. */
export interface RewindSessionView {
  sessionId: string
  messages: RewindMessageView[]
  hiddenRanges: RewindHiddenRange[]
  branches: RewindBranchTreeView
  model?: RewindModelView
}

/** Select one logical branch point in the original Session. */
export interface RewindBranchSelectRequest {
  sessionId: string
  messageSeq: number
}

/** Result of resolving a branch path for read-only client-side browsing. */
export interface RewindBranchSelectResult {
  sessionId: string
  messageSeq: number
  path: number[]
  queuedMessages: number
}

/** Input for appending an edited path to the same Session. */
export interface RewindRequest {
  sessionId: string
  messageSeq: number
  text: string
  cascade: RewindCascade
}

/** Successful same-Session surface replacement and durable prompt checkpoint. */
export interface RewindResult {
  sessionId: string
  replacementSeq: number
  queuedMessages: number
  shadowedMessages: number
}

/** Stable business result nested inside Typert's transport-level RemoteResult. */
export type RewindBusinessResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code: string
        message: string
        sessionId?: string
        replacementSeq?: number
      }
    }
