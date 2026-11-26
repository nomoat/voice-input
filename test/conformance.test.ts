import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { displayText, insertText, joinText } from '../src/text.js';
import { move, press, release, type PressTrack } from '../src/client/gesture.js';
import { MemoryVoiceStore, VoiceSession, type CaptureSink, type SocketLike, type VoiceMode, type VoiceResult } from '../src/client/index.js';

const text = JSON.parse(readFileSync(new URL('../conformance/text.json', import.meta.url), 'utf8'));
const session = JSON.parse(readFileSync(new URL('../conformance/session.json', import.meta.url), 'utf8'));

describe('conformance: text', () => {
  for (const c of text.join) it(`join ${JSON.stringify(c.a)} + ${JSON.stringify(c.b)}`, () => expect(joinText(c.a, c.b)).toBe(c.out));
  for (const [i, c] of text.display.entries()) it(`display #${i}`, () => expect(displayText(c.segments)).toEqual({ committed: c.committed, interim: c.interim }));
  for (const [i, c] of text.insert.entries()) it(`insert #${i}`, () => expect(insertText(c.base, c.start, c.end, c.text)).toEqual({ value: c.value, caret: c.caret }));
  for (const [i, c] of text.gesture.entries()) {
    it(`gesture #${i}`, () => {
      let track: PressTrack | null = null;
      let result: string | null = null;
      for (const [kind, t, x, y] of c.events as Array<[string, number, number?, number?]>) {
        if (kind === 'down') track = press(t, x!, y!);
        else if (kind === 'move') track = move(track!, x!, y!);
        else result = release(track!, t);
      }
      expect(result).toBe(c.result);
    });
  }
});

class FakeSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  json: Array<Record<string, unknown>> = [];
  frames = 0;
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (typeof data === 'string') this.json.push(JSON.parse(data));
    else this.frames++;
  }
  close() {
    this.readyState = 3;
  }
}

describe('conformance: session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const scenario of session.scenarios) {
    it(scenario.name, async () => {
      const store = new MemoryVoiceStore();
      const sockets: FakeSocket[] = [];
      let sink: CaptureSink | undefined;
      let result: VoiceResult | null | undefined;
      let frame = 0;
      let checked = 0;
      const s = new VoiceSession({
        url: 'wss://test', languages: ['zh-CN'], target: 't', store,
        socket: () => {
          const ws = new FakeSocket();
          sockets.push(ws);
          return ws;
        },
        capture: async (k) => {
          sink = k;
          return { stop: () => undefined };
        },
      });
      void s.result.then((r) => {
        result = r;
      });
      const ws = () => sockets.at(-1)!;
      const settle = async () => {
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
        await s.flushed();
      };
      for (const step of scenario.steps) {
        if (step.do === 'start') await s.start(step.mode as VoiceMode);
        else if (step.do === 'frames') {
          for (let i = 0; i < step.count; i++) {
            const f = new Int16Array(1600).fill(frame % 2 ? 4000 : -4000);
            frame++;
            sink!.samples(f);
          }
        } else if (step.do === 'open') {
          await settle();
          ws().readyState = 1;
          ws().onopen?.({});
          checked = 0;
        } else if (step.do === 'drop') {
          ws().readyState = 3;
          ws().onclose?.({});
        } else if (step.do === 'reconnect') {
          const before = sockets.length;
          await vi.advanceTimersByTimeAsync(10_000);
          await settle();
          expect(sockets.length).toBe(before + 1);
        } else if (step.do === 'finish') s.finish();
        else if (step.do === 'cancel') s.cancel();
        else if (step.server) ws().onmessage?.({ data: JSON.stringify(step.server) });
        else if (step.sent) {
          const sent = ws().json.slice(checked);
          const match = sent.findIndex((m) => Object.entries(step.sent).every(([k, v]) => m[k] === v));
          expect(match, `sent ${JSON.stringify(step.sent)} in ${JSON.stringify(sent)}`).toBeGreaterThanOrEqual(0);
          checked += match + 1;
        } else if (step.expect) {
          await settle();
          const e = step.expect as Record<string, unknown>;
          const st = s.state as unknown as Record<string, unknown>;
          for (const key of ['phase', 'connection', 'committed', 'interim', 'elapsedMs', 'failure']) if (key in e) expect(st[key], key).toEqual(e[key]);
          if ('sentFrames' in e) expect(ws().frames).toBe(e.sentFrames);
          if ('storedFrames' in e) expect(store.frames.get(s.id)?.size ?? 0).toBe(e.storedFrames);
          if ('journal' in e) expect((store.journals.get(s.id) ?? []).map((r) => r.t)).toEqual(e.journal);
          if ('result' in e) expect(result === null ? null : result?.text).toEqual(e.result);
        }
      }
      s.abandon();
    });
  }
});
