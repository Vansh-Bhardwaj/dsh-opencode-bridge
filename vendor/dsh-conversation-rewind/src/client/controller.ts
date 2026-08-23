import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  RewindBranchSelectRequest,
  RewindBranchSelectResult,
  RewindBusinessResult,
  RewindRequest,
  RewindResult,
  RewindSessionView,
} from '../protocol.ts'

export class RewindRemoteError extends Error {
  override readonly name = 'RewindRemoteError'

  constructor(
    message: string,
    readonly code: string,
    readonly sessionId?: string,
    readonly replacementSeq?: number,
  ) {
    super(message)
  }
}

export interface ConversationRewindRemote {
  list(sessionId: string, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindSessionView>>>
  rewind(request: RewindRequest, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindResult>>>
  select(request: RewindBranchSelectRequest, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindBranchSelectResult>>>
}

function unwrap<T>(result: RemoteResult<RewindBusinessResult<T>>): T {
  if (!result.ok) {
    throw new RewindRemoteError(result.error.message, result.error.code)
  }
  if (!result.value.ok) {
    throw new RewindRemoteError(
      result.value.error.message,
      result.value.error.code,
      result.value.error.sessionId,
      result.value.error.replacementSeq,
    )
  }
  return result.value.value
}

export interface RewindPanelInjected {
  load: (sessionId: SessionId, signal: AbortSignal) => Promise<RewindSessionView>
  create: (request: RewindRequest, signal: AbortSignal) => Promise<RewindResult>
  select: (request: RewindBranchSelectRequest, signal: AbortSignal) => Promise<RewindBranchSelectResult>
}

export function panelFace(_ctx: ClientContext, remote: () => ConversationRewindRemote | undefined): RewindPanelInjected {
  const mounted = (): ConversationRewindRemote => {
    const service = remote()
    if (service === undefined) throw new RewindRemoteError('conversation rewind service is not mounted', 'REMOTE_UNAVAILABLE')
    return service
  }
  return {
    async load(sessionId, signal) {
      if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError')
      return unwrap(await mounted().list(sessionId, signal))
    },
    async create(request, signal) {
      if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError')
      return unwrap(await mounted().rewind(request, signal))
    },
    async select(request, signal) {
      if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError')
      return unwrap(await mounted().select(request, signal))
    },
  }
}
