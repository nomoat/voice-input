import type { VoiceStore } from './store.js';
export interface StoredDictation {
    session: string;
    target: string;
    surface?: string;
    startedAt: number;
    durationMs: number;
    text: string;
    tidy?: string;
    status: 'unfinished' | 'complete' | 'inserted' | 'discarded';
    at: number;
}
export declare function listDictations(store: VoiceStore, options?: {
    target?: string;
    now?: number;
}): Promise<StoredDictation[]>;
export declare function markDiscarded(store: VoiceStore, session: string, now?: number): Promise<void>;
export declare function markInserted(store: VoiceStore, session: string, now?: number): Promise<void>;
