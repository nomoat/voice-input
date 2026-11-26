import { EventEmitter } from 'node:events';
import type { ProviderSpec, SpeechProvider } from './types.js';
export interface FakeBehavior {
    readyMs?: number;
    finishMs?: number;
    failOnStart?: boolean;
    failAfterBytes?: number;
    neverFinish?: boolean;
    text?: (frames: number[]) => string;
}
export declare const frameLabel: (frames: number[]) => string;
export declare function fakeFrame(index: number, amplitude?: number): Buffer;
export declare class FakeProvider extends EventEmitter implements SpeechProvider {
    private readonly behavior;
    readonly frames: number[];
    private received;
    private closed;
    private finishing;
    private timer?;
    constructor(behavior?: FakeBehavior);
    start(): void;
    get writable(): boolean;
    audio(pcm: Buffer): void;
    finish(): void;
    private text;
    private fail;
    close(): void;
}
export declare function fakeProvider(name: string, behavior?: FakeBehavior | (() => FakeBehavior), timing?: {
    connectMs?: number;
    finishMs?: number;
}): ProviderSpec & {
    created: FakeProvider[];
};
