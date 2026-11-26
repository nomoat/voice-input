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

export class MemoryVoiceStore implements VoiceStore {
  readonly journals = new Map<string, JournalRecord[]>();
  readonly frames = new Map<string, Map<number, Uint8Array>>();

  async append(session: string, record: JournalRecord): Promise<void> {
    const list = this.journals.get(session) ?? [];
    list.push(structuredClone(record));
    this.journals.set(session, list);
  }

  async read(session: string): Promise<JournalRecord[]> {
    return structuredClone(this.journals.get(session) ?? []);
  }

  async sessions(): Promise<string[]> {
    return [...this.journals.keys()];
  }

  async putFrames(session: string, first: number, frames: readonly Uint8Array[]): Promise<void> {
    const map = this.frames.get(session) ?? new Map<number, Uint8Array>();
    frames.forEach((f, i) => map.set(first + i, f.slice()));
    this.frames.set(session, map);
  }

  async getFrames(session: string, from: number, to: number): Promise<Uint8Array[]> {
    const map = this.frames.get(session);
    const out: Uint8Array[] = [];
    for (let i = from; i < to; i++) {
      const f = map?.get(i);
      if (!f) break;
      out.push(f.slice());
    }
    return out;
  }

  async frameEnd(session: string): Promise<number> {
    const map = this.frames.get(session);
    if (!map?.size) return 0;
    return Math.max(...map.keys()) + 1;
  }

  async dropFrames(session: string, below: number): Promise<void> {
    const map = this.frames.get(session);
    if (!map) return;
    for (const k of [...map.keys()]) if (k < below) map.delete(k);
  }

  async remove(session: string): Promise<void> {
    this.journals.delete(session);
    this.frames.delete(session);
  }
}
