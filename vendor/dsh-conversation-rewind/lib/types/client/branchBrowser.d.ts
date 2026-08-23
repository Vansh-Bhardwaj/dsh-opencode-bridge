import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
type ComposerBlocks = IConversation['blocks'];
/** A client-only pointer into the append-only branch tree. */
export interface BranchBrowseSelection {
    readonly leafSeq: number;
    readonly path: readonly number[];
}
export interface BranchBrowser {
    get(sessionId: SessionId): BranchBrowseSelection | undefined;
    subscribe(sessionId: SessionId, listener: () => void): () => void;
    select(sessionId: SessionId, selection: BranchBrowseSelection): void;
    clear(sessionId: SessionId): void;
    dispose(): void;
}
export interface BranchBrowserInjected {
    readonly branchBrowser: BranchBrowser;
    readonly openChat: (anchor: HTMLElement) => void;
}
/**
 * Small per-session client store used by the tree and the Chat bridge.
 * Selection is deliberately ephemeral: it is never sent to or persisted by
 * the Host. The composer block is restored only when it is still ours, so a
 * concurrently mounted plugin cannot be clobbered on cleanup.
 */
export declare function createBranchBrowser(blocks: ComposerBlocks, reason: string): BranchBrowser;
export {};
