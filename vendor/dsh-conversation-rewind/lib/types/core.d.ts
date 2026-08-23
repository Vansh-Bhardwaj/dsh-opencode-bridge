import { type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { RewindBranchSelectRequest, RewindBranchTreeView, RewindHiddenRange, RewindMessageView, RewindModelView, RewindRequest } from './protocol.ts';
export declare const REWIND_MARKER_KIND = "dsh-conversation-rewind";
export declare const REWIND_MARKER_VERSION = 1;
export declare const REWIND_MARKER_PROVIDER = "dsh-conversation-rewind";
export declare const REWIND_MARKER_MODEL = "surface-rewind";
export interface RewindReplayMarker {
    kind: typeof REWIND_MARKER_KIND;
    version: typeof REWIND_MARKER_VERSION;
    transactionId: string;
    targetSeq: number;
    mode: 'rewind' | 'cleanup';
}
/** One complete source-log observation. */
export interface RewindSourceSnapshot {
    session: SessionHeader;
    events: SessionEvent[];
}
/** Fully validated material needed to replace the current same-Session surface tail. */
export interface RewindPlan {
    target: RewindMessageView;
    surfaceNodes: number[];
    shadowedSeqs: number[];
    followups: string[];
    model?: RewindModelView;
}
/** Resolved semantic path used for read-only branch browsing. */
export interface RewindBranchQuery {
    messageSeq: number;
    currentPath: number[];
    desiredPath: number[];
}
/** @deprecated Use {@link queryConversationBranch}; retained for API compatibility. */
export interface RewindBranchSelectionPlan {
    messageSeq: number;
    currentPath: number[];
    desiredPath: number[];
    /** Current-surface message replaced at the first divergence. */
    targetSeq?: number;
    surfaceNodes: number[];
    followups: {
        originSeq: number;
        text: string;
    }[];
}
/** Business error with a stable HTTP mapping. */
export declare class ConversationRewindError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: {
        sessionId?: string;
        replacementSeq?: number;
    } | undefined;
    readonly name = "ConversationRewindError";
    constructor(code: string, message: string, status?: number, details?: {
        sessionId?: string;
        replacementSeq?: number;
    } | undefined);
}
/** Return text only for the deliberately narrow, attachment-safe input shape. */
export declare function plainUserText(event: SessionEvent<'user/message'>): string | undefined;
/** Context that the runtime safely regenerates at a later real request. */
export declare function isRegeneratedContext(event: SessionEvent<'user/message'>): boolean;
/** Project the latest selectable model route without exposing the full request header. */
export declare function projectModel(events: readonly SessionEvent[]): RewindModelView | undefined;
/** List only completed turns that can be reproduced without attachment or batching ambiguity. */
export declare function listEditableMessages(events: readonly SessionEvent[]): RewindMessageView[];
/**
 * Project the semantic message paths as visual branch segments. Consecutive
 * messages stay at one indentation level; a root or a node with multiple
 * logical successors anchors the next visible level.
 */
export declare function projectBranchTree(events: readonly SessionEvent[]): RewindBranchTreeView;
/** Resolve a completed branch endpoint without mutating or replaying its Session. */
export declare function queryConversationBranch(snapshot: RewindSourceSnapshot, request: RewindBranchSelectRequest): RewindBranchQuery;
/** Build the divergence replacement and historical user path for one tree selection. */
export declare function buildBranchSelectionPlan(snapshot: RewindSourceSnapshot, request: RewindBranchSelectRequest): RewindBranchSelectionPlan;
/**
 * Build an immutable same-Session rewind plan. The source array and every
 * source event are borrowed read-only; only scalar/text projections are returned.
 */
export declare function buildRewindPlan(snapshot: RewindSourceSnapshot, request: RewindRequest): RewindPlan;
/** List durable raw-transcript ranges hidden by committed rewind markers. */
export declare function listHiddenRanges(events: readonly SessionEvent[]): RewindHiddenRange[];
