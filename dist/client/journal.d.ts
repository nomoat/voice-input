export type JournalRecord = {
    t: 'start';
    session: string;
    target: string;
    surface?: string;
    languages: string[];
    at: number;
} | {
    t: 'commit';
    seg: number;
    text: string;
    startMs: number;
    endMs: number;
} | {
    t: 'rewind';
    nextSeg: number;
} | {
    t: 'finish';
    endMs: number;
    at: number;
} | {
    t: 'complete';
    at: number;
} | {
    t: 'tidy';
    markdown: string;
} | {
    t: 'inserted';
    at: number;
} | {
    t: 'discarded';
    at: number;
};
export interface CommittedSegment {
    seg: number;
    text: string;
    startMs: number;
    endMs: number;
}
export interface JournalSummary {
    session: string;
    target: string;
    surface?: string;
    languages: string[];
    startedAt: number;
    segments: Map<number, CommittedSegment>;
    contiguousEndMs: number;
    nextSeg: number;
    finishEndMs?: number;
    finishedAt?: number;
    completedAt?: number;
    tidy?: string;
    insertedAt?: number;
    discardedAt?: number;
    text: string;
}
export declare function contiguous(segments: Map<number, CommittedSegment>): {
    endMs: number;
    nextSeg: number;
};
export declare function committedText(segments: Map<number, CommittedSegment>, upTo?: number): string;
export declare function summarize(records: readonly JournalRecord[]): JournalSummary | null;
export declare const INSERTED_KEEP_MS: number;
export declare const DISCARDED_KEEP_MS: number;
export declare const ABANDONED_KEEP_MS: number;
export declare function expired(summary: JournalSummary, now: number): boolean;
