export declare const PROTOCOL_VERSION = 1;
export declare const SAMPLE_RATE = 16000;
export declare const FRAME_MS = 100;
export declare const FRAME_SAMPLES: number;
export declare const FRAME_BYTES: number;
export declare const MAX_SESSION_MS: number;
export declare const SEND_WINDOW_MS = 30000;
export type ErrorCode = 'unauthorized' | 'forbidden' | 'bad_request' | 'limit' | 'providers_unavailable' | 'timeout' | 'server';
export interface StartMessage {
    type: 'start';
    v: number;
    session: string;
    token?: string;
    languages: string[];
    surface?: string;
    fromMs: number;
    nextSeg: number;
}
export interface FinishMessage {
    type: 'finish';
    endMs: number;
}
export interface CancelMessage {
    type: 'cancel';
}
export type ClientMessage = StartMessage | FinishMessage | CancelMessage;
export interface ReadyEvent {
    type: 'ready';
    maxMs: number;
}
export interface InterimEvent {
    type: 'interim';
    seg: number;
    text: string;
}
export interface CommitEvent {
    type: 'commit';
    seg: number;
    text: string;
    startMs: number;
    endMs: number;
}
export interface AckEvent {
    type: 'ack';
    ms: number;
}
export interface DoneEvent {
    type: 'done';
    nextSeg: number;
}
export interface ErrorEvent {
    type: 'error';
    code: ErrorCode;
    retryable: boolean;
}
export type ServerEvent = ReadyEvent | InterimEvent | CommitEvent | AckEvent | DoneEvent | ErrorEvent;
export declare function parseClientMessage(raw: string): ClientMessage | null;
export declare function parseServerEvent(raw: string): ServerEvent | null;
