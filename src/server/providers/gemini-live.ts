import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ProviderSpec, SpeechProvider } from './types.js';

export const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface GeminiMessage {
  error?: unknown;
  goAway?: unknown;
  setupComplete?: unknown;
  serverContent?: {
    inputTranscription?: { text?: unknown };
    interimInputTranscription?: { text?: unknown };
  };
}

export class GeminiLiveProvider extends EventEmitter implements SpeechProvider {
  private ws?: WebSocket;
  private ready = false;
  private closed = false;
  private finishing = false;
  private committed = '';
  private bytes = 0;

  constructor(private apiKey: string | undefined, private readonly model: string) {
    super();
  }

  start(): void {
    if (this.closed || this.ws) return;
    if (!this.apiKey) {
      queueMicrotask(() => this.fail('Gemini is not configured'));
      return;
    }
    try {
      const ws = new WebSocket(ENDPOINT, { headers: { 'x-goog-api-key': this.apiKey }, handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false });
      this.ws = ws;
      ws.on('open', () => {
        this.send({
          setup: {
            model: `models/${this.model}`,
            generationConfig: { responseModalities: ['TEXT'] },
            inputAudioTranscription: {},
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
        });
      });
      ws.on('message', (data: Buffer) => {
        if (this.closed) return;
        try {
          this.message(JSON.parse(data.toString()) as GeminiMessage);
        } catch {
          this.fail('Invalid Gemini response');
        }
      });
      ws.on('error', () => this.fail('Gemini connection failed'));
      ws.on('close', () => this.fail('Gemini disconnected'));
    } catch {
      this.fail('Gemini connection failed');
    }
  }

  private message(message: GeminiMessage): void {
    if (message.error || message.goAway) {
      this.fail('Gemini is unavailable');
      return;
    }
    if (message.setupComplete && !this.ready) {
      this.ready = true;
      this.send({ realtimeInput: { activityStart: {} } });
      if (!this.closed) this.emit('ready');
    }
    const content = message.serverContent;
    if (!this.ready || !content) return;
    const final = content.inputTranscription?.text;
    const interim = content.interimInputTranscription?.text;
    if (typeof final === 'string') {
      this.committed += final;
      const done = this.finishing;
      this.emit('transcript', { text: this.committed, final: done });
      if (done && !this.closed) {
        this.close();
        this.emit('done');
      }
    } else if (typeof interim === 'string') {
      this.emit('transcript', { text: this.committed + interim, final: false });
    }
  }

  private send(message: unknown): void {
    if (this.closed || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      this.fail('Gemini connection failed');
    }
  }

  get writable(): boolean {
    return !this.closed && this.ready && this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64 * 1024;
  }

  audio(pcm: Buffer): void {
    if (this.closed || this.finishing || !pcm.length) return;
    this.bytes += pcm.length;
    this.send({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    if (!this.bytes) {
      this.close();
      this.emit('done');
      return;
    }
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.emit('error', new Error(reason));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws?.terminate();
    this.apiKey = undefined;
    this.committed = '';
  }
}

export function geminiLive(options: { apiKey: string; model?: string; connectMs?: number; finishMs?: number }): ProviderSpec {
  const model = options.model ?? GEMINI_TRANSCRIBE_MODEL;
  return {
    name: 'gemini',
    connectMs: options.connectMs ?? 10_000,
    finishMs: options.finishMs ?? 15_000,
    create: () => new GeminiLiveProvider(options.apiKey, model),
  };
}
