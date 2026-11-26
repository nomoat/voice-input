import { type ServerEvent, type StartMessage } from '../protocol.js';
import type { ProviderContext, ProviderSpec } from './providers/types.js';
export interface SegmentTiming {
    minMs: number;
    maxMs: number;
    idleCutMs: number;
}
export declare const DEFAULT_TIMING: SegmentTiming;
export interface RelaySessionStats {
    frames: number;
    segments: number;
    failovers: number;
    providers: string[];
    outcome: 'done' | 'cancelled' | 'error' | 'closed';
    error?: string;
}
export interface RelaySessionOptions {
    start: StartMessage;
    providers: ProviderSpec[];
    context: ProviderContext;
    send: (event: ServerEvent) => void;
    close: () => void;
    maxMs?: number;
    timing?: Partial<SegmentTiming>;
    maxOpenSegments?: number;
}
export declare class RelaySession {
    private readonly options;
    private frame;
    private nextSeg;
    private current;
    private readonly open;
    private readonly pause;
    private readonly timing;
    private readonly maxMs;
    private readonly maxOpen;
    private finishing;
    private closed;
    private ackHeld;
    private lastAckFrame;
    private idleTimer;
    readonly stats: RelaySessionStats;
    constructor(options: RelaySessionOptions);
    audio(data: Buffer): void;
    finish(): void;
    cancel(): void;
    shutdown(): void;
    private newSegment;
    private cut;
    private armIdle;
    private ack;
    private checkDone;
    private fail;
}
