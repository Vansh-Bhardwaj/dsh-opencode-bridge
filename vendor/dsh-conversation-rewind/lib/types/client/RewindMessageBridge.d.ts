import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RewindHiddenRange } from '../protocol.ts';
import type { BranchBrowserInjected } from './branchBrowser.ts';
import { type RewindPanelInjected } from './controller.ts';
import { NS } from './locales.ts';
interface UserMessageRef {
    key: string;
    seq: number;
}
interface FlowNodeRef {
    key: string;
    anchorSeq: number;
    locationStartSeq?: number;
    userSeq?: number;
}
interface MessagePortalTarget extends UserMessageRef {
    actionTarget: HTMLElement;
    editorTarget: HTMLElement;
    sourceTarget: HTMLElement;
}
export type RewindMessageBridgeProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<RewindPanelInjected> & BranchBrowserInjected & PropsLocale<typeof NS>;
/** Resolve action rows by engine-owned node keys; message text is deliberately never inspected. */
export declare function resolveMessageTargets(root: HTMLElement, messages: readonly UserMessageRef[], editableSeqs: ReadonlySet<number>): MessagePortalTarget[];
/** Mark append-origin host rows hidden by durable same-Session rewind ranges. */
export declare function syncHiddenRows(root: HTMLElement, nodes: readonly FlowNodeRef[], ranges: readonly RewindHiddenRange[]): Set<HTMLElement>;
/** Hide every rendered flow row outside the selected historical turn path. */
export declare function syncVisibleRows(root: HTMLElement, nodes: readonly FlowNodeRef[], ranges: readonly RewindHiddenRange[]): Set<HTMLElement>;
/**
 * Invisible per-Session bridge for rc.6, which has no public user-message
 * action slot. It maps snapshot node keys to DOM rows, then portals one action
 * into the existing copy-action strip without replacing the user renderer.
 */
export declare function RewindMessageBridge({ sessionId, useSession, load, create, branchBrowser, t, }: RewindMessageBridgeProps): import("react").JSX.Element;
export {};
