import { type StoredDictation } from '../client/recovery.js';
import type { VoiceStore } from '../client/store.js';
import { type VoiceStrings } from './strings.js';
import { type VoiceTextInfo } from './useVoiceInput.js';
export interface VoiceRecoveryProps {
    target: string;
    url: string;
    token?: () => Promise<string | undefined> | string | undefined;
    store?: VoiceStore;
    strings?: VoiceStrings;
    onText: (text: string, info: VoiceTextInfo) => void | Promise<void>;
    className?: string;
}
export declare function useVoiceRecovery(target: string, store?: VoiceStore): {
    items: StoredDictation[];
    refresh: () => Promise<void>;
};
export declare function VoiceRecovery({ target, url, token, store, strings, onText, className }: VoiceRecoveryProps): import("react").JSX.Element | null;
