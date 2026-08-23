import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindBranchNodeView, RewindSessionView } from '../protocol.ts'
import type { BranchBrowserInjected } from './branchBrowser.ts'
import type { RewindPanelInjected } from './controller.ts'
import { NS } from './locales.ts'

export interface RewindPanelProps extends Pick<RewindPanelInjected, 'load'>, BranchBrowserInjected {
  sessionId: SessionId
  t: TranslateNS<typeof NS>
  description?: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RewindTreeNode {
  node: RewindBranchNodeView
  children: RewindTreeNode[]
}

function byTime(left: RewindBranchNodeView, right: RewindBranchNodeView): number {
  return left.time - right.time || left.seq - right.seq
}

/**
 * Build a nested tree from the protocol's parent-linked projection.
 *
 * The Host validates this relationship before sending it, but the client
 * still treats missing parents and cycles as detached roots so a malformed
 * response cannot hide a branch or recurse forever.
 */
export function buildRewindTree(nodes: readonly RewindBranchNodeView[]): RewindTreeNode[] {
  const bySeq = new Map<number, RewindBranchNodeView>()
  for (const node of nodes) {
    if (!bySeq.has(node.seq)) bySeq.set(node.seq, node)
  }
  const uniqueNodes = [...bySeq.values()]
  const parentBySeq = new Map<number, number | undefined>()

  for (const node of uniqueNodes) {
    const candidate = node.parentSeq
    if (candidate === undefined || candidate === node.seq || !bySeq.has(candidate)) {
      parentBySeq.set(node.seq, undefined)
      continue
    }
    const seen = new Set<number>([node.seq])
    let cursor: number | undefined = candidate
    let cyclic = false
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        cyclic = true
        break
      }
      seen.add(cursor)
      const parent: number | undefined = bySeq.get(cursor)?.parentSeq
      cursor = parent !== undefined && bySeq.has(parent) ? parent : undefined
    }
    parentBySeq.set(node.seq, cyclic ? undefined : candidate)
  }

  const childrenByParent = new Map<number, RewindBranchNodeView[]>()
  const roots: RewindBranchNodeView[] = []
  for (const node of uniqueNodes) {
    const parent = parentBySeq.get(node.seq)
    if (parent === undefined) {
      roots.push(node)
      continue
    }
    const siblings = childrenByParent.get(parent) ?? []
    siblings.push(node)
    childrenByParent.set(parent, siblings)
  }
  roots.sort(byTime)
  for (const siblings of childrenByParent.values()) siblings.sort(byTime)

  const build = (node: RewindBranchNodeView, path: ReadonlySet<number>): RewindTreeNode => {
    if (path.has(node.seq)) return { node, children: [] }
    const nextPath = new Set(path)
    nextPath.add(node.seq)
    return {
      node,
      children: (childrenByParent.get(node.seq) ?? []).map(child => build(child, nextPath)),
    }
  }
  return roots.map(root => build(root, new Set()))
}

function directTreeItem(parent: Element | null): HTMLElement | undefined {
  if (parent === null) return undefined
  for (const child of Array.from(parent.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.getAttribute('role') === 'treeitem') return child
    if (child.getAttribute('role') !== 'none') continue
    const item = Array.from(child.children).find(candidate => (
      candidate instanceof HTMLElement && candidate.getAttribute('role') === 'treeitem'
    ))
    if (item instanceof HTMLElement) return item
  }
  return undefined
}

function childTreeItem(item: HTMLElement, root: HTMLElement): HTMLElement | undefined {
  const groupId = item.getAttribute('aria-owns')
  if (groupId === null) return undefined
  const group = root.ownerDocument.getElementById(groupId)
  if (group === null || !root.contains(group)) return undefined
  return directTreeItem(group)
}

function parentTreeItem(item: HTMLElement): HTMLElement | undefined {
  const group = item.closest<HTMLElement>('[role="group"]')
  return directTreeItem(group?.parentElement ?? null)
}

function navigateTree(event: ReactKeyboardEvent<HTMLUListElement>): void {
  const target = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>('[role="treeitem"]')
    : null
  if (target === null || !event.currentTarget.contains(target)) return

  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  const index = items.indexOf(target)
  let next: HTMLElement | undefined
  switch (event.key) {
    case 'ArrowDown':
      next = items[index + 1]
      break
    case 'ArrowUp':
      next = index > 0 ? items[index - 1] : undefined
      break
    case 'Home':
      next = items[0]
      break
    case 'End':
      next = items.at(-1)
      break
    case 'ArrowRight':
      next = childTreeItem(target, event.currentTarget)
      break
    case 'ArrowLeft':
      next = parentTreeItem(target)
      break
    default:
      return
  }
  event.preventDefault()
  next?.focus()
}

interface RewindTreeItemProps {
  branch: RewindTreeNode
  level: number
  position: number
  setSize: number
  phase: 'loading' | 'ready'
  currentSeq?: number
  browsing: boolean
  choose: (node: RewindBranchNodeView) => void
  t: TranslateNS<typeof NS>
}

function RewindTreeItem({ branch, level, position, setSize, phase, currentSeq, browsing, choose, t }: RewindTreeItemProps) {
  const { node, children } = branch
  const current = node.seq === currentSeq
  const hasChildren = children.length > 0
  const actionable = node.branchEnd
  const disabled = phase !== 'ready'
  const groupId = hasChildren ? `dsh-rewind-tree-group-${String(node.seq)}` : undefined
  const label = `${t('turn', { turn: node.turn })}: ${node.text}`
  const content = (
    <>
      <span className="dsh_rewind_treeTurn">{t('turn', { turn: node.turn })}</span>
      <span className="dsh_rewind_treeText">{node.text}</span>
      {current && <span className="dsh_rewind_treeBadge">{t(browsing ? 'viewing' : 'current')}</span>}
    </>
  )
  const treeItemProps = {
    role: 'treeitem' as const,
    className: 'dsh_rewind_treeNode',
    'data-depth': level - 1,
    'data-dsh-rewind-branch-seq': node.seq,
    'data-current-path': node.current,
    'data-current': current,
    'aria-label': label,
    'aria-current': current ? 'true' as const : undefined,
    'aria-level': level,
    'aria-posinset': position,
    'aria-setsize': setSize,
    'aria-owns': groupId,
    'aria-expanded': hasChildren ? true : undefined,
  }
  return (
    <li
      className="dsh_rewind_treeItem"
      role="none"
      data-dsh-rewind-tree-item={node.seq}
      data-current-path={node.current}
    >
      {actionable
        ? (
          <button
            {...treeItemProps}
            type="button"
            data-actionable={!disabled}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => { choose(node) }}
          >
            {content}
          </button>
        )
        : (
          <div {...treeItemProps} tabIndex={0}>
            {content}
          </div>
        )}
      {hasChildren && (
        <ul id={groupId} className="dsh_rewind_treeChildren" role="group" data-compact={level >= 4}>
          {children.map((child, index) => (
            <RewindTreeItem
              key={child.node.seq}
              branch={child}
              level={level + 1}
              position={index + 1}
              setSize={children.length}
              phase={phase}
              currentSeq={currentSeq}
              browsing={browsing}
              choose={choose}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Render append-only Session history with branch endpoints as the only actions. */
export function RewindPanel({
  sessionId, load, branchBrowser, openChat, t, description = true,
}: RewindPanelProps) {
  const [view, setView] = useState<RewindSessionView | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading')
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const subscribeBranch = useCallback(
    (listener: () => void) => branchBrowser.subscribe(sessionId, listener),
    [branchBrowser, sessionId],
  )
  const branchSnapshot = useCallback(
    () => branchBrowser.get(sessionId),
    [branchBrowser, sessionId],
  )
  const browsing = useSyncExternalStore(subscribeBranch, branchSnapshot, branchSnapshot)

  const reload = useCallback((): (() => void) => {
    requestRef.current?.abort()
    const abort = new AbortController()
    requestRef.current = abort
    setPhase('loading')
    setError(null)
    void load(sessionId, abort.signal).then((next) => {
      if (abort.signal.aborted) return
      if (next.sessionId !== sessionId) throw new Error(`rewind returned unexpected Session ${next.sessionId}`)
      setView(next)
      setPhase('ready')
    }).catch((cause: unknown) => {
      if (abort.signal.aborted) return
      setView(null)
      setError(t('error', { message: messageOf(cause) }))
      setPhase('ready')
    })
    return () => {
      abort.abort()
      if (requestRef.current === abort) requestRef.current = null
    }
  }, [load, sessionId, t])

  useEffect(() => {
    const dispose = reload()
    return () => {
      dispose()
      requestRef.current?.abort()
    }
  }, [reload])

  const tree = useMemo(() => buildRewindTree(view?.branches.nodes ?? []), [view])

  const choose = (node: RewindBranchNodeView): void => {
    if (phase !== 'ready' || !node.branchEnd) return
    if (node.seq === view?.branches.currentSeq) {
      branchBrowser.clear(sessionId)
    } else {
      branchBrowser.select(sessionId, { leafSeq: node.seq, path: node.path })
    }
    const anchor = panelRef.current
    if (anchor !== null) openChat(anchor)
  }

  return (
    <section ref={panelRef} className="dsh_rewind_panel" aria-busy={phase !== 'ready'}>
      {description && <div className="dsh_rewind_intro">{t('treeDescription')}</div>}
      {view?.model !== undefined && (
        <div className="dsh_rewind_model">
          {t('model', { provider: view.model.provider, model: view.model.model })}
        </div>
      )}
      {phase === 'loading' && <div className="dsh_rewind_notice">{t('loading')}</div>}
      {phase !== 'loading' && (view === null || tree.length === 0) && (
        <div className="dsh_rewind_notice">{t('treeEmpty')}</div>
      )}
      {tree.length > 0 && (
        <div className="dsh_rewind_treeFrame">
          <div className="dsh_rewind_treeOrigin" aria-hidden="true">{t('treeRoot')}</div>
          <ul
            className="dsh_rewind_tree dsh_rewind_treeChildren dsh_rewind_treeRoots"
            role="tree"
            aria-label={t('treeLabel')}
            onKeyDown={navigateTree}
          >
            {tree.map((branch, index) => (
              <RewindTreeItem
                key={branch.node.seq}
                branch={branch}
                level={1}
                position={index + 1}
                setSize={tree.length}
                phase={phase}
                currentSeq={browsing?.leafSeq ?? view?.branches.currentSeq}
                browsing={browsing !== undefined}
                choose={choose}
                t={t}
              />
            ))}
          </ul>
        </div>
      )}
      {error !== null && <div className="dsh_rewind_error" role="alert">{error}</div>}
      {phase !== 'loading' && view === null && (
        <div className="dsh_rewind_actions">
          <Button variant="outline" onClick={() => { reload() }}>{t('reload')}</Button>
        </div>
      )}
    </section>
  )
}
