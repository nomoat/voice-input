import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ProviderContext, ProviderSpec, SpeechProvider } from './types.js';

const ENDPOINT = 'wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws';
const APP_KEY = 'OrnqKvSSrs';
const CHUNK = 3200;

function varint(value: number): Buffer {
  const out: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(out);
}

export function encodeDoubaoRequest(input: { event: string; taskId: string; payload?: string; data?: Buffer; seq?: number }): Buffer {
  const parts: Buffer[] = [];
  const fields: Array<[number, string | Buffer | undefined]> = [
    [2, APP_KEY],
    [3, 'ASR'],
    [5, input.event],
    [6, input.payload],
    [7, input.data],
    [8, input.taskId],
  ];
  for (const [field, value] of fields) {
    if (!value?.length) continue;
    const bytes = Buffer.from(value);
    parts.push(varint(field * 8 + 2), varint(bytes.length), bytes);
  }
  if (input.seq) parts.push(varint(72), varint(input.seq));
  return Buffer.concat(parts);
}

export function decodeDoubaoResponse(bytes: Buffer): { event: string; status?: number; message?: string; payload: string } {
  const fields: Record<number, number | string> = {};
  let offset = 0;
  const read = (): number => {
    let n = 0;
    let multiplier = 1;
    for (let count = 0; count < 8 && offset < bytes.length; count++) {
      const b = bytes[offset++]!;
      n += (b & 127) * multiplier;
      if (!(b & 128)) return n;
      multiplier *= 128;
    }
    throw new Error('Invalid ASR frame');
  };
  while (offset < bytes.length) {
    const tag = read();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields[field] = read();
    else if (wire === 2) {
      const size = read();
      if (offset + size > bytes.length) throw new Error('Truncated ASR frame');
      fields[field] = bytes.subarray(offset, offset + size).toString();
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Truncated ASR frame');
    } else throw new Error('Invalid ASR frame');
  }
  const out: { event: string; status?: number; message?: string; payload: string } = {
    event: typeof fields[4] === 'string' ? fields[4] : '',
    payload: typeof fields[7] === 'string' ? fields[7] : '',
  };
  if (typeof fields[5] === 'number') out.status = fields[5];
  if (typeof fields[6] === 'string') out.message = fields[6];
  return out;
}

export class DoubaoImeProvider extends EventEmitter implements SpeechProvider {
  private ws?: WebSocket;
  private readonly taskId = randomUUID().replaceAll('-', '');
  private seq = 0;
  private carry: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly deviceId: string, private readonly Socket: typeof WebSocket = WebSocket) {
    super();
  }

  start(): void {
    const url = new URL(ENDPOINT);
    const params: Record<string, string> = {
      aid: '685343', device_id: this.deviceId, app_name: 'oime_macos', channel: 'release', device_platform: 'mac',
      device_type: 'mac', device_brand: 'Apple', os: 'macOS', os_version: '15.6.0', version_code: '1.0.2',
      version_name: '1.0.2', app_version: '1.0.2',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const ws = new this.Socket(url, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      headers: { 'proto-version': 'v2', 'sdk-version': '2', 'x-tt-token': '', 'x-tt-e-k': `${this.deviceId}+W`, 'x-custom-keepalive': 'true' },
    });
    this.ws = ws;
    ws.on('open', () => {
      this.send('StartTask');
      this.send('StartSession', {
        audio_info: { channel: 1, format: 'pcm', sample_rate: 16000 },
        enable_punctuation: true,
        enable_speech_rejection: false,
        extra: {
          app_name: 'oime_macos', app_version: '1.0.2', device_id: this.deviceId, enable_asr_format: true,
          enable_asr_threepass: true, enable_asr_twopass: true, enable_print_chinese: true, enable_text_filter: true,
          finish_wait_offline_time: 1000, input_mode: 'wave', join_user_experience_improve_program: false,
          remove_space_between_han_eng: false, remove_space_between_han_num: true, strong_ddc: true, use_twopass_retry: true,
        },
      });
    });
    ws.on('message', (bytes: Buffer, binary: boolean) => {
      if (!binary) {
        if (bytes.toString() === 'ping') ws.send('pong');
        return;
      }
      try {
        const frame = decodeDoubaoResponse(bytes);
        if (frame.status && frame.status !== 20000000) throw new Error('Doubao rejected the session');
        if (/Failed$/.test(frame.event)) throw new Error('Doubao session failed');
        if (frame.event === 'SessionStarted') this.emit('ready');
        if (frame.payload) {
          const payload = JSON.parse(frame.payload) as { results?: Array<{ text?: unknown; is_interim?: unknown }> };
          const result = payload.results?.[0];
          if (typeof result?.text === 'string') this.emit('transcript', { text: result.text, final: result.is_interim === false });
        }
        if (frame.event === 'SessionFinished') {
          this.ended = true;
          this.send('FinishTask');
          this.emit('done');
          this.close();
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Doubao response error'));
      }
    });
    ws.on('error', () => this.fail(new Error('Doubao connection failed')));
    ws.on('close', () => {
      if (!this.ended) this.fail(new Error('Doubao disconnected'));
    });
  }

  private send(event: string, payload?: unknown, data?: Buffer, seq?: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const request: { event: string; taskId: string; payload?: string; data?: Buffer; seq?: number } = { event, taskId: this.taskId };
    if (payload !== undefined) request.payload = JSON.stringify(payload);
    if (data) request.data = data;
    if (seq) request.seq = seq;
    this.ws.send(encodeDoubaoRequest(request));
  }

  audio(pcm: Buffer): void {
    if (this.ended) return;
    this.carry = Buffer.concat([this.carry, pcm]);
    while (this.carry.length >= CHUNK) {
      this.send('TaskRequest', { timestamp_ms: Date.now() }, this.carry.subarray(0, CHUNK), ++this.seq);
      this.carry = this.carry.subarray(CHUNK);
    }
  }

  get writable(): boolean {
    return !this.ended && this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64 * 1024;
  }

  finish(): void {
    if (this.ended) return;
    if (this.carry.length) {
      this.send('TaskRequest', { timestamp_ms: Date.now() }, this.carry, ++this.seq);
      this.carry = Buffer.alloc(0);
    }
    this.send('FinishSession');
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.close();
    this.emit('error', error);
  }

  close(): void {
    this.ended = true;
    this.ws?.terminate();
  }
}

export function doubaoIme(options: { connectMs?: number; finishMs?: number } = {}): ProviderSpec {
  return {
    name: 'doubao-ime',
    connectMs: options.connectMs ?? 5_000,
    finishMs: options.finishMs ?? 6_000,
    create: (context: ProviderContext) => new DoubaoImeProvider(context.deviceId),
  };
}
