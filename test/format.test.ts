import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WARM_EVERY_MS, fakeFrame, fakeProvider, FORMAT_SYSTEM, GEMINI_FORMAT_MODEL, geminiFormatter, RelaySession, type FormatContext, type SegmentFormatter, type ServerEvent, type StartMessage, type WarmContext } from '../src/server/index.js';

const start: StartMessage = { type: 'start', v: 1, session: 'session-0001', languages: ['zh-CN'], fromMs: 0, nextSeg: 0 };
const context = { userId: 'u1', deviceId: '1000000000000001', languages: ['zh-CN'] };
const timing = { minMs: 1_000, maxMs: 3_000, idleCutMs: 10_000 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const longText = (frames: number[]) => frames.map((f) => `word${f}`).join(' ');

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

function harness(format: SegmentFormatter, formatMs?: number, text: (frames: number[]) => string = longText) {
  const events: ServerEvent[] = [];
  let closed = false;
  const session = new RelaySession({
    start,
    providers: [fakeProvider('gemini', { text })],
    context,
    send: (e) => events.push(e),
    close: () => {
      closed = true;
    },
    timing,
    format,
    ...(formatMs !== undefined ? { formatMs } : {}),
  });
  return { session, events, closed: () => closed };
}

function speak(session: RelaySession, segments: number) {
  let i = 0;
  for (let k = 0; k < segments; k++) {
    for (let n = 0; n < 12; n++) session.audio(fakeFrame(i++));
    for (let n = 0; n < 4; n++) session.audio(fakeFrame(i++, 0));
  }
}

const commits = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { type: 'commit' }> => e.type === 'commit');
const spoken = (events: ServerEvent[]) => commits(events).filter((c) => c.text);

describe('segment formatting', () => {
  it('cleans each committed segment and keeps the commits in order when an earlier one is slower', async () => {
    const seen: { text: string; context: FormatContext }[] = [];
    const h = harness(async (text, ctx) => {
      seen.push({ text, context: ctx });
      if (text.startsWith('word0 ')) await wait(200);
      return text.toUpperCase();
    });
    speak(h.session, 3);
    h.session.finish();
    await until(() => h.closed());
    const c = spoken(h.events);
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c.map((x) => x.seg)).toEqual(c.map((_, n) => n));
    for (const x of c) expect(x.text).toBe(x.text.toUpperCase());
    expect(c[0]!.text.startsWith('WORD0 ')).toBe(true);
    expect(seen[0]!.context).toMatchObject({ provider: 'gemini', languages: ['zh-CN'] });
    expect(h.events.at(-1)).toEqual({ type: 'done', nextSeg: commits(h.events).length });
    expect(h.session.stats.format).toMatchObject({ used: c.length, skipped: 0, fallback: 0 });
  });

  it('leaves interim text raw', async () => {
    const h = harness(async (text) => text.toUpperCase());
    speak(h.session, 1);
    h.session.finish();
    await until(() => h.closed());
    const interims = h.events.filter((e): e is Extract<ServerEvent, { type: 'interim' }> => e.type === 'interim');
    expect(interims.length).toBeGreaterThan(0);
    for (const e of interims) expect(e.text).toBe(e.text.toLowerCase());
    expect(spoken(h.events)[0]!.text).toMatch(/^WORD0 /);
  });

  it('sends the raw text when the formatter takes longer than formatMs, and aborts it', async () => {
    const signals: AbortSignal[] = [];
    const h = harness((_text, ctx) => {
      if (ctx.signal) signals.push(ctx.signal);
      return new Promise(() => undefined);
    }, 60);
    speak(h.session, 1);
    const began = Date.now();
    h.session.finish();
    await until(() => h.closed());
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(spoken(h.events)[0]!.text).toMatch(/^word0 word1 /);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(h.session.stats.format).toMatchObject({ used: 0, fallback: 1 });
    expect(h.session.stats.format!.maxMs).toBeGreaterThanOrEqual(55);
  });

  it('sends the raw text when the cleaned text fails the guard or the formatter throws', async () => {
    const guard = harness(async () => 'short');
    speak(guard.session, 1);
    guard.session.finish();
    await until(() => guard.closed());
    expect(spoken(guard.events)[0]!.text).toMatch(/^word0 word1 /);
    expect(guard.session.stats.format).toMatchObject({ used: 0, fallback: 1 });

    const thrown = harness(async () => {
      throw new Error('model down');
    });
    speak(thrown.session, 1);
    thrown.session.finish();
    await until(() => thrown.closed());
    expect(spoken(thrown.events)[0]!.text).toMatch(/^word0 word1 /);
    expect(thrown.session.stats.format).toMatchObject({ used: 0, fallback: 1 });
  });

  it('a formatter that returns null leaves the text as it is (skipped)', async () => {
    const h = harness(async () => null);
    speak(h.session, 1);
    h.session.finish();
    await until(() => h.closed());
    expect(spoken(h.events)[0]!.text).toMatch(/^word0 word1 /);
    expect(h.session.stats.format).toMatchObject({ used: 0, skipped: 1, fallback: 0 });
  });

  it('done waits for a commit that is still being cleaned', async () => {
    let release: (() => void) | undefined;
    const h = harness((text) => new Promise((resolve) => {
      release = () => resolve(text.toUpperCase());
    }));
    speak(h.session, 1);
    h.session.finish();
    await until(() => release !== undefined);
    await wait(30);
    expect(spoken(h.events)).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'done')).toBe(false);
    release!();
    await until(() => h.closed());
    expect(h.events.slice(-2).map((e) => e.type)).toEqual(['commit', 'done']);
    expect(spoken(h.events)[0]!.text).toMatch(/^WORD0 /);
  });

  it('a cancel while a segment is being cleaned sends no commit and aborts the formatter', async () => {
    let signal: AbortSignal | undefined;
    const h = harness((_text, ctx) => {
      signal = ctx.signal;
      return new Promise(() => undefined);
    });
    speak(h.session, 1);
    h.session.finish();
    await until(() => signal !== undefined);
    h.session.cancel();
    await wait(20);
    expect(signal!.aborted).toBe(true);
    expect(spoken(h.events)).toHaveLength(0);
  });

  it('without a formatter the commit goes out as before and the metric has no format counts', async () => {
    const events: ServerEvent[] = [];
    const session = new RelaySession({ start, providers: [fakeProvider('a')], context, send: (e) => events.push(e), close: () => undefined, timing });
    speak(session, 1);
    session.finish();
    await until(() => events.some((e) => e.type === 'done'));
    expect(spoken(events)).toHaveLength(1);
    expect(session.stats.format).toBeUndefined();
  });
});

describe('geminiFormatter', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
  });

  interface Seen {
    url?: string;
    headers?: IncomingHttpHeaders;
    body?: unknown;
    requests: { method: string; url: string; port: number; key: unknown }[];
  }

  const serve = async (reply: (body: unknown, method: string) => { status: number; json: unknown; delayMs?: number }) => {
    const seen: Seen = { requests: [] };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const method = req.method ?? '';
        seen.requests.push({ method, url: req.url ?? '', port: req.socket.remotePort ?? 0, key: req.headers['x-goog-api-key'] });
        const body = raw ? JSON.parse(raw) : undefined;
        if (method === 'POST') {
          seen.url = req.url;
          seen.headers = req.headers;
          seen.body = body;
        }
        const out = reply(body, method);
        const send = () => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.json));
        };
        if (out.delayMs) setTimeout(send, out.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`, seen };
  };

  const ctx: FormatContext = { provider: 'gemini', languages: ['zh-CN'] };
  const warmContext: WarmContext = { providers: ['gemini'], languages: ['zh-CN'] };
  const echo = (body: unknown, method: string) => {
    if (method === 'GET') return { status: 200, json: { name: `models/${GEMINI_FORMAT_MODEL}` } };
    const text = (body as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text;
    return { status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: text.toUpperCase() }] } }] } };
  };

  it('asks the fast model with the short-segment prompt, minimal thinking and temperature 0', async () => {
    const { endpoint, seen } = await serve(() => ({ status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '我想做一个三十秒的短片。' }] } }] } }));
    const out = await geminiFormatter({ apiKey: 'test-key', endpoint })('嗯那个我想做一个就是说一个三十秒的短片啊', ctx);
    expect(out).toBe('我想做一个三十秒的短片。');
    expect(seen.url).toBe(`/v1beta/models/${GEMINI_FORMAT_MODEL}:generateContent`);
    expect(GEMINI_FORMAT_MODEL).toBe('gemini-3.5-flash-lite');
    expect(seen.headers?.['x-goog-api-key']).toBe('test-key');
    expect(seen.body).toMatchObject({
      systemInstruction: { parts: [{ text: FORMAT_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: '嗯那个我想做一个就是说一个三十秒的短片啊' }] }],
      generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    expect(FORMAT_SYSTEM).toContain('keep only the corrected version');
  });

  it('fails on an HTTP error, a cut-off answer or an empty answer, so the relay sends the raw text', async () => {
    const replies = [
      { status: 500, json: { error: { message: 'busy' } } },
      { status: 200, json: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '我想' }] } }] } },
      { status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '  ' }] } }] } },
    ];
    let n = 0;
    const { endpoint } = await serve(() => replies[n++]!);
    const format = geminiFormatter({ apiKey: 'k', endpoint });
    for (let k = 0; k < replies.length; k++) await expect(format('嗯我想做一个短片', ctx)).rejects.toThrow();
  });

  it('stops the request when the relay aborts it', async () => {
    const { endpoint } = await serve(() => ({ status: 200, json: {} }));
    server!.removeAllListeners('request');
    server!.on('request', () => undefined);
    const controller = new AbortController();
    const pending = geminiFormatter({ apiKey: 'k', endpoint })('嗯', { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
  });

  it('warm-up GETs the model with the key, and the first clean-up reuses that connection', async () => {
    const { endpoint, seen } = await serve(echo);
    const format = geminiFormatter({ apiKey: 'test-key', endpoint });
    expect(format.warm!(warmContext)).toBeUndefined();
    await until(() => seen.requests.length === 1);
    await wait(20);
    expect(await format('word0 word1 word2', ctx)).toBe('WORD0 WORD1 WORD2');
    expect(seen.requests.map((r) => [r.method, r.url, r.key])).toEqual([
      ['GET', `/v1beta/models/${GEMINI_FORMAT_MODEL}`, 'test-key'],
      ['POST', `/v1beta/models/${GEMINI_FORMAT_MODEL}:generateContent`, 'test-key'],
    ]);
    expect(seen.requests[1]!.port).toBe(seen.requests[0]!.port);
  });

  it('warm-up runs at most once while one is in flight', async () => {
    const { endpoint, seen } = await serve(() => ({ status: 200, json: {}, delayMs: 200 }));
    const format = geminiFormatter({ apiKey: 'k', endpoint, warmEveryMs: 0 });
    format.warm!(warmContext);
    format.warm!(warmContext);
    format.warm!(warmContext);
    await wait(120);
    expect(seen.requests).toHaveLength(1);
    await wait(250);
    format.warm!(warmContext);
    await until(() => seen.requests.length === 2);
  });

  it('warm-up runs at most once per warmEveryMs (default 30 s), and a recent clean-up counts as warm', async () => {
    expect(DEFAULT_WARM_EVERY_MS).toBe(30_000);
    const { endpoint, seen } = await serve(echo);
    const fresh = geminiFormatter({ apiKey: 'k', endpoint });
    fresh.warm!(warmContext);
    await until(() => seen.requests.length === 1);
    await wait(50);
    fresh.warm!(warmContext);
    await wait(50);
    expect(seen.requests).toHaveLength(1);

    const used = geminiFormatter({ apiKey: 'k', endpoint });
    await used('word0 word1', ctx);
    used.warm!(warmContext);
    await wait(50);
    expect(seen.requests.map((r) => r.method)).toEqual(['GET', 'POST']);

    const short = geminiFormatter({ apiKey: 'k', endpoint, warmEveryMs: 150 });
    short.warm!(warmContext);
    await until(() => seen.requests.length === 3);
    await wait(250);
    short.warm!(warmContext);
    await until(() => seen.requests.length === 4);
  });

  it('a failing warm-up never throws: refused connection or HTTP error', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = geminiFormatter({ apiKey: 'k', endpoint: `http://127.0.0.1:${port}/v1beta` });
    expect(() => refused.warm!(warmContext)).not.toThrow();

    const { endpoint, seen } = await serve(() => ({ status: 500, json: { error: { message: 'busy' } } }));
    const failing = geminiFormatter({ apiKey: 'k', endpoint });
    expect(() => failing.warm!(warmContext)).not.toThrow();
    await until(() => seen.requests.length === 1);
    await wait(100);
  });

  it('a session warms the formatter once when it starts, right after ready and before any commit', async () => {
    const calls: { context: WarmContext; events: string[] }[] = [];
    const make = () => {
      const events: ServerEvent[] = [];
      let closed = false;
      const format: SegmentFormatter = async (text) => text.toUpperCase();
      format.warm = (warm) => {
        calls.push({ context: warm, events: events.map((e) => e.type) });
      };
      const session = new RelaySession({ start, providers: [fakeProvider('gemini', { text: longText }), fakeProvider('doubao')], context, send: (e) => events.push(e), close: () => { closed = true; }, timing, format });
      return { session, closed: () => closed };
    };
    const first = make();
    expect(calls).toEqual([{ context: { providers: ['gemini', 'doubao'], languages: ['zh-CN'] }, events: ['ready'] }]);
    speak(first.session, 2);
    first.session.finish();
    await until(() => first.closed());
    expect(calls).toHaveLength(1);
    make().session.cancel();
    expect(calls).toHaveLength(2);
  });

  it('a warm-up that throws does not affect the session', async () => {
    const format: SegmentFormatter = async (text) => text.toUpperCase();
    format.warm = () => {
      throw new Error('no network');
    };
    const h = harness(format);
    speak(h.session, 1);
    h.session.finish();
    await until(() => h.closed());
    expect(spoken(h.events)[0]!.text).toMatch(/^WORD0 /);
    expect(h.events.at(-1)?.type).toBe('done');
  });

  it('with geminiFormatter the session warms first and then cleans; without format it calls nothing', async () => {
    const { endpoint, seen } = await serve(echo);
    const format = geminiFormatter({ apiKey: 'k', endpoint, warmEveryMs: 0 });

    const events: ServerEvent[] = [];
    let closed = false;
    const plain = new RelaySession({ start, providers: [fakeProvider('gemini', { text: longText })], context, send: (e) => events.push(e), close: () => { closed = true; }, timing });
    speak(plain, 1);
    plain.finish();
    await until(() => closed);
    expect(seen.requests).toHaveLength(0);

    const h = harness(format);
    await until(() => seen.requests.length === 1);
    speak(h.session, 1);
    h.session.finish();
    await until(() => h.closed());
    expect(seen.requests[0]!.method).toBe('GET');
    expect(seen.requests.slice(1).every((r) => r.method === 'POST')).toBe(true);
    expect(seen.requests.length).toBeGreaterThan(1);
    expect(spoken(h.events)[0]!.text).toMatch(/^WORD0 /);
  });
});
