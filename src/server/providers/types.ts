import type { EventEmitter } from 'node:events';

export interface ProviderTranscript {
  text: string;
  final: boolean;
}

export interface SpeechProvider extends EventEmitter {
  start(): void;
  audio(pcm: Buffer): void;
  finish(): void;
  close(): void;
  readonly writable: boolean;
  on(event: 'ready' | 'done', listener: () => void): this;
  on(event: 'transcript', listener: (t: ProviderTranscript) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
}

export interface ProviderContext {
  userId: string;
  deviceId: string;
  languages: string[];
}

export interface ProviderSpec {
  name: string;
  create(context: ProviderContext): SpeechProvider;
  connectMs?: number;
  finishMs?: number;
}
