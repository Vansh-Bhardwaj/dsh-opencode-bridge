import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { RewindBranchSelectRequest, RewindBranchSelectResult, RewindBusinessResult, RewindRequest, RewindResult, RewindSessionView } from '../protocol.ts';
export declare class RewindRemoteError extends Error {
    readonly code: string;
    readonly sessionId?: string | undefined;
    readonly replacementSeq?: number | undefined;
    readonly name = "RewindRemoteError";
    constructor(message: string, code: string, sessionId?: string | undefined, replacementSeq?: number | undefined);
}
export interface ConversationRewindRemote {
    list(sessionId: string, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindSessionView>>>;
    rewind(request: RewindRequest, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindResult>>>;
    select(request: RewindBranchSelectRequest, signal?: AbortSignal): Promise<RemoteResult<RewindBusinessResult<RewindBranchSelectResult>>>;
}
export interface RewindPanelInjected {
    load: (sessionId: SessionId, signal: AbortSignal) => Promise<RewindSessionView>;
    create: (request: RewindRequest, signal: AbortSignal) => Promise<RewindResult>;
    select: (request: RewindBranchSelectRequest, signal: AbortSignal) => Promise<RewindBranchSelectResult>;
}
export declare function panelFace(_ctx: ClientContext, remote: () => ConversationRewindRemote | undefined): RewindPanelInjected;
