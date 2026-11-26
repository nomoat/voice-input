import { EventEmitter } from 'node:events';
import type { ProviderSpec, SpeechProvider } from './types.js';
export interface WeTypeKeys {
    signKey: string;
    handshakeKey: string;
}
export declare function opusArguments(): string[];
export declare class WeTypeProvider extends EventEmitter implements SpeechProvider {
    private readonly deviceId;
    private readonly keys;
    private readonly ffmpeg;
    private ws?;
    private encoder?;
    private identity?;
    private readonly voiceId;
    private readonly pending;
    private task;
    private seq;
    private offset;
    private packets;
    private closed;
    private finishing;
    private lastResultSeq;
    private lastText?;
    private pollTimer?;
    constructor(deviceId: string, keys: WeTypeKeys, ffmpeg?: string);
    start(): void;
    private initialize;
    private bootstrap;
    private rpc;
    private decode;
    get writable(): boolean;
    audio(pcm: Buffer): void;
    finish(): void;
    private flushAudio;
    private voice;
    private poll;
    private fail;
    close(): void;
}
export declare function wetype(options: WeTypeKeys & {
    ffmpeg?: string;
    connectMs?: number;
    finishMs?: number;
}): ProviderSpec;
