import { EventEmitter } from 'node:events';
import type { ProviderContext, ProviderSpec } from './providers/types.js';
export interface SegmentOptions {
    seg: number;
    startFrame: number;
    providers: ProviderSpec[];
    context: ProviderContext;
    onProvider?: (name: string, attempt: number) => void;
}
export declare class Segment extends EventEmitter {
    private readonly options;
    readonly seg: number;
    readonly startFrame: number;
    private frames;
    private voiced;
    private ended;
    private settled;
    private attempt;
    private provider;
    private providerReady;
    private cursor;
    private finishSent;
    private timer;
    private pumpTimer;
    private lastText;
    private lastLength;
    private heard;
    constructor(options: SegmentOptions);
    get endFrame(): number;
    get attempts(): number;
    append(frame: Buffer, voice: boolean): void;
    end(): void;
    close(): void;
    private next;
    private pump;
    private commit;
    private disconnect;
}
