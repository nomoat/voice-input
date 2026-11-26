import { EventEmitter } from 'node:events';
import { FRAME_BYTES } from '../../protocol.js';
import type { ProviderSpec, SpeechProvider } from './types.js';

export interface FakeBehavior {
  readyMs?: number;
  finishMs?: number;
  failOnStart?: boolean;
  failAfterBytes?: number;
  neverFinish?: boolean;
  text?: (frames: number[]) => string;
}

export const frameLabel = (frames: number[]): string => frames.map((f) => `f${f}`).join(' ');

export function fakeFrame(index: number, amplitude = 8000): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) frame.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  frame.writeInt16LE(index & 0x7fff, 2);
  frame.writeInt16LE(amplitude ? 0x1234 : 0, 4);
  return frame;
}

export class FakeProvider extends EventEmitter implements SpeechProvider {
  readonly frames: number[] = [];
  private received = 0;
  private closed = false;
  private finishing = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly behavior: FakeBehavior = {}) {
    super();
  }

  start(): void {
    if (this.behavior.failOnStart) {
      this.timer = setTimeout(() => this.fail(), 1);
      return;
    }
    this.timer = setTimeout(() => !this.closed && this.emit('ready'), this.behavior.readyMs ?? 1);
  }

  get writable(): boolean {
    return !this.closed;
  }

  audio(pcm: Buffer): void {
    if (this.closed || this.finishing) return;
    this.received += pcm.length;
    for (let at = 0; at + 6 <= pcm.length; at += FRAME_BYTES) {
      if (pcm.readInt16LE(at + 4) === 0x1234) this.frames.push(pcm.readInt16LE(at + 2));
    }
    if (this.behavior.failAfterBytes !== undefined && this.received >= this.behavior.failAfterBytes) {
      this.fail();
      return;
    }
    this.emit('transcript', { text: this.text(), final: false });
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    if (this.behavior.neverFinish) return;
    this.timer = setTimeout(() => {
      if (this.closed) return;
      this.emit('transcript', { text: this.text(), final: true });
      this.emit('done');
      this.close();
    }, this.behavior.finishMs ?? 1);
  }

  private text(): string {
    return (this.behavior.text ?? frameLabel)(this.frames);
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.emit('error', new Error('fake failure'));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

export function fakeProvider(name: string, behavior: FakeBehavior | (() => FakeBehavior) = {}, timing: { connectMs?: number; finishMs?: number } = {}): ProviderSpec & { created: FakeProvider[] } {
  const created: FakeProvider[] = [];
  return {
    name,
    created,
    connectMs: timing.connectMs ?? 200,
    finishMs: timing.finishMs ?? 300,
    create: () => {
      const p = new FakeProvider(typeof behavior === 'function' ? behavior() : behavior);
      created.push(p);
      return p;
    },
  };
}
