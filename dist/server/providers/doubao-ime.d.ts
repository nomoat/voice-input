import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ProviderSpec, SpeechProvider } from './types.js';
export declare function encodeDoubaoRequest(input: {
    event: string;
    taskId: string;
    payload?: string;
    data?: Buffer;
    seq?: number;
}): Buffer;
export declare function decodeDoubaoResponse(bytes: Buffer): {
    event: string;
    status?: number;
    message?: string;
    payload: string;
};
export declare class DoubaoImeProvider extends EventEmitter implements SpeechProvider {
    private readonly deviceId;
    private readonly Socket;
    private ws?;
    private readonly taskId;
    private seq;
    private carry;
    private ended;
    constructor(deviceId: string, Socket?: typeof WebSocket);
    start(): void;
    private send;
    audio(pcm: Buffer): void;
    get writable(): boolean;
    finish(): void;
    private fail;
    close(): void;
}
export declare function doubaoIme(options?: {
    connectMs?: number;
    finishMs?: number;
}): ProviderSpec;
