import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { RewindBranchNodeView } from '../protocol.ts';
import type { BranchBrowserInjected } from './branchBrowser.ts';
import type { RewindPanelInjected } from './controller.ts';
import { NS } from './locales.ts';
export interface RewindPanelProps extends Pick<RewindPanelInjected, 'load'>, BranchBrowserInjected {
    sessionId: SessionId;
    t: TranslateNS<typeof NS>;
    description?: boolean;
}
export interface RewindTreeNode {
    node: RewindBranchNodeView;
    children: RewindTreeNode[];
}
/**
 * Build a nested tree from the protocol's parent-linked projection.
 *
 * The Host validates this relationship before sending it, but the client
 * still treats missing parents and cycles as detached roots so a malformed
 * response cannot hide a branch or recurse forever.
 */
export declare function buildRewindTree(nodes: readonly RewindBranchNodeView[]): RewindTreeNode[];
/** Render append-only Session history with branch endpoints as the only actions. */
export declare function RewindPanel({ sessionId, load, branchBrowser, openChat, t, description, }: RewindPanelProps): import("react").JSX.Element;
