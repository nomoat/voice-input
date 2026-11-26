import type { VoiceStore } from './store.js';
export type VoicePhase = 'starting' | 'recording' | 'paused' | 'finishing' | 'pending' | 'done' | 'failed' | 'cancelled';
export type VoiceConnection = 'connecting' | 'online' | 'offline';
export type VoiceMode = 'undecided' | 'hold' | 'handsFree' | 'restore';
export type VoiceFailure = 'microphone' | 'unauthorized' | 'rejected';
export type VoiceStop = 'limit' | 'silence' | 'interrupted';
export interface VoiceState {
    phase: VoicePhase;
    connection: VoiceConnection;
    mode: VoiceMode;
    committed: string;
    interim: string;
    elapsedMs: number;
    remainingMs: number;
    silenceMs: number;
    level: number;
    failure?: VoiceFailure;
    stoppedBy?: VoiceStop;
}
export interface SocketLike {
    binaryType: string;
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | ArrayBufferLike | ArrayBufferView): void;
    close(code?: number): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
}
export interface CaptureSink {
    samples(pcm: Int16Array): void;
    interrupted(): void;
    resumed(): void;
}
export interface Capture {
    stop(): void;
}
export type CaptureFactory = (sink: CaptureSink) => Promise<Capture>;
export interface VoiceSessionOptions {
    url: string;
    token?: () => Promise<string | undefined> | string | undefined;
    languages: string[];
    target: string;
    surface?: string;
    store: VoiceStore;
    capture?: CaptureFactory;
    socket?: (url: string) => SocketLike;
    maxMs?: number;
    silenceFinishMs?: number;
    now?: () => number;
    id?: string;
}
export interface VoiceResult {
    session: string;
    text: string;
}
export declare function frameLevel(rms: number): number;
export declare class VoiceSession {
    readonly id: string;
    private readonly options;
    private readonly maxMs;
    private readonly silenceFinishMs;
    private readonly now;
    private listeners;
    private current;
    private recorded;
    private endFrame;
    private readonly frames;
    private unsaved;
    private unsavedFirst;
    private carry;
    private silentFrames;
    private readonly committed;
    private readonly segments;
    private ws;
    private ready;
    private sent;
    private acked;
    private finishSent;
    private finishRequested;
    private attempt;
    private unauthorized;
    private reconnectTimer;
    private connectTimer;
    private pumpTimer;
    private capture;
    private abandoned;
    private io;
    private settle;
    readonly result: Promise<VoiceResult | null>;
    storageFailed: boolean;
    constructor(options: VoiceSessionOptions);
    get state(): VoiceState;
    subscribe(listener: (state: VoiceState) => void): () => void;
    start(mode?: VoiceMode): Promise<void>;
    static restore(id: string, options: Omit<VoiceSessionOptions, 'id' | 'capture' | 'target' | 'languages'> & Partial<Pick<VoiceSessionOptions, 'target' | 'languages'>>): Promise<VoiceSession | null>;
    setMode(mode: VoiceMode): void;
    finish(stoppedBy?: VoiceStop): void;
    cancel(): void;
    abandon(): void;
    detach(): void;
    markInserted(): Promise<void>;
    saveTidy(markdown: string): Promise<void>;
    flushed(): Promise<void>;
    private samples;
    private addFrame;
    private flushFrames;
    private connect;
    private open;
    private event;
    private complete;
    private dropped;
    private pump;
    private text;
    private fail;
    private stopCapture;
    private closeSocket;
    private clearTimers;
    private isOver;
    private write;
    private update;
}
