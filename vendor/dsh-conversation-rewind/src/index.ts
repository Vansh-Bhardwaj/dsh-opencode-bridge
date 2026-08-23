import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { ConversationRewindRuntime } from './runtime.ts'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'dsh-conversation-rewind'
export const inject = ['agents', 'sessions', 'sessionQuery', 'typert']

export function apply(ctx: Context): void {
  new ConversationRewindRuntime(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'dsh-conversation-rewind: typert manifest')
}
