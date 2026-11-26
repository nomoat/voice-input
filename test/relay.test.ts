import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createVoiceRelay, fakeFrame, fakeProvider, FRAME_BYTES, RelaySession, VoiceRefusal, type ServerEvent, type StartMessage, type VoiceUser } from '../src/server/index.js';

const start = (over: Partial<StartMessage> = {}): StartMessage => ({ type: 'start', v: 1, session: 'session-0001', languages: ['zh-CN'], fromMs: 0, nextSeg: 0, ...over });
const context = { userId: 'u1', deviceId: '1000000000000001', languages: ['zh-CN'] };
const silent = (i: number) => fakeFrame(i, 0);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(providers: ReturnType<typeof fakeProvider>[], over: Partial<StartMessage> = {}, timing = { minMs: 1_000, maxMs: 3_000, idleCutMs: 10_000 }) {
  const events: ServerEvent[] = [];
  let closed = false;
  const session = new RelaySession({ start: start(over), providers, context, send: (e) => events.push(e), close: () => { closed = true; }, timing });
  return { session, events, closed: () => closed };
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

const commits = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { type: 'commit' }> => e.type === 'commit').sort((a, b) => a.seg - b.seg);
const words = (events: ServerEvent[]) => commits(events).flatMap((c) => c.text.split(' ').filter(Boolean));

describe('RelaySession', () => {
  it('cuts at pauses, commits contiguous segments and transcribes every voiced frame once', async () => {
    const p = fakeProvider('a');
    const h = harness([p]);
    let i = 0;
    for (let k = 0; k < 3; k++) {
      for (let n = 0; n < 12; n++) h.session.audio(fakeFrame(i++));
      for (let n = 0; n < 4; n++) h.session.audio(silent(i++));
    }
    h.session.finish();
    await until(() => h.closed());
    const c = commits(h.events);
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c[0]!.startMs).toBe(0);
    for (let k = 1; k < c.length; k++) expect(c[k]!.startMs).toBe(c[k - 1]!.endMs);
    expect(c.at(-1)!.endMs).toBe(i * 100);
    const voiced = Array.from({ length: i }, (_, n) => n).filter((n) => n % 16 < 12).map((n) => `f${n}`);
    expect(words(h.events)).toEqual(voiced);
    expect(h.events.at(-1)).toEqual({ type: 'done', nextSeg: c.length });
  });

  it('cuts at the hard limit without a pause', async () => {
    const h = harness([fakeProvider('a')]);
    for (let n = 0; n < 70; n++) h.session.audio(fakeFrame(n));
    h.session.finish();
    await until(() => h.closed());
    const c = commits(h.events);
    expect(c.map((x) => x.endMs - x.startMs)).toEqual([3000, 3000, 1000]);
    expect(words(h.events)).toHaveLength(70);
  });

  it('replays a segment to the next provider after a failure, without losing frames', async () => {
    const bad = fakeProvider('bad', { failAfterBytes: FRAME_BYTES * 5 });
    const good = fakeProvider('good');
    const h = harness([bad, good]);
    for (let n = 0; n < 20; n++) h.session.audio(fakeFrame(n));
    h.session.finish();
    await until(() => h.closed());
    expect(words(h.events)).toEqual(Array.from({ length: 20 }, (_, n) => `f${n}`));
    expect(h.session.stats.failovers).toBeGreaterThan(0);
  });

  it('fails retryably when every provider fails', async () => {
    const h = harness([fakeProvider('a', { failOnStart: true }), fakeProvider('b', { failOnStart: true })]);
    for (let n = 0; n < 5; n++) h.session.audio(fakeFrame(n));
    await until(() => h.closed());
    expect(h.events.at(-1)).toEqual({ type: 'error', code: 'providers_unavailable', retryable: true });
  });

  it('resumes from the stated position and segment number', async () => {
    const h = harness([fakeProvider('a')], { fromMs: 42_000, nextSeg: 7 });
    for (let n = 420; n < 430; n++) h.session.audio(fakeFrame(n));
    h.session.finish();
    await until(() => h.closed());
    expect(commits(h.events)).toEqual([{ type: 'commit', seg: 7, text: words(h.events).join(' '), startMs: 42_000, endMs: 43_000 }]);
    expect(words(h.events)[0]).toBe('f420');
  });

  it('commits a silent segment as empty text without opening a provider', async () => {
    const p = fakeProvider('a');
    const h = harness([p]);
    for (let n = 0; n < 8; n++) h.session.audio(silent(n));
    h.session.finish();
    await until(() => h.closed());
    expect(p.created).toHaveLength(0);
    expect(commits(h.events)).toEqual([{ type: 'commit', seg: 0, text: '', startMs: 0, endMs: 800 }]);
  });

  it('commits the latest text when a provider never sends its final result', async () => {
    const h = harness([fakeProvider('slow', { neverFinish: true }, { finishMs: 50 })]);
    for (let n = 0; n < 5; n++) h.session.audio(fakeFrame(n));
    h.session.finish();
    await until(() => h.closed());
    expect(words(h.events)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  it('holds acknowledgements while too many segments wait for final text', async () => {
    const p = fakeProvider('slow', { finishMs: 300 });
    const events: ServerEvent[] = [];
    const session = new RelaySession({ start: start(), providers: [p], context, send: (e) => events.push(e), close: () => undefined, timing: { minMs: 500, maxMs: 500, idleCutMs: 10_000 }, maxOpenSegments: 2 });
    for (let n = 0; n < 30; n++) session.audio(fakeFrame(n));
    const acked = Math.max(...events.filter((e) => e.type === 'ack').map((e) => (e as { ms: number }).ms));
    expect(acked).toBeLessThan(3000);
    await until(() => events.some((e) => e.type === 'commit'));
    await wait(20);
    session.shutdown();
  });

  it('rejects frames of the wrong size and audio past the limit', () => {
    const h = harness([fakeProvider('a')]);
    h.session.audio(Buffer.alloc(10));
    expect(h.events.at(-1)).toEqual({ type: 'error', code: 'bad_request', retryable: false });
    const events: ServerEvent[] = [];
    const s = new RelaySession({ start: start({ fromMs: 1_210_000 }), providers: [fakeProvider('a')], context, send: (e) => events.push(e), close: () => undefined, maxMs: 1_200_000 });
    s.audio(fakeFrame(0));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'limit', retryable: false });
  });
});

describe('voice relay over WebSocket', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(authenticate: (token?: string) => string | VoiceUser | null, streamsPerUser = 2) {
    const metrics: unknown[] = [];
    const chains: StartMessage[] = [];
    const relay = createVoiceRelay({
      path: '/api/voice/stream',
      secret: 'test',
      authenticate: async (_req, token) => {
        const id = authenticate(token);
        return typeof id === 'string' ? { userId: id } : id;
      },
      providers: (_req, begun) => (chains.push(begun), [fakeProvider('a')]),
      streamsPerUser,
      metric: (m) => metrics.push(m),
    });
    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
    });
    server.listen(0);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    return { url: `ws://127.0.0.1:${port}/api/voice/stream`, metrics, chains };
  }

  async function client(url: string, token?: string) {
    const ws = new WebSocket(url);
    const events: ServerEvent[] = [];
    ws.on('message', (d) => events.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ ...start(), ...(token ? { token } : {}) }));
    return { ws, events };
  }

  it('authenticates with the start token, streams and finishes', async () => {
    const { url, metrics } = await serve((t) => (t === 'good' ? 'u1' : null));
    const { ws, events } = await client(url, 'good');
    await until(() => events.some((e) => e.type === 'ready'));
    for (let n = 0; n < 10; n++) ws.send(fakeFrame(n));
    ws.send(JSON.stringify({ type: 'finish', endMs: 1000 }));
    await once(ws, 'close');
    expect(events.find((e) => e.type === 'commit')).toMatchObject({ seg: 0, startMs: 0, endMs: 1000 });
    expect(events.at(-1)).toEqual({ type: 'done', nextSeg: 1 });
    await until(() => metrics.length === 1);
    expect(JSON.stringify(metrics[0])).not.toContain('f1');
  });

  it('refuses a bad token and a third stream for one user', async () => {
    const { url } = await serve((t) => (t === 'good' ? 'u1' : null), 2);
    const bad = await client(url, 'bad');
    await once(bad.ws, 'close');
    expect(bad.events).toEqual([{ type: 'error', code: 'unauthorized', retryable: false }]);
    const a = await client(url, 'good');
    const b = await client(url, 'good');
    await until(() => a.events.length > 0 && b.events.length > 0);
    const c = await client(url, 'good');
    await once(c.ws, 'close');
    expect(c.events).toEqual([{ type: 'error', code: 'limit', retryable: true }]);
    a.ws.close();
    b.ws.close();
  });

  it('refuses without consent as forbidden, and uses the account languages over the client languages', async () => {
    const { url, chains } = await serve((t) => {
      if (t === 'declined') throw new VoiceRefusal('forbidden');
      return t === 'good' ? { userId: 'u1', languages: ['en-GB', 'fr-FR'] } : null;
    });
    const declined = await client(url, 'declined');
    await once(declined.ws, 'close');
    expect(declined.events).toEqual([{ type: 'error', code: 'forbidden', retryable: false }]);
    const ok = await client(url, 'good');
    await until(() => ok.events.some((e) => e.type === 'ready'));
    expect(chains.at(-1)?.languages).toEqual(['en-GB', 'fr-FR']);
    ok.ws.close();
  });
});
