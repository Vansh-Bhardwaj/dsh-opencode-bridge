import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'

type ComposerBlocks = IConversation['blocks']
type ComposerBlock = ReturnType<ComposerBlocks['storeFor']> extends { getSnapshot(): infer Block }
  ? Exclude<Block, undefined>
  : never

/** A client-only pointer into the append-only branch tree. */
export interface BranchBrowseSelection {
  readonly leafSeq: number
  readonly path: readonly number[]
}

export interface BranchBrowser {
  get(sessionId: SessionId): BranchBrowseSelection | undefined
  subscribe(sessionId: SessionId, listener: () => void): () => void
  select(sessionId: SessionId, selection: BranchBrowseSelection): void
  clear(sessionId: SessionId): void
  dispose(): void
}

export interface BranchBrowserInjected {
  readonly branchBrowser: BranchBrowser
  readonly openChat: (anchor: HTMLElement) => void
}

interface BlockRecord {
  readonly block: ComposerBlock
  readonly previous: ComposerBlock | undefined
}

/**
 * Small per-session client store used by the tree and the Chat bridge.
 * Selection is deliberately ephemeral: it is never sent to or persisted by
 * the Host. The composer block is restored only when it is still ours, so a
 * concurrently mounted plugin cannot be clobbered on cleanup.
 */
export function createBranchBrowser(
  blocks: ComposerBlocks,
  reason: string,
): BranchBrowser {
  const selections = new Map<SessionId, BranchBrowseSelection>()
  const listeners = new Map<SessionId, Set<() => void>>()
  const blocked = new Map<SessionId, BlockRecord>()

  const notify = (sessionId: SessionId): void => {
    for (const listener of listeners.get(sessionId) ?? []) listener()
  }

  const setBlock = (sessionId: SessionId): void => {
    if (blocked.has(sessionId)) return
    const store = blocks.storeFor(sessionId)
    const previous = store.getSnapshot()
    const block: ComposerBlock = { reason }
    blocked.set(sessionId, { block, previous })
    blocks.set(sessionId, block)
  }

  const clearBlock = (sessionId: SessionId): void => {
    const record = blocked.get(sessionId)
    if (record === undefined) return
    blocked.delete(sessionId)
    // Do not overwrite a block another plugin installed while we were active.
    if (blocks.storeFor(sessionId).getSnapshot() === record.block) {
      blocks.set(sessionId, record.previous)
    }
  }

  return {
    get(sessionId) {
      return selections.get(sessionId)
    },
    subscribe(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(sessionId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(sessionId)
      }
    },
    select(sessionId, selection) {
      const path = [...selection.path]
      const prior = selections.get(sessionId)
      if (prior?.leafSeq === selection.leafSeq && prior.path.length === path.length
        && prior.path.every((seq, index) => seq === path[index])) return
      selections.set(sessionId, { leafSeq: selection.leafSeq, path })
      setBlock(sessionId)
      notify(sessionId)
    },
    clear(sessionId) {
      const hadSelection = selections.delete(sessionId)
      clearBlock(sessionId)
      if (hadSelection) notify(sessionId)
    },
    dispose() {
      const sessionIds = new Set<SessionId>([...selections.keys(), ...blocked.keys()])
      for (const sessionId of sessionIds) {
        selections.delete(sessionId)
        clearBlock(sessionId)
        notify(sessionId)
      }
      listeners.clear()
    },
  }
}
