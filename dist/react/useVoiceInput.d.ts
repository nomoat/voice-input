import { VoiceSession, type CaptureFactory, type VoiceMode, type VoiceState } from '../client/session.js';
import { type VoiceStore } from '../client/store.js';
export interface VoiceTextInfo {
    raw: string;
    tidied: boolean;
    session: string;
}
export interface VoiceInputConfig {
    url: string;
    token?: () => Promise<string | undefined> | string | undefined;
    languages: string[];
    target: string;
    surface?: string;
    onText: (text: string, info: VoiceTextInfo) => void | Promise<void>;
    tidy?: (text: string) => Promise<string | null>;
    tidyMinChars?: number;
    store?: VoiceStore;
    capture?: CaptureFactory;
    maxMs?: number;
}
export type VoiceNotice = 'empty' | 'microphone' | 'unauthorized' | 'rejected' | 'limit' | 'silence' | 'pending';
export interface VoiceInputView {
    open: boolean;
    state: VoiceState | null;
    tidying: boolean;
    cancelArmed: boolean;
    notice: VoiceNotice | null;
}
export declare function defaultVoiceStore(): VoiceStore;
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null>;
export declare function useVoiceInput(config: VoiceInputConfig): {
    view: VoiceInputView;
    active: boolean;
    begin: (mode: VoiceMode) => VoiceSession;
    finish: () => void | undefined;
    cancel: () => void;
    setMode: (mode: VoiceMode) => void | undefined;
    armCancel: (armed: boolean) => void;
    close: () => void;
    session: import("react").RefObject<VoiceSession | null>;
};
