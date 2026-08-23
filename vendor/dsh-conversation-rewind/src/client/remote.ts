import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CONVERSATION_REWIND_INVOCATIONS } from '../contract.ts'
import type {
  RewindBusinessResult,
  RewindBranchSelectRequest,
  RewindBranchSelectResult,
  RewindRequest,
  RewindResult,
  RewindSessionView,
} from '../protocol.ts'

export const CONVERSATION_REWIND_REMOTE: TypertRemoteContribution = {
  package: 'dsh-conversation-rewind',
  descriptors: CONVERSATION_REWIND_INVOCATIONS,
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$636f6e766572736174696f6e526577696e64 {
    list: (sessionId: string, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindSessionView>>>
    rewind: (request: RewindRequest, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindResult>>>
    select: (request: RewindBranchSelectRequest, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindBranchSelectResult>>>
  }

  interface TypertRemoteMap {
    'conversationRewind/list': (sessionId: string, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindSessionView>>>
    'conversationRewind/rewind': (request: RewindRequest, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindResult>>>
    'conversationRewind/select': (request: RewindBranchSelectRequest, signal?: AbortSignal) => Promise<RemoteResult<RewindBusinessResult<RewindBranchSelectResult>>>
  }

  interface TypertRemoteNamespaceMap {
    conversationRewind: TypertRemoteNamespace$636f6e766572736174696f6e526577696e64
  }
}
