import type { JournalRecord } from './journal.js';
export interface VoiceStore {
    append(session: string, record: JournalRecord): Promise<void>;
    read(session: string): Promise<JournalRecord[]>;
    sessions(): Promise<string[]>;
    putFrames(session: string, first: number, frames: readonly Uint8Array[]): Promise<void>;
    getFrames(session: string, from: number, to: number): Promise<Uint8Array[]>;
    frameEnd(session: string): Promise<number>;
    dropFrames(session: string, below: number): Promise<void>;
    remove(session: string): Promise<void>;
}
export declare class MemoryVoiceStore implements VoiceStore {
    readonly journals: Map<string, JournalRecord[]>;
    readonly frames: Map<string, Map<number, Uint8Array<ArrayBufferLike>>>;
    append(session: string, record: JournalRecord): Promise<void>;
    read(session: string): Promise<JournalRecord[]>;
    sessions(): Promise<string[]>;
    putFrames(session: string, first: number, frames: readonly Uint8Array[]): Promise<void>;
    getFrames(session: string, from: number, to: number): Promise<Uint8Array[]>;
    frameEnd(session: string): Promise<number>;
    dropFrames(session: string, below: number): Promise<void>;
    remove(session: string): Promise<void>;
}
