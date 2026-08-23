import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { CONVERSATION_REWIND_INVOCATIONS } from './contract.ts'

/** Host manifest for strict Gateway dispatch. */
export const TYPERT_MANIFEST: TypertContribution = {
  package: 'dsh-conversation-rewind',
  face: 'host',
  schemas: [],
  model: {
    services: [{
      key: 'conversationRewind',
      exportName: 'ConversationRewindRuntime',
      description: 'Append-only conversation rewind operations.',
      tags: [],
      members: [
        { kind: 'method', name: 'list', signature: 'list(sessionId: string, signal: AbortSignal): Promise<RewindBusinessResult<RewindSessionView>>' },
        { kind: 'method', name: 'rewind', signature: 'rewind(request: RewindRequest, signal: AbortSignal): Promise<RewindBusinessResult<RewindResult>>' },
        { kind: 'method', name: 'select', signature: 'select(request: RewindBranchSelectRequest, signal: AbortSignal): Promise<RewindBusinessResult<RewindBranchSelectResult>>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
  invocations: CONVERSATION_REWIND_INVOCATIONS,
}
