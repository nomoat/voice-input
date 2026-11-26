import { displayText, type SegmentText } from '../text.js';

export type JournalRecord =
  | { t: 'start'; session: string; target: string; surface?: string; languages: string[]; at: number }
  | { t: 'commit'; seg: number; text: string; startMs: number; endMs: number }
  | { t: 'rewind'; nextSeg: number }
  | { t: 'finish'; endMs: number; at: number }
  | { t: 'complete'; at: number }
  | { t: 'tidy'; markdown: string }
  | { t: 'inserted'; at: number }
  | { t: 'discarded'; at: number };

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

export function contiguous(segments: Map<number, CommittedSegment>): { endMs: number; nextSeg: number } {
  let endMs = 0;
  let seg = 0;
  for (;;) {
    const s = segments.get(seg);
    if (!s || s.startMs !== endMs) break;
    endMs = s.endMs;
    seg++;
  }
  return { endMs, nextSeg: seg };
}

export function committedText(segments: Map<number, CommittedSegment>, upTo = Number.POSITIVE_INFINITY): string {
  const parts: SegmentText[] = [];
  for (const s of segments.values()) if (s.seg < upTo) parts.push({ seg: s.seg, text: s.text, final: true });
  return displayText(parts).committed;
}

export function summarize(records: readonly JournalRecord[]): JournalSummary | null {
  const head = records[0];
  if (!head || head.t !== 'start') return null;
  const summary: JournalSummary = {
    session: head.session,
    target: head.target,
    languages: head.languages,
    startedAt: head.at,
    segments: new Map(),
    contiguousEndMs: 0,
    nextSeg: 0,
    text: '',
  };
  if (head.surface) summary.surface = head.surface;
  for (const r of records.slice(1)) {
    switch (r.t) {
      case 'commit':
        summary.segments.set(r.seg, { seg: r.seg, text: r.text, startMs: r.startMs, endMs: r.endMs });
        break;
      case 'rewind':
        for (const seg of [...summary.segments.keys()]) if (seg >= r.nextSeg) summary.segments.delete(seg);
        break;
      case 'finish':
        summary.finishEndMs = r.endMs;
        summary.finishedAt = r.at;
        break;
      case 'complete':
        summary.completedAt = r.at;
        break;
      case 'tidy':
        summary.tidy = r.markdown;
        break;
      case 'inserted':
        summary.insertedAt = r.at;
        break;
      case 'discarded':
        summary.discardedAt = r.at;
        break;
      default:
        break;
    }
  }
  const c = contiguous(summary.segments);
  summary.contiguousEndMs = c.endMs;
  summary.nextSeg = c.nextSeg;
  summary.text = committedText(summary.segments, c.nextSeg);
  return summary;
}

export const INSERTED_KEEP_MS = 7 * 24 * 3600_000;
export const DISCARDED_KEEP_MS = 24 * 3600_000;
export const ABANDONED_KEEP_MS = 30 * 24 * 3600_000;

export function expired(summary: JournalSummary, now: number): boolean {
  if (summary.insertedAt !== undefined) return now - summary.insertedAt > INSERTED_KEEP_MS;
  if (summary.discardedAt !== undefined) return now - summary.discardedAt > DISCARDED_KEEP_MS;
  return now - summary.startedAt > ABANDONED_KEEP_MS;
}
