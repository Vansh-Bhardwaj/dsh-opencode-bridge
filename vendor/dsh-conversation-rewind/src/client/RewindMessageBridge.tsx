import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconEditOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RewindBranchNodeView, RewindHiddenRange, RewindResult, RewindSessionView } from '../protocol.ts'
import type { BranchBrowserInjected } from './branchBrowser.ts'
import { RewindRemoteError, type RewindPanelInjected } from './controller.ts'
import { NS } from './locales.ts'

interface UserMessageRef {
  key: string
  seq: number
}

interface FlowNodeRef {
  key: string
  anchorSeq: number
  locationStartSeq?: number
  userSeq?: number
}

interface MessagePortalTarget extends UserMessageRef {
  actionTarget: HTMLElement
  editorTarget: HTMLElement
  sourceTarget: HTMLElement
}

export type RewindMessageBridgeProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<RewindPanelInjected>
  & BranchBrowserInjected
  & PropsLocale<typeof NS>

function sameTargets(left: readonly MessagePortalTarget[], right: readonly MessagePortalTarget[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return other !== undefined
      && item.key === other.key
      && item.seq === other.seq
      && item.actionTarget === other.actionTarget
      && item.editorTarget === other.editorTarget
      && item.sourceTarget === other.sourceTarget
  })
}

/** Resolve action rows by engine-owned node keys; message text is deliberately never inspected. */
export function resolveMessageTargets(
  root: HTMLElement,
  messages: readonly UserMessageRef[],
  editableSeqs: ReadonlySet<number>,
): MessagePortalTarget[] {
  const rows = new Map<string, HTMLElement>()
  for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"][data-chat-flow-key]')) {
    const key = row.dataset.chatFlowKey
    if (key !== undefined) rows.set(key, row)
  }
  const targets: MessagePortalTarget[] = []
  for (const message of messages) {
    if (!editableSeqs.has(message.seq)) continue
    const row = rows.get(message.key)
    if (row === undefined) continue
    const hoverRoot = row.querySelector<HTMLElement>('[data-time-hover-root]')
    const actionTarget = hoverRoot?.lastElementChild
    // The current DSH user renderer puts its copy button directly in the final
    // child action row. Requiring that invariant prevents portals from landing
    // in a bubble/image control if the host markup changes incompatibly.
    if (!(actionTarget instanceof HTMLElement) || actionTarget.querySelector(':scope > button') === null) continue
    // The user renderer keeps the bubble stack immediately before the action
    // strip.  Portaling into that stack keeps the editor in the message row;
    // the fallback is the row itself for older host markup and test fixtures.
    const previous = actionTarget.previousElementSibling instanceof HTMLElement
      ? actionTarget.previousElementSibling
      : undefined
    const nestedBubble = previous?.querySelector<HTMLElement>(':scope > [class*="bubble"]')
    const sourceTarget = nestedBubble ?? previous ?? row
    const editorTarget = nestedBubble === undefined ? previous?.parentElement ?? row : previous ?? row
    targets.push({ ...message, actionTarget, editorTarget, sourceTarget })
  }
  return targets
}

function hiddenBy(seq: number, ranges: readonly RewindHiddenRange[]): boolean {
  return ranges.some(range => seq >= range.startSeq && seq <= range.endSeq)
}

/** Mark append-origin host rows hidden by durable same-Session rewind ranges. */
export function syncHiddenRows(
  root: HTMLElement,
  nodes: readonly FlowNodeRef[],
  ranges: readonly RewindHiddenRange[],
): Set<HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const key = row.dataset.chatFlowKey
    if (key !== undefined) rows.set(key, row)
  }
  const hidden = new Set<HTMLElement>()
  for (const node of nodes) {
    if (
      !hiddenBy(node.anchorSeq, ranges)
      && (node.locationStartSeq === undefined || !hiddenBy(node.locationStartSeq, ranges))
    ) continue
    const row = rows.get(node.key)
    if (row === undefined) continue
    row.setAttribute('data-dsh-rewind-hidden', '')
    hidden.add(row)
  }
  return hidden
}

function inRange(seq: number, ranges: readonly RewindHiddenRange[]): boolean {
  return ranges.some(range => seq >= range.startSeq && seq <= range.endSeq)
}

/** Hide every rendered flow row outside the selected historical turn path. */
export function syncVisibleRows(
  root: HTMLElement,
  nodes: readonly FlowNodeRef[],
  ranges: readonly RewindHiddenRange[],
): Set<HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const key = row.dataset.chatFlowKey
    if (key !== undefined) rows.set(key, row)
  }
  const hidden = new Set<HTMLElement>()
  for (const node of nodes) {
    const visible = inRange(node.anchorSeq, ranges)
      || (node.locationStartSeq !== undefined && inRange(node.locationStartSeq, ranges))
    if (visible) continue
    const row = rows.get(node.key)
    if (row === undefined) continue
    row.setAttribute('data-dsh-rewind-hidden', '')
    hidden.add(row)
  }
  return hidden
}

function branchRanges(view: RewindSessionView, path: readonly number[]): RewindHiddenRange[] {
  const bySeq = new Map(view.branches.nodes.map(node => [node.seq, node]))
  const ranges: RewindHiddenRange[] = []
  for (const seq of path) {
    const node: RewindBranchNodeView | undefined = bySeq.get(seq)
    if (node !== undefined) {
      ranges.push({ startSeq: node.turnStartSeq, endSeq: node.turnEndSeq })
      continue
    }
    const message = view.messages.find(item => item.seq === seq)
    if (message !== undefined) ranges.push({ startSeq: message.turnStartSeq, endSeq: message.turnEndSeq })
  }
  ranges.sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq)
  const merged: RewindHiddenRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.startSeq <= previous.endSeq + 1) {
      previous.endSeq = Math.max(previous.endSeq, range.endSeq)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function RewindMessageAction({
  sessionId, messageSeq, initialText, editorTarget, sourceTarget, active, onStart, onEnd, onCommitted, onPartial, onRefocus, t, ...face
}: Pick<RewindPanelInjected, 'create'> & PropsLocale<typeof NS> & {
  sessionId: RewindMessageBridgeProps['sessionId']
  messageSeq: number
  initialText: string
  editorTarget: HTMLElement
  sourceTarget: HTMLElement
  active: boolean
  onStart: () => void
  onEnd: () => void
  onCommitted: (result: RewindResult) => void
  onPartial: () => void
  onRefocus: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialText)
  const [phase, setPhase] = useState<'idle' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    saveAbortRef.current?.abort()
    saveAbortRef.current = null
  }, [])

  useEffect(() => {
    if (active || !editing) return
    saveAbortRef.current?.abort()
    saveAbortRef.current = null
    setEditing(false)
    setPhase('idle')
    setError(null)
  }, [active, editing])

  useEffect(() => {
    if (!editing) return
    sourceTarget.setAttribute('data-dsh-rewind-inline-source', '')
    return () => { sourceTarget.removeAttribute('data-dsh-rewind-inline-source') }
  }, [editing, sourceTarget])

  useEffect(() => {
    if (!editing) return
    setDraft(initialText)
    setError(null)
    const timer = window.setTimeout(() => { textareaRef.current?.focus() }, 0)
    return () => { window.clearTimeout(timer) }
  }, [editing, initialText])

  const restoreFocus = (watchForReplacement = false): void => {
    window.setTimeout(() => {
      const trigger = triggerRef.current
      if (
        trigger?.isConnected === true
        && trigger.closest('[data-dsh-rewind-hidden]') === null
      ) {
        trigger.focus()
        if (watchForReplacement) {
          let attempts = 0
          const watch = (): void => {
            const current = triggerRef.current
            if (
              current?.isConnected !== true
              || current.closest('[data-dsh-rewind-hidden]') !== null
            ) {
              onRefocus()
              return
            }
            if (attempts < 20) {
              attempts += 1
              window.setTimeout(watch, 50)
            }
          }
          window.setTimeout(watch, 50)
        }
        return
      }
      onRefocus()
    }, 0)
  }

  const close = (): void => {
    if (phase === 'saving') return
    setEditing(false)
    setPhase('idle')
    setError(null)
    onEnd()
    restoreFocus()
  }

  const save = (): void => {
    if (draft.trim() === '' || phase === 'saving') return
    const abort = new AbortController()
    saveAbortRef.current?.abort()
    saveAbortRef.current = abort
    setPhase('saving')
    setError(null)
    // The edited prompt always starts a new sibling branch in this Session.
    // Keep the wire-level truncate value for compatibility with older Hosts;
    // it is deliberately not exposed as an editor choice.
    void face.create({ sessionId, messageSeq, text: draft, cascade: 'truncate' }, abort.signal).then(result => {
      if (abort.signal.aborted || saveAbortRef.current !== abort) return
      if (result.sessionId !== sessionId) throw new Error(`rewind returned unexpected Session ${result.sessionId}`)
      saveAbortRef.current = null
      setEditing(false)
      setPhase('idle')
      onEnd()
      onCommitted(result)
      restoreFocus(true)
    }).catch((cause: unknown) => {
      if (abort.signal.aborted || saveAbortRef.current !== abort) return
      saveAbortRef.current = null
      const partial = cause instanceof RewindRemoteError
        && cause.code === 'REWIND_PARTIAL'
        && (cause.sessionId === undefined || cause.sessionId === sessionId)
      if (partial) {
        setEditing(false)
        setPhase('idle')
        setError(null)
        onEnd()
        onPartial()
        restoreFocus(true)
        return
      }
      setPhase('idle')
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <>
      <Tooltip label={t('open')} side="bottom">
        <button
          ref={triggerRef}
          type="button"
          className="dsh_rewind_messageAction"
          data-dsh-rewind-message-seq={messageSeq}
          aria-label={t('open')}
          aria-expanded={editing}
          aria-controls={`dsh-rewind-inline-editor-${String(messageSeq)}`}
          onClick={() => {
            if (editing) {
              close()
              return
            }
            onStart()
            setEditing(true)
          }}
        >
          <IconEditOutline16 />
        </button>
      </Tooltip>
      {editing && createPortal((
        <div
          id={`dsh-rewind-inline-editor-${String(messageSeq)}`}
          className="dsh_rewind_inlineEditor"
          data-dsh-rewind-inline-editor={messageSeq}
          role="region"
          aria-label={t('title')}
          aria-busy={phase === 'saving'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        >
          <textarea
            ref={textareaRef}
            className="dsh_rewind_textarea"
            rows={4}
            value={draft}
            readOnly={phase === 'saving'}
            aria-label={t('edited')}
            onChange={event => { setDraft(event.currentTarget.value) }}
          />
          {error !== null && <div className="dsh_rewind_error" role="alert">{error}</div>}
          <div className="dsh_rewind_inlineActions">
            <Button variant="outline" aria-disabled={phase === 'saving'} disabled={phase === 'saving'} onClick={close}>{t('cancel')}</Button>
            <Button variant="primary" aria-disabled={draft.trim() === '' || phase === 'saving'} disabled={draft.trim() === '' || phase === 'saving'} onClick={save}>
              {phase === 'saving' ? t('saving') : t('confirm')}
            </Button>
          </div>
        </div>
      ), editorTarget, `editor:${messageSeq}`)}
    </>
  )
}

/**
 * Invisible per-Session bridge for rc.6, which has no public user-message
 * action slot. It maps snapshot node keys to DOM rows, then portals one action
 * into the existing copy-action strip without replacing the user renderer.
 */
export function RewindMessageBridge({
  sessionId, useSession, load, create, branchBrowser, t,
}: RewindMessageBridgeProps) {
  const markerRef = useRef<HTMLSpanElement | null>(null)
  const order = useSession(snapshot => snapshot.chat.order)
  const nodes = useSession(snapshot => snapshot.chat.nodes)
  const flowNodes = useMemo<FlowNodeRef[]>(() => {
    const keys = [...order]
    const known = new Set(keys)
    // `order` intentionally omits hidden Chat nodes. They are still useful
    // for the client projection when the selected historical path is shown.
    for (const node of nodes.values()) {
      if (!known.has(node.key)) {
        known.add(node.key)
        keys.push(node.key)
      }
    }
    return keys.flatMap((key) => {
    const node = nodes.get(key)
    if (node === undefined || !Number.isFinite(node.anchorSeq)) return []
    const locationStartSeq = node.location.kind === 'step'
      ? node.location.step.start?.seq ?? node.location.turn.start?.seq
      : node.location.kind === 'turn' ? node.location.turn.start?.seq : undefined
    const base = {
      key,
      anchorSeq: node.anchorSeq,
      ...(locationStartSeq === undefined ? {} : { locationStartSeq }),
    }
    if (node.kind !== 'user') return [base]
    const data = node.data as UserMessageNode
    return Number.isSafeInteger(data.seq)
      ? [{ ...base, userSeq: data.seq }]
      : [base]
    })
  }, [nodes, order])
  const messages = useMemo<UserMessageRef[]>(() => flowNodes.flatMap(node => (
    node.userSeq === undefined ? [] : [{ key: node.key, seq: node.userSeq }]
  )), [flowNodes])
  const flowSignature = flowNodes
    .map(node => `${node.key}:${node.anchorSeq}:${node.locationStartSeq ?? ''}:${node.userSeq ?? ''}`)
    .join('\u0000')
  const [editableMessages, setEditableMessages] = useState<ReadonlyMap<number, string>>(() => new Map())
  const editableSeqs = useMemo(() => new Set(editableMessages.keys()), [editableMessages])
  const editableSignature = [...editableSeqs].sort((a, b) => a - b).join(',')
  const [hiddenRanges, setHiddenRanges] = useState<readonly RewindHiddenRange[]>([])
  const [sessionView, setSessionView] = useState<RewindSessionView | null>(null)
  const hiddenSignature = hiddenRanges.map(range => `${range.startSeq}:${range.endSeq}`).join(',')
  const [revision, setRevision] = useState(0)
  const [targets, setTargets] = useState<readonly MessagePortalTarget[]>([])
  const [editingSeq, setEditingSeq] = useState<number | null>(null)
  const hiddenRowsRef = useRef<Set<HTMLElement>>(new Set())
  const branchSelection = useSyncExternalStore(
    useCallback(listener => branchBrowser.subscribe(sessionId, listener), [branchBrowser, sessionId]),
    useCallback(() => branchBrowser.get(sessionId), [branchBrowser, sessionId]),
    () => undefined,
  )
  const browsingRanges = useMemo(
    () => branchSelection === undefined || sessionView === null
      ? undefined
      : branchRanges(sessionView, branchSelection.path),
    [branchSelection, sessionView],
  )
  const effectiveEditableSeqs = branchSelection === undefined ? editableSeqs : new Set<number>()

  const focusAvailableAction = useCallback((): void => {
    const marker = markerRef.current
    const root = marker?.closest<HTMLElement>('[data-slot="conversation"]')
    const action = [...(root?.querySelectorAll<HTMLButtonElement>('[data-dsh-rewind-message-seq]') ?? [])]
      .find(candidate => candidate.closest('[data-dsh-rewind-hidden]') === null)
    if (action !== undefined) {
      action.focus()
      return
    }
    marker?.focus()
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    void load(sessionId, abort.signal).then((view) => {
      if (abort.signal.aborted) return
      if (view.sessionId !== sessionId) throw new Error(`rewind returned unexpected Session ${view.sessionId}`)
      setSessionView(view)
      setEditableMessages(new Map(view.messages.map(message => [message.seq, message.text])))
      setHiddenRanges(view.hiddenRanges)
    }).catch(() => {
      if (abort.signal.aborted) return
      setEditableMessages(new Map())
      setSessionView(null)
      setEditingSeq(null)
      setHiddenRanges([])
    })
    return () => { abort.abort() }
  }, [flowSignature, load, revision, sessionId])

  useEffect(() => {
    if (branchSelection !== undefined) setEditingSeq(null)
  }, [branchSelection])

  useEffect(() => {
    const marker = markerRef.current
    const root = marker?.closest<HTMLElement>('[data-slot="conversation"]')
    if (root === null || root === undefined) return
    const sync = (): void => {
      for (const row of hiddenRowsRef.current) row.removeAttribute('data-dsh-rewind-hidden')
      hiddenRowsRef.current = browsingRanges === undefined
        ? syncHiddenRows(root, flowNodes, hiddenRanges)
        : syncVisibleRows(root, flowNodes, browsingRanges)
      root.toggleAttribute('data-dsh-rewind-browsing', browsingRanges !== undefined)
      const next = resolveMessageTargets(root, messages, effectiveEditableSeqs)
      setTargets(current => sameTargets(current, next) ? current : next)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const row of hiddenRowsRef.current) row.removeAttribute('data-dsh-rewind-hidden')
      hiddenRowsRef.current.clear()
    }
  }, [browsingRanges, effectiveEditableSeqs, editableSignature, flowNodes, flowSignature, hiddenRanges, hiddenSignature, messages])

  const face = useMemo(() => ({ create }), [create])
  const invalidateAfterPartial = (): void => {
    // A partial commit means the previous editable map and hidden ranges may
    // describe a checkpoint that is no longer the Session's durable state.
    setEditableMessages(new Map())
    setHiddenRanges([])
    setTargets([])
    setEditingSeq(null)
    branchBrowser.clear(sessionId)
    setRevision(value => value + 1)
  }
  return (
    <>
      <span
        ref={markerRef}
        data-dsh-rewind-message-bridge=""
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: 'fixed',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />
      {targets.map(({ key, seq, actionTarget, editorTarget, sourceTarget }) => createPortal(
        <RewindMessageAction
          sessionId={sessionId}
          messageSeq={seq}
          initialText={editableMessages.get(seq) ?? ''}
          editorTarget={editorTarget}
          sourceTarget={sourceTarget}
          active={editingSeq === seq}
          onStart={() => { setEditingSeq(seq) }}
          onEnd={() => { setEditingSeq(current => current === seq ? null : current) }}
          onCommitted={() => {
            branchBrowser.clear(sessionId)
            setRevision(value => value + 1)
          }}
          onPartial={invalidateAfterPartial}
          onRefocus={focusAvailableAction}
          t={t}
          {...face}
        />,
        actionTarget,
        `${key}:${seq}`,
      ))}
    </>
  )
}
