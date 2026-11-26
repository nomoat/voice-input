import { FRAME_BYTES, FRAME_MS, FRAME_SAMPLES, MAX_SESSION_MS, PROTOCOL_VERSION, SEND_WINDOW_MS, parseServerEvent, type ServerEvent } from '../protocol.js';
import { displayText, type SegmentText } from '../text.js';
import { committedText, contiguous, summarize, type CommittedSegment, type JournalRecord } from './journal.js';
import type { VoiceStore } from './store.js';

export type VoicePhase = 'starting' | 'recording' | 'paused' | 'finishing' | 'pending' | 'done' | 'failed' | 'cancelled';
export type VoiceConnection = 'connecting' | 'online' | 'offline';
export type VoiceMode = 'undecided' | 'hold' | 'handsFree' | 'restore';
export type VoiceFailure = 'microphone' | 'unauthorized' | 'rejected';
export type VoiceStop = 'limit' | 'silence';

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
  onmessage: ((event: { data: unknown }) => void) | null;
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

const WINDOW_FRAMES = SEND_WINDOW_MS / FRAME_MS;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const CONNECT_TIMEOUT_MS = 10_000;
const VOICE_RMS = 200;

const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

export function frameLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms / 32768);
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

function rmsOf(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export class VoiceSession {
  readonly id: string;
  private readonly options: VoiceSessionOptions;
  private readonly maxMs: number;
  private readonly silenceFinishMs: number;
  private readonly now: () => number;
  private listeners = new Set<(state: VoiceState) => void>();
  private current: VoiceState;

  private recorded = 0;
  private endFrame: number | undefined;
  private readonly frames = new Map<number, Uint8Array>();
  private unsaved: Uint8Array[] = [];
  private unsavedFirst = 0;
  private carry = new Int16Array(0);
  private silentFrames = 0;

  private readonly committed = new Map<number, CommittedSegment>();
  private readonly segments = new Map<number, SegmentText>();

  private ws: SocketLike | undefined;
  private ready = false;
  private sent = 0;
  private acked = 0;
  private finishSent = false;
  private finishRequested = false;
  private attempt = 0;
  private unauthorized = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;

  private capture: Capture | undefined;
  private abandoned = false;
  private io: Promise<void> = Promise.resolve();
  private settle!: (result: VoiceResult | null) => void;
  readonly result: Promise<VoiceResult | null>;
  storageFailed = false;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.id = options.id ?? uuid();
    this.maxMs = options.maxMs ?? MAX_SESSION_MS;
    this.silenceFinishMs = options.silenceFinishMs ?? 180_000;
    this.now = options.now ?? Date.now;
    this.current = {
      phase: 'starting', connection: 'connecting', mode: 'undecided', committed: '', interim: '',
      elapsedMs: 0, remainingMs: this.maxMs, silenceMs: 0, level: 0,
    };
    this.result = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  get state(): VoiceState {
    return this.current;
  }

  subscribe(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async start(mode: VoiceMode = 'undecided'): Promise<void> {
    this.update({ mode });
    const head: JournalRecord = { t: 'start', session: this.id, target: this.options.target, languages: this.options.languages, at: this.now() };
    if (this.options.surface) head.surface = this.options.surface;
    this.write((store) => store.append(this.id, head));
    this.connect();
    if (!this.options.capture) {
      this.fail('microphone');
      return;
    }
    let capture: Capture;
    try {
      capture = await this.options.capture({
        samples: (pcm) => this.samples(pcm),
        interrupted: () => {
          if (this.current.phase === 'recording') this.update({ phase: 'paused', level: 0 });
        },
        resumed: () => {
          if (this.current.phase === 'paused') this.update({ phase: 'recording' });
        },
      });
    } catch {
      this.fail('microphone');
      return;
    }
    if (this.current.phase !== 'starting') {
      capture.stop();
      return;
    }
    this.capture = capture;
    this.update({ phase: 'recording' });
  }

  static async restore(id: string, options: Omit<VoiceSessionOptions, 'id' | 'capture' | 'target' | 'languages'> & Partial<Pick<VoiceSessionOptions, 'target' | 'languages'>>): Promise<VoiceSession | null> {
    const summary = summarize(await options.store.read(id));
    if (!summary || summary.insertedAt !== undefined || summary.discardedAt !== undefined) return null;
    const session = new VoiceSession({ ...options, id, target: summary.target, languages: summary.languages, ...(summary.surface ? { surface: summary.surface } : {}) });
    for (const s of summary.segments.values()) {
      session.committed.set(s.seg, s);
      session.segments.set(s.seg, { seg: s.seg, text: s.text, final: true });
    }
    const from = summary.contiguousEndMs / FRAME_MS;
    const stored = await options.store.frameEnd(id);
    const end = Math.max(from, stored, (summary.finishEndMs ?? 0) / FRAME_MS);
    const frames = end > from ? await options.store.getFrames(id, from, end) : [];
    frames.forEach((f, i) => session.frames.set(from + i, f));
    const available = from + frames.length;
    session.recorded = available;
    session.endFrame = available;
    session.unsavedFirst = available;
    session.finishRequested = true;
    session.update({ mode: 'restore', phase: 'pending', elapsedMs: available * FRAME_MS, remainingMs: 0, ...session.text() });
    if (summary.completedAt !== undefined || available <= from) {
      session.complete();
      return session;
    }
    if (summary.finishEndMs === undefined) session.write((store) => store.append(id, { t: 'finish', endMs: available * FRAME_MS, at: session.now() }));
    session.connect();
    return session;
  }

  setMode(mode: VoiceMode): void {
    if (this.current.mode !== mode) this.update({ mode });
  }

  finish(stoppedBy?: VoiceStop): void {
    const phase = this.current.phase;
    if (phase !== 'starting' && phase !== 'recording' && phase !== 'paused') return;
    this.stopCapture();
    if (this.carry.length) {
      const padded = new Int16Array(FRAME_SAMPLES);
      padded.set(this.carry);
      this.carry = new Int16Array(0);
      this.addFrame(padded);
    }
    this.flushFrames();
    this.endFrame = this.recorded;
    this.finishRequested = true;
    if (!this.recorded) {
      this.update({ phase: 'done', level: 0, ...(stoppedBy ? { stoppedBy } : {}) });
      this.closeSocket();
      this.write((store) => store.remove(this.id));
      this.settle({ session: this.id, text: '' });
      return;
    }
    this.write((store) => store.append(this.id, { t: 'finish', endMs: this.recorded * FRAME_MS, at: this.now() }));
    this.update({ phase: this.ready ? 'finishing' : 'pending', level: 0, ...(stoppedBy ? { stoppedBy } : {}) });
    this.pump();
  }

  cancel(): void {
    const phase = this.current.phase;
    if (phase === 'done' || phase === 'cancelled') return;
    this.stopCapture();
    this.clearTimers();
    if (this.ws && this.ready) {
      try {
        this.ws.send(JSON.stringify({ type: 'cancel' }));
      } catch {
        undefined;
      }
    }
    this.closeSocket();
    this.flushFrames();
    this.frames.clear();
    this.write((store) => store.append(this.id, { t: 'discarded', at: this.now() }));
    this.write((store) => store.dropFrames(this.id, Number.MAX_SAFE_INTEGER));
    this.update({ phase: 'cancelled', level: 0 });
    this.settle(null);
  }

  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.stopCapture();
    this.clearTimers();
    this.closeSocket();
    this.flushFrames();
    this.listeners.clear();
  }

  detach(): void {
    const phase = this.current.phase;
    if (phase === 'starting' || phase === 'recording' || phase === 'paused') this.finish();
    this.listeners.clear();
  }

  async markInserted(): Promise<void> {
    this.write((store) => store.append(this.id, { t: 'inserted', at: this.now() }));
    this.write((store) => store.dropFrames(this.id, Number.MAX_SAFE_INTEGER));
    await this.io;
  }

  async saveTidy(markdown: string): Promise<void> {
    this.write((store) => store.append(this.id, { t: 'tidy', markdown }));
    await this.io;
  }

  flushed(): Promise<void> {
    return this.io;
  }

  private samples(pcm: Int16Array): void {
    if (this.current.phase !== 'recording') return;
    let data = pcm;
    if (this.carry.length) {
      data = new Int16Array(this.carry.length + pcm.length);
      data.set(this.carry);
      data.set(pcm, this.carry.length);
    }
    let at = 0;
    while (data.length - at >= FRAME_SAMPLES && this.current.phase === 'recording') {
      this.addFrame(data.subarray(at, at + FRAME_SAMPLES));
      at += FRAME_SAMPLES;
    }
    this.carry = data.slice(at);
  }

  private addFrame(samples: Int16Array): void {
    const bytes = new Uint8Array(FRAME_BYTES);
    new Int16Array(bytes.buffer).set(samples);
    const index = this.recorded++;
    this.frames.set(index, bytes);
    if (!this.unsaved.length) this.unsavedFirst = index;
    this.unsaved.push(bytes);
    if (this.unsaved.length >= 5) this.flushFrames();
    const rms = rmsOf(samples);
    this.silentFrames = rms < VOICE_RMS ? this.silentFrames + 1 : 0;
    const elapsedMs = this.recorded * FRAME_MS;
    this.update({ elapsedMs, remainingMs: Math.max(0, this.maxMs - elapsedMs), silenceMs: this.silentFrames * FRAME_MS, level: frameLevel(rms) });
    if (this.current.phase === 'recording') {
      if (elapsedMs >= this.maxMs) this.finish('limit');
      else if (this.current.mode === 'handsFree' && this.silentFrames * FRAME_MS >= this.silenceFinishMs) this.finish('silence');
    }
    this.pump();
  }

  private flushFrames(): void {
    if (!this.unsaved.length) return;
    const first = this.unsavedFirst;
    const batch = this.unsaved;
    this.unsaved = [];
    this.write((store) => store.putFrames(this.id, first, batch));
  }

  private connect(): void {
    if (this.ws || this.isOver()) return;
    const c = contiguous(this.committed);
    const stale = [...this.committed.keys()].filter((seg) => seg >= c.nextSeg);
    if (stale.length) {
      for (const seg of stale) this.committed.delete(seg);
      this.write((store) => store.append(this.id, { t: 'rewind', nextSeg: c.nextSeg }));
    }
    for (const seg of [...this.segments.keys()]) if (seg >= c.nextSeg) this.segments.delete(seg);
    this.sent = c.endMs / FRAME_MS;
    this.acked = this.sent;
    this.finishSent = false;
    this.ready = false;
    this.update({ connection: this.attempt === 0 && this.current.connection !== 'offline' ? 'connecting' : this.current.connection, ...this.text() });
    void this.open(c.endMs, c.nextSeg);
  }

  private async open(fromMs: number, nextSeg: number): Promise<void> {
    let token: string | undefined;
    try {
      token = await this.options.token?.();
    } catch {
      token = undefined;
    }
    if (this.isOver() || this.ws) return;
    let ws: SocketLike;
    try {
      ws = (this.options.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(this.options.url);
    } catch {
      this.dropped();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && !this.ready) this.dropped();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const start: Record<string, unknown> = { type: 'start', v: PROTOCOL_VERSION, session: this.id, languages: this.options.languages, fromMs, nextSeg };
      if (token) start.token = token;
      if (this.options.surface) start.surface = this.options.surface;
      ws.send(JSON.stringify(start));
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      const parsed = parseServerEvent(event.data);
      if (parsed) this.event(parsed);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.dropped();
    };
    ws.onerror = () => undefined;
  }

  private event(event: ServerEvent): void {
    switch (event.type) {
      case 'ready':
        clearTimeout(this.connectTimer);
        this.ready = true;
        this.attempt = 0;
        this.update({ connection: 'online', ...(this.current.phase === 'pending' ? { phase: 'finishing' } : {}) });
        this.pump();
        break;
      case 'interim':
        if (this.committed.has(event.seg)) return;
        this.segments.set(event.seg, { seg: event.seg, text: event.text, final: false });
        this.update(this.text());
        break;
      case 'commit': {
        const segment: CommittedSegment = { seg: event.seg, text: event.text, startMs: event.startMs, endMs: event.endMs };
        this.committed.set(event.seg, segment);
        this.segments.set(event.seg, { seg: event.seg, text: event.text, final: true });
        this.write((store) => store.append(this.id, { t: 'commit', ...segment }));
        const below = contiguous(this.committed).endMs / FRAME_MS;
        for (const k of [...this.frames.keys()]) if (k < below) this.frames.delete(k);
        this.write((store) => store.dropFrames(this.id, below));
        this.update(this.text());
        break;
      }
      case 'ack':
        this.acked = Math.max(this.acked, event.ms / FRAME_MS);
        this.pump();
        break;
      case 'done':
        this.complete();
        break;
      case 'error':
        if (event.code === 'unauthorized') {
          this.unauthorized++;
          if (this.unauthorized >= 3) {
            this.closeSocket();
            this.fail('unauthorized');
          }
          return;
        }
        if (!event.retryable) {
          this.closeSocket();
          this.fail('rejected');
        }
        break;
    }
  }

  private complete(): void {
    if (this.current.phase === 'done') return;
    this.clearTimers();
    this.closeSocket();
    this.write((store) => store.append(this.id, { t: 'complete', at: this.now() }));
    const text = committedText(this.committed);
    this.update({ phase: 'done', connection: 'online', committed: text, interim: '', level: 0 });
    this.settle({ session: this.id, text });
  }

  private dropped(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.pumpTimer);
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => undefined;
      try {
        ws.close();
      } catch {
        undefined;
      }
    }
    if (this.isOver()) return;
    for (const seg of [...this.segments.keys()]) if (!this.committed.has(seg)) this.segments.delete(seg);
    const phase = this.current.phase === 'finishing' ? 'pending' : this.current.phase;
    this.update({ connection: 'offline', phase, ...this.text() });
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private pump(): void {
    const ws = this.ws;
    if (!ws || !this.ready) return;
    clearTimeout(this.pumpTimer);
    try {
      while (this.sent < this.recorded && this.sent < this.acked + WINDOW_FRAMES) {
        const frame = this.frames.get(this.sent);
        if (!frame) break;
        ws.send(frame);
        this.sent++;
        if (ws.bufferedAmount > 256 * 1024) {
          this.pumpTimer = setTimeout(() => this.pump(), 50);
          return;
        }
      }
      if (this.finishRequested && !this.finishSent && this.sent === this.recorded) {
        this.finishSent = true;
        ws.send(JSON.stringify({ type: 'finish', endMs: (this.endFrame ?? this.recorded) * FRAME_MS }));
      }
    } catch {
      this.dropped();
    }
  }

  private text(): { committed: string; interim: string } {
    return displayText(this.segments.values());
  }

  private fail(failure: VoiceFailure): void {
    if (this.isOver()) return;
    this.stopCapture();
    this.clearTimers();
    this.closeSocket();
    this.flushFrames();
    if (failure === 'microphone') {
      this.write((store) => store.remove(this.id));
    }
    this.update({ phase: 'failed', failure, level: 0 });
    this.settle(null);
  }

  private stopCapture(): void {
    const capture = this.capture;
    this.capture = undefined;
    try {
      capture?.stop();
    } catch {
      undefined;
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    clearTimeout(this.connectTimer);
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => undefined;
    try {
      ws.close(1000);
    } catch {
      undefined;
    }
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.pumpTimer);
  }

  private isOver(): boolean {
    if (this.abandoned) return true;
    const phase = this.current.phase;
    return phase === 'done' || phase === 'failed' || phase === 'cancelled';
  }

  private write(work: (store: VoiceStore) => Promise<void>): void {
    this.io = this.io.then(() => work(this.options.store)).catch(() => {
      this.storageFailed = true;
    });
  }

  private update(patch: Partial<VoiceState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof VoiceState>) {
      if (this.current[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener(this.current);
  }
}
