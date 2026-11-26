import { EventEmitter } from 'node:events';
import type { ProviderSpec, SpeechProvider } from './types.js';
export declare const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
export declare class GeminiLiveProvider extends EventEmitter implements SpeechProvider {
    private apiKey;
    private readonly model;
    private ws?;
    private ready;
    private closed;
    private finishing;
    private committed;
    private bytes;
    constructor(apiKey: string | undefined, model: string);
    start(): void;
    private message;
    private send;
    get writable(): boolean;
    audio(pcm: Buffer): void;
    finish(): void;
    private fail;
    close(): void;
}
export declare function geminiLive(options: {
    apiKey: string;
    model?: string;
    connectMs?: number;
    finishMs?: number;
}): ProviderSpec;
