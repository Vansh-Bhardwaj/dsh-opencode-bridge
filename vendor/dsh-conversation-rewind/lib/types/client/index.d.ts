import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type RewindLocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'conversation-rewind': RewindLocaleKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
