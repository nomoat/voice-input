import { EventEmitter } from 'node:events';
import type { ProviderContext, ProviderSpec, SpeechProvider } from './providers/types.js';

export interface SegmentOptions {
  seg: number;
  startFrame: number;
  providers: ProviderSpec[];
  context: ProviderContext;
  onProvider?: (name: string, attempt: number) => void;
}

export class Segment extends EventEmitter {
  readonly seg: number;
  readonly startFrame: number;
  private frames: Buffer[] = [];
  private voiced = false;
  private ended = false;
  private settled = false;
  private attempt = -1;
  private provider: SpeechProvider | undefined;
  private providerReady = false;
  private cursor = 0;
  private finishSent = false;
  private timer: NodeJS.Timeout | undefined;
  private pumpTimer: NodeJS.Timeout | undefined;
  private lastText = '';
  private lastLength = 0;
  private heard = false;

  constructor(private readonly options: SegmentOptions) {
    super();
    this.seg = options.seg;
    this.startFrame = options.startFrame;
  }

  get endFrame(): number {
    return this.startFrame + this.frames.length;
  }

  get attempts(): number {
    return Math.max(0, this.attempt + 1);
  }

  append(frame: Buffer, voice: boolean): void {
    if (this.ended || this.settled) return;
    this.frames.push(frame);
    if (!this.voiced && voice) {
      this.voiced = true;
      this.next();
      return;
    }
    this.pump();
  }

  end(): void {
    if (this.ended || this.settled) return;
    this.ended = true;
    if (!this.voiced) {
      this.commit('');
      return;
    }
    this.pump();
  }

  close(): void {
    if (this.settled) return;
    this.settled = true;
    this.disconnect();
    this.frames = [];
  }

  private next(): void {
    if (this.settled) return;
    this.disconnect();
    this.attempt++;
    this.cursor = 0;
    this.providerReady = false;
    this.finishSent = false;
    const spec = this.options.providers[this.attempt];
    if (!spec) {
      this.close();
      this.emit('failed');
      return;
    }
    let provider: SpeechProvider;
    try {
      provider = spec.create(this.options.context);
    } catch {
      queueMicrotask(() => this.next());
      return;
    }
    this.provider = provider;
    this.options.onProvider?.(spec.name, this.attempt);
    const current = () => !this.settled && this.provider === provider;
    provider.on('error', () => {
      if (current()) this.next();
    });
    provider.on('ready', () => {
      if (!current() || this.providerReady) return;
      clearTimeout(this.timer);
      this.providerReady = true;
      this.pump();
    });
    provider.on('transcript', (result) => {
      if (!current()) return;
      if (this.attempt > 0 && !result.final && result.text.length < this.lastLength) return;
      this.heard = true;
      this.lastLength = result.text.length;
      this.lastText = result.text;
      this.emit('interim', result.text);
    });
    provider.on('done', () => {
      if (current()) this.commit(this.lastText);
    });
    this.timer = setTimeout(() => {
      if (current()) this.next();
    }, spec.connectMs ?? 8_000);
    try {
      provider.start();
    } catch {
      this.next();
    }
  }

  private pump(): void {
    const provider = this.provider;
    if (this.settled || !provider || !this.providerReady) return;
    clearTimeout(this.pumpTimer);
    try {
      let sent = 0;
      while (this.cursor < this.frames.length && provider.writable && sent < 50) {
        provider.audio(this.frames[this.cursor++]!);
        sent++;
        if (this.provider !== provider || this.settled) return;
      }
      if (this.cursor < this.frames.length) {
        this.pumpTimer = setTimeout(() => this.pump(), 5);
        return;
      }
      if (this.ended && !this.finishSent) {
        this.finishSent = true;
        const spec = this.options.providers[this.attempt];
        this.timer = setTimeout(() => {
          if (this.provider !== provider || this.settled) return;
          this.commit(this.lastText);
        }, spec?.finishMs ?? 8_000);
        provider.finish();
      }
    } catch {
      if (this.provider === provider) this.next();
    }
  }

  private commit(text: string): void {
    if (this.settled) return;
    const endFrame = this.endFrame;
    this.close();
    this.emit('commit', { text: text.trim(), endFrame, heard: this.heard });
  }

  private disconnect(): void {
    clearTimeout(this.timer);
    clearTimeout(this.pumpTimer);
    const provider = this.provider;
    this.provider = undefined;
    provider?.removeAllListeners();
    provider?.on('error', () => undefined);
    provider?.close();
  }
}
