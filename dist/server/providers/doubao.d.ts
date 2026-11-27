import { EventEmitter } from 'node:events';
import type { ProviderSpec, SpeechProvider } from './types.js';
export declare const DOUBAO_ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
export declare const DOUBAO_ASR_RESOURCE = "volc.seedasr.sauc.duration";
export declare function doubaoFrame(type: number, flags: number, serialization: number, payload: Buffer): Buffer;
export interface DoubaoResponse {
    last: boolean;
    text?: string;
    error?: {
        code: number;
        message: string;
    };
}
export declare function parseDoubaoFrame(buf: Buffer): DoubaoResponse;
export interface DoubaoAsrOptions {
    apiKey: string | undefined;
    resourceId?: string;
    endpoint?: string;
    hotwords?: readonly string[];
    connectMs?: number;
    finishMs?: number;
}
export declare class DoubaoAsrProvider extends EventEmitter implements SpeechProvider {
    private apiKey;
    private readonly deviceId;
    private readonly options;
    private ws?;
    private ready;
    private closed;
    private finishing;
    private bytes;
    private lastText;
    constructor(apiKey: string | undefined, deviceId: string, options?: Omit<DoubaoAsrOptions, 'apiKey'>);
    start(): void;
    private send;
    get writable(): boolean;
    audio(pcm: Buffer): void;
    finish(): void;
    private fail;
    close(): void;
}
export declare function doubao(options: DoubaoAsrOptions): ProviderSpec;
