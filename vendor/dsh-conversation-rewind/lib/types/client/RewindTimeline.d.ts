import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BranchBrowserInjected } from './branchBrowser.ts';
import type { RewindPanelInjected } from './controller.ts';
import { NS } from './locales.ts';
export type RewindTimelineProps = ConvViewProps & InjectFace<RewindPanelInjected & BranchBrowserInjected> & PropsLocale<typeof NS>;
export declare function RewindTimeline({ sessionId, t, ...face }: RewindTimelineProps): import("react").JSX.Element;
