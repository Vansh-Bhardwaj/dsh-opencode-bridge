// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClientContext, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RewindRequest, RewindResult, RewindSessionView } from '../src/protocol.ts'
import { createBranchBrowser, type BranchBrowser } from '../src/client/branchBrowser.ts'
import { RewindMessageBridge, type RewindMessageBridgeProps } from '../src/client/RewindMessageBridge.tsx'
import { buildRewindTree, RewindPanel, type RewindPanelProps } from '../src/client/RewindPanel.tsx'
import { RewindRemoteError } from '../src/client/controller.ts'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  IconEditOutline16: () => <span data-test-icon="edit" />,
  Tooltip: ({ children }: { children: ReactElement }) => children,
}))

const SID = 'session-1' as SessionId
const mounted = new Set<Root>()

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => {
    for (const root of mounted) root.unmount()
    mounted.clear()
  })
  document.body.innerHTML = ''
})

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}) as RewindPanelProps['t']

const view: RewindSessionView = {
  sessionId: SID,
  messages: [
    { seq: 11, turn: 1, turnStartSeq: 10, turnEndSeq: 12, text: 'first editable', time: 100 },
    { seq: 22, turn: 2, turnStartSeq: 21, turnEndSeq: 23, text: 'second editable', time: 200 },
  ],
  hiddenRanges: [],
  branches: {
    nodes: [
      { seq: 11, turn: 1, turnStartSeq: 10, turnEndSeq: 12, path: [11], branchEnd: false, text: 'first editable', time: 100, current: true, selectable: true },
      { seq: 22, parentSeq: 11, turn: 2, turnStartSeq: 21, turnEndSeq: 23, path: [11, 22], branchEnd: true, text: 'second editable', time: 200, current: true, selectable: true },
      { seq: 44, parentSeq: 11, turn: 3, turnStartSeq: 30, turnEndSeq: 32, path: [11, 44], branchEnd: true, text: 'alternate branch', time: 300, current: false, selectable: true },
      {
        seq: 55,
        parentSeq: 11,
        turn: 4,
        turnStartSeq: 40,
        turnEndSeq: 42,
        path: [11, 55],
        branchEnd: true,
        text: 'unsafe attachment branch',
        time: 400,
        current: false,
        selectable: false,
        unavailableReason: 'this branch crosses an attachment turn',
      },
    ],
    currentPath: [11, 22],
    currentSeq: 22,
  },
}

function render(element: ReactElement, container: HTMLElement): Root {
  const root = createRoot(container)
  mounted.add(root)
  act(() => { root.render(element) })
  return root
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  })
}

function userRow(key: string, text = 'duplicate visible text'): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatFlowKind = 'user'
  row.dataset.chatFlowKey = key
  const hoverRoot = document.createElement('div')
  hoverRoot.setAttribute('data-time-hover-root', '')
  const bubble = document.createElement('div')
  bubble.textContent = text
  const actions = document.createElement('div')
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.setAttribute('aria-label', 'Copy')
  actions.append(copy)
  hoverRoot.append(bubble, actions)
  row.append(hoverRoot)
  return row
}

function flowRow(key: string, kind: string, text: string): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatFlowKey = key
  row.textContent = text
  return row
}

function bridgeFixture() {
  const sessionRoot = document.createElement('section')
  sessionRoot.dataset.slot = 'conversation'
  const headerSlot = document.createElement('div')
  headerSlot.dataset.slot = 'conversation.session.header'
  const header = document.createElement('header')
  const headerActions = document.createElement('div')
  header.append(headerActions)
  headerSlot.append(header)
  const first = userRow('node-first')
  const second = userRow('node-second')
  const unsafe = userRow('node-unsafe')
  sessionRoot.append(headerSlot, first, second, unsafe)
  const foreignRoot = document.createElement('section')
  const foreign = userRow('node-second')
  foreignRoot.append(foreign)
  document.body.append(foreignRoot, sessionRoot)

  const nodes = new Map([
    ['node-first', { kind: 'user', anchorSeq: 11, location: { kind: 'session' }, data: { seq: 11 } }],
    ['node-second', { kind: 'user', anchorSeq: 22, location: { kind: 'session' }, data: { seq: 22 } }],
    ['node-unsafe', { kind: 'user', anchorSeq: 33, location: { kind: 'session' }, data: { seq: 33 } }],
  ])
  const snapshot = {
    chat: {
      order: [...nodes.keys()],
      nodes: { get: (key: string) => nodes.get(key), values: () => [...nodes.values()] },
    },
  } as unknown as ConversationSnapshot
  const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as RewindMessageBridgeProps['useSession']
  return { sessionRoot, headerActions, first, second, unsafe, foreign, useSession }
}

function panelFace() {
  const branchBrowser: BranchBrowser = {
    get: vi.fn(() => undefined),
    subscribe: vi.fn(() => () => {}),
    select: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    load: vi.fn(async () => view),
    create: vi.fn(async (_request: RewindRequest, _signal?: AbortSignal): Promise<RewindResult> => ({
      sessionId: SID,
      replacementSeq: 40,
      queuedMessages: 1,
      shadowedMessages: 2,
    })),
    select: vi.fn(async (request: { sessionId: string; messageSeq: number }) => ({
      sessionId: request.sessionId,
      messageSeq: request.messageSeq,
      queuedMessages: 0,
      path: [11, 44],
    })),
    branchBrowser,
    openChat: vi.fn(),
  }
}

function bridgeProps(useSession: RewindMessageBridgeProps['useSession'], face: ReturnType<typeof panelFace>): RewindMessageBridgeProps {
  return {
    sessionId: SID,
    useSession,
    useSessions: (() => { throw new Error('unused') }) as RewindMessageBridgeProps['useSessions'],
    useWorkspaces: (() => { throw new Error('unused') }) as RewindMessageBridgeProps['useWorkspaces'],
    useProjection: (() => undefined) as RewindMessageBridgeProps['useProjection'],
    useInput: (() => { throw new Error('unused') }) as RewindMessageBridgeProps['useInput'],
    inputActions: {} as RewindMessageBridgeProps['inputActions'],
    t: t as RewindMessageBridgeProps['t'],
    ...face,
  }
}

describe('conversation rewind client UI', () => {
  it('names the message-branch view naturally in both locales', () => {
    expect(zh.view).toBe('消息分支')
    expect(en.view).toBe('Branches')
  })

  it('keeps the native user renderer and registers only the invisible Session bridge', () => {
    const entries: { options: { name: string; id?: string }; component: unknown }[] = []
    const ctx = {
      effect: () => {},
      conversation: {
        blocks: {
          storeFor: () => ({ getSnapshot: () => undefined }),
          set: () => {},
        },
      },
      locale: { bind: () => t },
      reflect: { get: () => ({}) },
      slots: {
        inject: (_name: string, mount: () => void) => { mount() },
        register: (options: { name: string; id?: string }, component: unknown) => {
          entries.push({ options, component })
          return () => {}
        },
      },
    } as unknown as ClientContext

    apply(ctx)

    expect(entries.map(entry => entry.options.name)).toEqual([
      'conversation.view',
      'conversation.session.header.actions',
    ])
    expect(entries.some(entry => entry.options.name === 'conversation.chat.node')).toBe(false)
    expect(entries[1]).toMatchObject({
      options: { id: 'conversation-rewind-message-bridge' },
      component: RewindMessageBridge,
    })
  })

  it('mounts no visible header action and maps editable seqs to their exact keyed user rows', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    expect(fixture.headerActions.querySelector('button')).toBeNull()
    const firstAction = fixture.first.querySelector('[data-dsh-rewind-message-seq]')
    expect(firstAction?.getAttribute('data-dsh-rewind-message-seq')).toBe('11')
    expect(fixture.second.querySelector('[data-dsh-rewind-message-seq]')?.getAttribute('data-dsh-rewind-message-seq')).toBe('22')
    expect(fixture.unsafe.querySelector('[data-dsh-rewind-message-seq]')).toBeNull()
    expect(fixture.foreign.querySelector('[data-dsh-rewind-message-seq]')).toBeNull()
    expect(firstAction?.previousElementSibling?.getAttribute('aria-label')).toBe('Copy')
    expect(face.load).toHaveBeenCalledWith(SID, expect.any(AbortSignal))
  })

  it('hides only raw rows shadowed by same-Session replacement ranges and keeps the edited path actionable', async () => {
    const fixture = bridgeFixture()
    const oldAssistant = flowRow('node-old-assistant', 'assistant-step', 'old assistant reply')
    const oldTail = flowRow('node-old-tail', 'turn-tail', 'old assistant actions')
    const rewindBookkeepingTail = flowRow('node-rewind-tail', 'turn-tail', '')
    const edited = userRow('node-edited', 'edited path')
    fixture.sessionRoot.append(oldAssistant, oldTail, rewindBookkeepingTail, edited)

    const nodes = new Map([
      ['node-first', { kind: 'user', anchorSeq: 11, location: { kind: 'session' }, data: { seq: 11 } }],
      ['node-old-assistant', {
        kind: 'assistant-step',
        anchorSeq: 18,
        location: { kind: 'session' },
        data: { status: 'settled', turn: 1, step: 1, blocks: [], time: 0 },
      }],
      ['node-old-tail', {
        kind: 'turn-tail',
        anchorSeq: 18.1,
        location: { kind: 'session' },
        data: { turn: 1, seq: 20, time: 0, closing: null, branchUnavailable: true },
      }],
      ['node-rewind-tail', {
        kind: 'turn-tail',
        anchorSeq: 25,
        location: { kind: 'turn', turn: { start: { seq: 19 } } },
        data: { turn: 3, seq: 25, time: 0, closing: null, branchUnavailable: true },
      }],
      ['node-second', { kind: 'user', anchorSeq: 22, location: { kind: 'session' }, data: { seq: 22 } }],
      ['node-unsafe', { kind: 'user', anchorSeq: 33, location: { kind: 'session' }, data: { seq: 33 } }],
      ['node-edited', { kind: 'user', anchorSeq: 44, location: { kind: 'session' }, data: { seq: 44 } }],
    ])
    const snapshot = {
      chat: {
        order: [...nodes.keys()],
        nodes: { get: (key: string) => nodes.get(key), values: () => [...nodes.values()] },
      },
    } as unknown as ConversationSnapshot
    const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as RewindMessageBridgeProps['useSession']
    const face = panelFace()
    face.load.mockResolvedValue({
      sessionId: SID,
      messages: [
        { seq: 33, turn: 3, turnStartSeq: 32, turnEndSeq: 34, text: 'outside range', time: 300 },
        { seq: 44, turn: 4, turnStartSeq: 43, turnEndSeq: 45, text: 'edited path', time: 400 },
      ],
      hiddenRanges: [
        { startSeq: 11, endSeq: 22 },
        { startSeq: 60, endSeq: 70 },
      ],
      branches: view.branches,
    })

    render(<RewindMessageBridge {...bridgeProps(useSession, face)} />, fixture.headerActions)
    await settle()

    expect(fixture.first.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(oldAssistant.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(oldTail.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(rewindBookkeepingTail.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(fixture.second.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(fixture.unsafe.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(edited.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.first.querySelector('[data-dsh-rewind-message-seq]')).toBeNull()
    expect(edited.querySelector('[data-dsh-rewind-message-seq="44"]')).not.toBeNull()
  })

  it('projects a selected endpoint as a read-only path and restores the composer block', async () => {
    const fixture = bridgeFixture()
    const alternate = userRow('node-alternate', 'alternate branch')
    fixture.sessionRoot.append(alternate)
    const nodes = new Map([
      ['node-first', { kind: 'user', anchorSeq: 11, location: { kind: 'session' }, data: { seq: 11 } }],
      ['node-second', { kind: 'user', anchorSeq: 22, location: { kind: 'session' }, data: { seq: 22 } }],
      ['node-unsafe', { kind: 'user', anchorSeq: 33, location: { kind: 'session' }, data: { seq: 33 } }],
      ['node-alternate', { kind: 'user', anchorSeq: 31, location: { kind: 'session' }, data: { seq: 44 } }],
    ])
    const snapshot = {
      chat: {
        order: [...nodes.keys()],
        nodes: { get: (key: string) => nodes.get(key), values: () => [...nodes.values()] },
      },
    } as unknown as ConversationSnapshot
    const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as RewindMessageBridgeProps['useSession']
    let block: { reason: string } | undefined
    const browser = createBranchBrowser({
      storeFor: () => ({ getSnapshot: () => block }),
      set: (_sessionId: SessionId, next: { reason: string } | undefined) => { block = next },
    } as never, '浏览历史分支')
    const face = panelFace()
    const props = bridgeProps(useSession, { ...face, branchBrowser: browser })
    render(<RewindMessageBridge {...props} />, fixture.headerActions)
    await settle()

    expect(fixture.first.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.second.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(alternate.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.second.querySelector('[data-dsh-rewind-message-seq="22"]')).not.toBeNull()

    act(() => { browser.select(SID, { leafSeq: 44, path: [11, 44] }) })
    await settle()
    expect(fixture.first.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(alternate.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.second.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(fixture.unsafe.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    expect(fixture.second.querySelector('[data-dsh-rewind-message-seq]')).toBeNull()
    expect(block?.reason).toBe('浏览历史分支')
    expect(face.create).not.toHaveBeenCalled()

    act(() => { browser.clear(SID) })
    await settle()
    expect(fixture.second.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.unsafe.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(fixture.second.querySelector('[data-dsh-rewind-message-seq="22"]')).not.toBeNull()
    expect(block).toBeUndefined()
  })

  it('edits the addressed message in its own row without opening a dialog', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    const action = fixture.second.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="22"]')
    expect(action).not.toBeNull()
    act(() => { action?.click() })
    await settle()

    const editor = fixture.second.querySelector<HTMLElement>('[data-dsh-rewind-inline-editor="22"]')
    const textarea = editor?.querySelector<HTMLTextAreaElement>('textarea')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fixture.first.querySelector('[data-dsh-rewind-inline-editor]')).toBeNull()
    expect(textarea?.value).toBe('second editable')
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-source]')).not.toBeNull()

    expect(editor?.querySelectorAll('input[type="radio"]').length).toBe(0)
    expect(editor?.textContent).not.toContain('后续消息')
    expect([...(editor?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => button.textContent)).toEqual([
      zh.cancel,
      zh.confirm,
    ])
    const confirm = [...(editor?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find(button => button.textContent === zh.confirm)
    expect(confirm?.disabled).toBe(false)
    act(() => { confirm?.click() })
    await settle()

    expect(face.create).toHaveBeenCalledWith({
      sessionId: SID,
      messageSeq: 22,
      text: 'second editable',
      cascade: 'truncate',
    }, expect.any(AbortSignal))
    expect(document.activeElement).toBe(action)
  })

  it('refocuses another edit action when a successful save later hides its trigger', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    const fallback = fixture.first.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="11"]')
    const action = fixture.second.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="22"]')
    act(() => { action?.click() })
    await settle()

    const confirm = [...(fixture.second.querySelectorAll<HTMLButtonElement>('[data-dsh-rewind-inline-editor] button'))]
      .find(button => button.textContent === zh.confirm)
    act(() => { confirm?.click() })
    await settle()

    expect(document.activeElement).toBe(action)
    fixture.second.setAttribute('data-dsh-rewind-hidden', '')
    await vi.waitFor(() => { expect(document.activeElement).toBe(fallback) })
  })

  it('keeps only one inline editor open and cancels with Escape without a Host request', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    const first = fixture.first.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="11"]')
    const second = fixture.second.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="22"]')
    act(() => { first?.click() })
    await settle()
    expect(fixture.first.querySelector('[data-dsh-rewind-inline-editor="11"]')).not.toBeNull()

    act(() => { second?.click() })
    await settle()
    expect(fixture.first.querySelector('[data-dsh-rewind-inline-editor]')).toBeNull()
    const editor = fixture.second.querySelector<HTMLElement>('[data-dsh-rewind-inline-editor="22"]')
    expect(editor).not.toBeNull()

    act(() => { editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await settle()
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-editor]')).toBeNull()
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-source]')).toBeNull()
    expect(document.activeElement).toBe(second)
    expect(face.create).not.toHaveBeenCalled()
  })

  it('aborts an in-flight save when another inline editor takes over', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    let saveSignal: AbortSignal | undefined
    face.create.mockImplementation((_request, signal) => {
      saveSignal = signal
      return new Promise<RewindResult>(() => {})
    })
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    const first = fixture.first.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="11"]')
    const second = fixture.second.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="22"]')
    act(() => { first?.click() })
    await settle()
    const save = [...(fixture.first.querySelectorAll<HTMLButtonElement>('[data-dsh-rewind-inline-editor] button'))]
      .find(button => button.textContent === zh.confirm)
    act(() => { save?.click() })
    await settle()

    expect(saveSignal?.aborted).toBe(false)
    act(() => { second?.click() })
    await settle()
    expect(saveSignal?.aborted).toBe(true)
    expect(fixture.first.querySelector('[data-dsh-rewind-inline-editor]')).toBeNull()
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-editor="22"]')).not.toBeNull()
  })

  it('keeps a protocol-mismatched save error in the active message row', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    face.create.mockResolvedValue({
      sessionId: 'session-other' as SessionId,
      replacementSeq: 40,
      queuedMessages: 1,
      shadowedMessages: 2,
    })
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    const action = fixture.first.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="11"]')
    act(() => { action?.click() })
    await settle()
    const save = [...(fixture.first.querySelectorAll<HTMLButtonElement>('[data-dsh-rewind-inline-editor] button'))]
      .find(button => button.textContent === zh.confirm)
    act(() => { save?.click() })
    await settle()

    const editor = fixture.first.querySelector<HTMLElement>('[data-dsh-rewind-inline-editor="11"]')
    expect(editor).not.toBeNull()
    expect(editor?.querySelector('[role="alert"]')?.textContent).toContain('session-other')
  })

  it('invalidates inline targets and reloads after a partial same-Session commit', async () => {
    const fixture = bridgeFixture()
    const face = panelFace()
    const staleView: RewindSessionView = {
      ...view,
      messages: view.messages.filter(message => message.seq === 22),
      hiddenRanges: [{ startSeq: 11, endSeq: 11 }],
    }
    let resolveReload: ((value: RewindSessionView) => void) | undefined
    face.load
      .mockResolvedValueOnce(staleView)
      .mockImplementationOnce(() => new Promise<RewindSessionView>(resolve => { resolveReload = resolve }))
    face.create.mockRejectedValueOnce(new RewindRemoteError(
      'the replacement was durable but its follow-up send failed',
      'REWIND_PARTIAL',
      SID,
      40,
    ))
    render(<RewindMessageBridge {...bridgeProps(fixture.useSession, face)} />, fixture.headerActions)
    await settle()

    expect(fixture.first.hasAttribute('data-dsh-rewind-hidden')).toBe(true)
    const action = fixture.second.querySelector<HTMLButtonElement>('[data-dsh-rewind-message-seq="22"]')
    act(() => { action?.click() })
    await settle()
    const save = [...(fixture.second.querySelectorAll<HTMLButtonElement>('[data-dsh-rewind-inline-editor] button'))]
      .find(button => button.textContent === zh.confirm)
    act(() => { save?.click() })
    await settle()

    expect(face.load).toHaveBeenCalledTimes(2)
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-editor]')).toBeNull()
    expect(fixture.second.querySelector('[data-dsh-rewind-inline-source]')).toBeNull()
    expect(fixture.second.querySelector('[data-dsh-rewind-message-seq]')).toBeNull()
    expect(fixture.first.hasAttribute('data-dsh-rewind-hidden')).toBe(false)
    expect(document.activeElement).toBe(fixture.headerActions.querySelector('[data-dsh-rewind-message-bridge]'))

    act(() => { resolveReload?.(view) })
    await settle()
    expect(fixture.first.querySelector('[data-dsh-rewind-message-seq="11"]')).not.toBeNull()
  })

  it('renders a branch-only message tree and selects only clicked branch endpoints', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const face = panelFace()
    render(<RewindPanel sessionId={SID} t={t} {...face} />, container)
    await settle()

    expect(container.querySelector('textarea')).toBeNull()
    const rootItem = container.querySelector('[data-dsh-rewind-tree-item="11"]')
    const childGroup = rootItem?.querySelector(':scope > [role="group"]')
    const rootNode = rootItem?.querySelector<HTMLElement>(':scope > [role="treeitem"]')
    expect(container.querySelector('.dsh_rewind_treeOrigin')?.textContent).toBe(zh.treeRoot)
    expect(rootItem?.parentElement?.getAttribute('role')).toBe('tree')
    expect(rootItem?.getAttribute('role')).toBe('none')
    expect(rootNode?.tagName).toBe('DIV')
    expect(rootNode?.getAttribute('aria-owns')).toBe(childGroup?.id)
    expect(rootNode?.getAttribute('aria-expanded')).toBe('true')
    expect(childGroup).not.toBeNull()
    expect(childGroup?.querySelector(':scope > [data-dsh-rewind-tree-item="22"]')).not.toBeNull()
    expect(childGroup?.querySelector(':scope > [data-dsh-rewind-tree-item="44"]')).not.toBeNull()
    expect(childGroup?.querySelector(':scope > [data-dsh-rewind-tree-item="55"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-rewind-branch-seq="11"]')?.getAttribute('data-depth')).toBe('0')
    expect(container.querySelector('[data-dsh-rewind-branch-seq="22"]')?.getAttribute('data-depth')).toBe('1')
    expect(container.querySelector('[data-dsh-rewind-branch-seq="44"]')?.getAttribute('data-depth')).toBe('1')
    expect(container.querySelector('[data-dsh-rewind-branch-seq="22"]')?.getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('[data-dsh-rewind-branch-seq="44"]')?.getAttribute('aria-expanded')).toBeNull()
    expect(container.querySelector('[data-dsh-rewind-branch-seq="22"]')?.tagName).toBe('BUTTON')

    act(() => { rootNode?.click() })
    await settle()
    expect(face.select).not.toHaveBeenCalled()

    act(() => {
      rootNode?.focus()
      rootNode?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement).toBe(container.querySelector('[data-dsh-rewind-branch-seq="22"]'))
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(container.querySelector('[data-dsh-rewind-branch-seq="44"]'))
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(rootNode)
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(document.activeElement).toBe(container.querySelector('[data-dsh-rewind-branch-seq="55"]'))
    const unavailable = container.querySelector<HTMLButtonElement>('[data-dsh-rewind-branch-seq="55"]')
    expect(unavailable?.getAttribute('aria-disabled')).toBe('false')
    expect(unavailable?.title).toBe('')
    act(() => { unavailable?.click() })
    await settle()
    expect(face.select).not.toHaveBeenCalled()
    expect(face.branchBrowser.select).toHaveBeenCalledWith(SID, { leafSeq: 55, path: [11, 55] })

    const alternate = container.querySelector<HTMLButtonElement>('[data-dsh-rewind-branch-seq="44"]')
    act(() => { alternate?.click() })
    await settle()
    expect(face.select).not.toHaveBeenCalled()
    expect(face.branchBrowser.select).toHaveBeenCalledWith(SID, { leafSeq: 44, path: [11, 44] })
    expect(face.openChat).toHaveBeenCalled()
  })

  it('keeps multiple root branches under the explicit Session start node', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const face = panelFace()
    face.load.mockResolvedValueOnce({
      ...view,
      branches: {
        nodes: [
          { seq: 101, turn: 1, turnStartSeq: 100, turnEndSeq: 100, path: [101], branchEnd: false, text: 'root one', time: 100, current: true, selectable: true },
          { seq: 102, turn: 1, turnStartSeq: 200, turnEndSeq: 200, path: [102], branchEnd: true, text: 'root two', time: 200, current: false, selectable: true },
          { seq: 103, parentSeq: 101, turn: 2, turnStartSeq: 300, turnEndSeq: 300, path: [101, 103], branchEnd: true, text: 'child of root one', time: 300, current: true, selectable: true },
        ],
        currentPath: [101, 103],
        currentSeq: 103,
      },
    })
    render(<RewindPanel sessionId={SID} t={t} {...face} />, container)
    await settle()

    const tree = container.querySelector<HTMLElement>('[role="tree"]')
    const roots = [...(tree?.children ?? [])].filter(child => child.getAttribute('role') === 'none')
    expect(container.querySelector('.dsh_rewind_treeOrigin')?.textContent).toBe(zh.treeRoot)
    expect(roots).toHaveLength(2)
    expect(roots[0]?.querySelector(':scope > [role="treeitem"]')?.getAttribute('aria-level')).toBe('1')
    expect(roots[1]?.querySelector(':scope > [role="treeitem"]')?.getAttribute('aria-level')).toBe('1')
    expect(roots[0]?.querySelector(':scope > [role="treeitem"]')?.tagName).toBe('DIV')
    expect(roots[1]?.querySelector(':scope > [role="treeitem"]')?.tagName).toBe('BUTTON')
    expect(roots[0]?.querySelector(':scope > [role="group"] [data-dsh-rewind-branch-seq="103"]')).not.toBeNull()
    expect(roots[1]?.querySelector(':scope > [role="group"]')).toBeNull()
  })

  it('normalizes orphan and cyclic branch metadata into finite detached roots', () => {
    const nodes = buildRewindTree([
      { seq: 3, parentSeq: 99, turn: 3, turnStartSeq: 3, turnEndSeq: 3, path: [3], branchEnd: true, text: 'orphan', time: 3, current: false, selectable: true },
      { seq: 3, turn: 30, turnStartSeq: 30, turnEndSeq: 30, path: [3], branchEnd: true, text: 'duplicate', time: 30, current: false, selectable: true },
      { seq: 4, parentSeq: 5, turn: 4, turnStartSeq: 4, turnEndSeq: 4, path: [4], branchEnd: true, text: 'cycle-a', time: 4, current: false, selectable: true },
      { seq: 5, parentSeq: 4, turn: 5, turnStartSeq: 5, turnEndSeq: 5, path: [5], branchEnd: true, text: 'cycle-b', time: 5, current: false, selectable: true },
    ])
    expect(nodes.map(branch => branch.node.seq)).toEqual([3, 4, 5])
    expect(nodes[0]?.node.text).toBe('orphan')
    expect(nodes.every(branch => branch.children.length === 0)).toBe(true)
  })

  it('browses an endpoint immediately without reloading or disabling the tree', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const face = panelFace()
    render(<RewindPanel sessionId={SID} t={t} {...face} />, container)
    await settle()

    const alternate = container.querySelector<HTMLButtonElement>('[data-dsh-rewind-branch-seq="44"]')
    act(() => { alternate?.click() })
    await settle()

    const staleLeaf = container.querySelector<HTMLButtonElement>('[data-dsh-rewind-branch-seq="22"]')
    expect(staleLeaf?.disabled).toBe(false)
    expect(staleLeaf?.getAttribute('aria-disabled')).toBe('false')
    expect(face.select).not.toHaveBeenCalled()
    expect(face.load).toHaveBeenCalledTimes(1)
  })

  it('keeps the branch tree intact after a read-only endpoint selection', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const face = panelFace()
    render(<RewindPanel sessionId={SID} t={t} {...face} />, container)
    await settle()

    const alternate = container.querySelector<HTMLButtonElement>('[data-dsh-rewind-branch-seq="44"]')
    act(() => { alternate?.click() })
    await settle()

    expect(container.querySelector('[role="tree"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(face.select).not.toHaveBeenCalled()
    expect(face.load).toHaveBeenCalledTimes(1)
  })
})
