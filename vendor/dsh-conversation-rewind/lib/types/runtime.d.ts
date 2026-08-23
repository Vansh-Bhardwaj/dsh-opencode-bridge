import type { Context } from '@deepseek-ai/cordis';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RewindBranchSelectRequest, RewindBranchSelectResult, RewindBusinessResult, RewindRequest, RewindResult, RewindSessionView } from './protocol.ts';
export declare const REWIND_TRIGGER_KIND = "dsh-conversation-rewind-trigger";
export declare const REWIND_TRIGGER_VERSION = 1;
/** Durable transaction payload carried by the internal request guard message. */
export interface RewindTriggerSource {
    kind: typeof REWIND_TRIGGER_KIND;
    version: typeof REWIND_TRIGGER_VERSION;
    transactionId: string;
    targetSeq: number;
    surfaceNodes: number[];
    followups: UserMessage[];
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-conversation-rewind-trigger': RewindTriggerSource;
    }
}
/** Validate untrusted durable source data before it can cancel an Agent request. */
export declare function rewindTriggerSource(message: UserMessage): RewindTriggerSource | undefined;
/** Install the permanent fail-closed trigger guard and orphan recovery hooks once per Context. */
export declare function installConversationRewindGuard(ctx: Context): void;
/** Append an edited path to the original Session without dispatching the internal trigger to a provider. */
export declare function rewindConversation(ctx: Context, request: RewindRequest, signal?: AbortSignal): Promise<RewindResult>;
/** Read one historical branch path without changing the Session or dispatching work. */
export declare function selectConversationBranch(ctx: Context, request: RewindBranchSelectRequest, signal?: AbortSignal): Promise<RewindBranchSelectResult>;
/** Browser-facing Remote that preserves stable business errors. */
export declare class ConversationRewindRuntime extends TypertRemoteService {
    constructor(ctx: Context);
    list(sessionId: string, signal?: AbortSignal): Promise<RewindBusinessResult<RewindSessionView>>;
    rewind(request: RewindRequest, signal?: AbortSignal): Promise<RewindBusinessResult<RewindResult>>;
    select(request: RewindBranchSelectRequest, signal?: AbortSignal): Promise<RewindBusinessResult<RewindBranchSelectResult>>;
}
