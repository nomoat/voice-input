import type { JournalRecord } from '../journal.js';
import type { VoiceStore } from '../store.js';
export declare class IndexedDbVoiceStore implements VoiceStore {
    private readonly name;
    private readonly factory;
    private db;
    constructor(name?: string, factory?: IDBFactory);
    static available(): boolean;
    private open;
    private tx;
    append(session: string, record: JournalRecord): Promise<void>;
    read(session: string): Promise<JournalRecord[]>;
    sessions(): Promise<string[]>;
    putFrames(session: string, first: number, frames: readonly Uint8Array[]): Promise<void>;
    getFrames(session: string, from: number, to: number): Promise<Uint8Array[]>;
    frameEnd(session: string): Promise<number>;
    dropFrames(session: string, below: number): Promise<void>;
    remove(session: string): Promise<void>;
}
