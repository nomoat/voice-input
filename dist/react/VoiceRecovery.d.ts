import { type ReactElement } from 'react';
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
    Button?: (props: {
        onClick: () => void;
        primary: boolean;
        disabled?: boolean;
        children: string;
    }) => ReactElement;
}
export declare function useVoiceRecovery(target: string, store?: VoiceStore): {
    items: StoredDictation[];
    refresh: () => Promise<void>;
};
export declare function VoiceRecovery({ target, url, token, store, strings, onText, className, Button }: VoiceRecoveryProps): import("react").JSX.Element | null;
