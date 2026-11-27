import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { doubao, doubaoFrame, fakeProvider, parseDoubaoFrame, speechChain, speechChoiceFor, type ProviderTranscript } from '../src/server/index.js';

const response = (text: string, last: boolean, seq: number): Buffer => {
  const body = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
  const head = Buffer.from([0x11, (0b1001 << 4) | (last ? 0b0011 : 0b0001), 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  head.writeInt32BE(last ? -seq : seq, 4);
  head.writeUInt32BE(body.length, 8);
  return Buffer.concat([head, body]);
};

const errorFrame = (code: number, message: string): Buffer => {
  const text = Buffer.from(message);
  const head = Buffer.from([0x11, 0b1111 << 4, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  head.writeUInt32BE(code, 4);
  head.writeUInt32BE(text.length, 8);
  return Buffer.concat([head, text]);
};

const unpack = (frame: Buffer) => ({ type: frame[1]! >> 4, flags: frame[1]! & 0x0f, payload: gunzipSync(frame.subarray(8)) });

describe('speech choice', () => {
  it('a Chinese first language picks Doubao; any other picks Gemini', () => {
    expect(speechChoiceFor(['zh-CN', 'en-US'])).toBe('doubao');
    expect(speechChoiceFor(['zh-Hant-TW'])).toBe('doubao');
    expect(speechChoiceFor(['en-US', 'zh-CN'])).toBe('gemini');
    expect(speechChoiceFor(['ja-JP'])).toBe('gemini');
    expect(speechChoiceFor([])).toBe('gemini');
  });
  it('the chosen service goes first and the others stay as fallbacks', () => {
    const set = { doubao: fakeProvider('doubao'), doubaoIme: fakeProvider('doubao-ime'), gemini: fakeProvider('gemini') };
    expect(speechChain('doubao', set).map((p) => p.name)).toEqual(['doubao', 'doubao-ime', 'gemini']);
    expect(speechChain('gemini', set).map((p) => p.name)).toEqual(['gemini', 'doubao', 'doubao-ime']);
    expect(speechChain('doubao', { gemini: set.gemini }).map((p) => p.name)).toEqual(['gemini']);
  });
});

describe('Doubao frames', () => {
  it('a client frame carries the type, the flags and a gzip payload', () => {
    const frame = doubaoFrame(0b0010, 0b0010, 0, Buffer.from([1, 2, 3]));
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x22, 0x01, 0]);
    expect(frame.readUInt32BE(4)).toBe(frame.length - 8);
    expect([...gunzipSync(frame.subarray(8))]).toEqual([1, 2, 3]);
  });
  it('reads a response, the last response and an error', () => {
    expect(parseDoubaoFrame(response('你好', false, 1))).toEqual({ last: false, text: '你好' });
    expect(parseDoubaoFrame(response('你好。', true, 2))).toEqual({ last: true, text: '你好。' });
    expect(parseDoubaoFrame(errorFrame(45000001, 'bad request'))).toEqual({ last: true, error: { code: 45000001, message: 'bad request' } });
    expect(() => parseDoubaoFrame(response('你好', false, 1).subarray(0, 14))).toThrow();
  });
});

describe('Doubao provider', () => {
  let wss: WebSocketServer | undefined;
  afterEach(() => wss?.close());

  const serve = async (handle: (ws: WebSocket, headers: Record<string, string | string[] | undefined>) => void) => {
    wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws, req) => handle(ws, req.headers));
    await new Promise((resolve) => wss!.once('listening', resolve));
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  };

  it('sends the key, the request, the audio and an empty last packet, and reports the final text', async () => {
    const seen: { headers?: Record<string, string | string[] | undefined>; request?: unknown; audio: number; lastFlags?: number } = { audio: 0 };
    const endpoint = await serve((ws, headers) => {
      seen.headers = headers;
      let seq = 0;
      ws.on('message', (data: Buffer) => {
        const frame = unpack(data);
        if (frame.type === 0b0001) {
          seen.request = JSON.parse(frame.payload.toString());
          return;
        }
        if (frame.flags === 0b0010) {
          seen.lastFlags = frame.flags;
          ws.send(response('做一个短片。', true, ++seq));
          return;
        }
        seen.audio += frame.payload.length;
        ws.send(response('做一个', false, ++seq));
      });
    });
    const provider = doubao({ apiKey: 'test-key', endpoint, hotwords: ['15perf'] }).create({ userId: 'u', deviceId: '1234', languages: ['zh-CN'] });
    const transcripts: ProviderTranscript[] = [];
    provider.on('transcript', (t) => transcripts.push(t));
    const done = new Promise<void>((resolve) => provider.on('done', resolve));
    await new Promise<void>((resolve) => {
      provider.on('ready', resolve);
      provider.start();
    });
    provider.audio(Buffer.alloc(3200));
    await new Promise((resolve) => setTimeout(resolve, 50));
    provider.finish();
    await done;
    expect(seen.headers?.['x-api-key']).toBe('test-key');
    expect(seen.headers?.['x-api-resource-id']).toBe('volc.seedasr.sauc.duration');
    expect(seen.headers?.['x-api-connect-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.request).toMatchObject({ user: { uid: '1234' }, audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', corpus: { context: '{"hotwords":[{"word":"15perf"}]}' } } });
    expect(seen.audio).toBe(3200);
    expect(seen.lastFlags).toBe(0b0010);
    expect(transcripts).toEqual([{ text: '做一个', final: false }, { text: '做一个短片。', final: true }]);
  });

  it('smooth asks Doubao to remove fillers and repeats (enable_ddc); it is off by default', async () => {
    const requests: unknown[] = [];
    const endpoint = await serve((ws) => {
      ws.on('message', (data: Buffer) => {
        const frame = unpack(data);
        if (frame.type === 0b0001) requests.push(JSON.parse(frame.payload.toString()));
      });
    });
    for (const smooth of [true, false]) {
      const provider = doubao({ apiKey: 'test-key', endpoint, smooth }).create({ userId: 'u', deviceId: '1234', languages: ['zh-CN'] });
      provider.on('error', () => undefined);
      await new Promise<void>((resolve) => {
        provider.on('ready', resolve);
        provider.start();
      });
      const count = requests.length;
      for (let n = 0; n < 100 && requests.length === count; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      provider.close();
    }
    expect((requests[0] as { request: Record<string, unknown> }).request.enable_ddc).toBe(true);
    expect((requests[1] as { request: Record<string, unknown> }).request).not.toHaveProperty('enable_ddc');
  });

  it('an error frame fails the provider so the relay moves on', async () => {
    const endpoint = await serve((ws) => {
      ws.on('message', () => ws.send(errorFrame(55000031, 'busy')));
    });
    const provider = doubao({ apiKey: 'test-key', endpoint }).create({ userId: 'u', deviceId: '1', languages: [] });
    const failed = new Promise<Error>((resolve) => provider.on('error', resolve));
    provider.start();
    expect((await failed).message).toBe('Doubao error 55000031');
  });

  it('without a key it fails at once', async () => {
    const provider = doubao({ apiKey: undefined }).create({ userId: 'u', deviceId: '1', languages: [] });
    const failed = new Promise<Error>((resolve) => provider.on('error', resolve));
    provider.start();
    expect((await failed).message).toBe('Doubao is not configured');
  });

  it('a finish with no audio ends without a request', async () => {
    const endpoint = await serve(() => undefined);
    const provider = doubao({ apiKey: 'k', endpoint }).create({ userId: 'u', deviceId: '1', languages: [] });
    await new Promise<void>((resolve) => {
      provider.on('ready', resolve);
      provider.start();
    });
    const done = new Promise<void>((resolve) => provider.on('done', resolve));
    provider.finish();
    await done;
    expect(provider.writable).toBe(false);
  });
});
