import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { createBranchBrowser } from './branchBrowser.ts'
import { panelFace, type ConversationRewindRemote } from './controller.ts'
import { CONVERSATION_REWIND_REMOTE } from './remote.ts'
import { RewindMessageBridge } from './RewindMessageBridge.tsx'
import { RewindTimeline } from './RewindTimeline.tsx'
import { en, NS, zh, type RewindLocaleKey } from './locales.ts'
import { installStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'conversation-rewind': RewindLocaleKey
  }
}

export const inject = ['slots', 'sessions', 'remote', 'locale', 'conversation']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'conversation-rewind: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'conversation-rewind: dictionaries')
  let remote: ConversationRewindRemote | undefined
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(CONVERSATION_REWIND_REMOTE)
    remote = (ctx.reflect as unknown as { get(name: string): unknown })
      .get('remote.conversationRewind') as ConversationRewindRemote | undefined
    if (remote === undefined) throw new Error('conversation-rewind: Remote namespace did not mount')
    return () => { remote = undefined; void dispose() }
  }, 'conversation-rewind: remote')
  const t = ctx.locale.bind(NS)
  const branchBrowser = createBranchBrowser(ctx.conversation.blocks, t('browsing'))
  ctx.effect(() => () => { branchBrowser.dispose() }, 'conversation-rewind: branch browser')
  const openChat = (anchor: HTMLElement): void => {
    const root = anchor.closest<HTMLElement>('[data-slot="conversation"]')
    if (root === null) return
    const views = [...ctx.slots.entriesOfSlot('conversation.view')]
      .filter(entry => entry.options.id !== undefined)
      .sort((left, right) => (left.options.order ?? 0) - (right.options.order ?? 0))
    const chatIndex = views.findIndex(entry => entry.options.id === 'chat')
    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const byIndex = chatIndex < 0 ? undefined : tabs.item(chatIndex)
    if (byIndex instanceof HTMLButtonElement) {
      byIndex.click()
      return
    }
    const chat = views.find(entry => entry.options.id === 'chat')
    const label = resolveSlotLabel(chat?.options.label)
    if (label === undefined) return
    for (const tab of tabs) {
      if (tab.textContent?.trim() === label) {
        tab.click()
        return
      }
    }
  }
  const face = { ...panelFace(ctx, () => remote), branchBrowser, openChat }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'conversation-rewind',
    order: 16,
    locale: NS,
    label: () => t('view'),
    inject: (_sessionId: SessionId) => face,
  }, RewindTimeline))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'conversation-rewind-message-bridge',
    order: 1_000,
    locale: NS,
    inject: (_sessionId: SessionId) => face,
  }, RewindMessageBridge))
}
