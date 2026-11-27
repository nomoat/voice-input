import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createVoiceRelay, fakeFrame, fakeProvider, type VoiceRelay } from '../src/server/index.js';
import { MemoryVoiceStore, VoiceSession, listDictations, summarize, type CaptureSink, type JournalRecord, type SocketLike, type VoiceSessionOptions } from '../src/client/index.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

const samples = (index: number, amplitude = 8000) => {
  const b = fakeFrame(index, amplitude);
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
const expected = (n: number, from = 0) => Array.from({ length: n - from }, (_, i) => `f${from + i}`).join(' ');

interface Rig {
  url: string;
  relay: VoiceRelay;
  sockets: Set<Duplex>;
  server: Server;
  refuse: boolean;
}

let rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs) {
    r.relay.close();
    for (const s of r.sockets) s.destroy();
    r.server.close();
  }
  rigs = [];
});

async function rig(): Promise<Rig> {
  const relay = createVoiceRelay({
    path: '/v',
    secret: 's',
    authenticate: async (_r, token) => (token === 't' ? { userId: 'u' } : null),
    providers: () => [fakeProvider('a')],
    timing: { minMs: 1000, maxMs: 2000, idleCutMs: 10_000 },
    streamsPerUser: 10,
  });
  const server = createServer();
  const r: Rig = { url: '', relay, sockets: new Set(), server, refuse: false };
  server.on('upgrade', (req, socket, head) => {
    if (r.refuse) {
      socket.destroy();
      return;
    }
    r.sockets.add(socket);
    socket.on('close', () => r.sockets.delete(socket));
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0);
  await once(server, 'listening');
  r.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v`;
  rigs.push(r);
  return r;
}

function mic() {
  const m: { sink?: CaptureSink; stopped: boolean } = { stopped: false };
  const factory = async (sink: CaptureSink) => {
    m.sink = sink;
    return { stop: () => { m.stopped = true; } };
  };
  return { m, factory };
}

function session(r: Rig, store: MemoryVoiceStore, over: Partial<VoiceSessionOptions> = {}) {
  return new VoiceSession({
    url: r.url,
    token: () => 't',
    languages: ['zh-CN'],
    target: 'doc-1',
    store,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    ...over,
  });
}

describe('VoiceSession', () => {
  it('records, streams, commits and finishes with every frame once', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('handsFree');
    await until(() => s.state.connection === 'online');
    for (let i = 0; i < 45; i++) m.sink!.samples(samples(i));
    await until(() => s.state.committed.length > 0);
    s.finish();
    const result = await s.result;
    expect(m.stopped).toBe(true);
    expect(result?.text).toBe(expected(45));
    await s.markInserted();
    const summary = summarize(store.journals.get(s.id)!)!;
    expect(summary.completedAt).toBeDefined();
    expect(summary.insertedAt).toBeDefined();
    expect(store.frames.get(s.id)?.size ?? 0).toBe(0);
  });

  it('keeps recording through a network drop and catches up after reconnecting', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('handsFree');
    await until(() => s.state.connection === 'online');
    for (let i = 0; i < 25; i++) m.sink!.samples(samples(i));
    await until(() => s.state.committed.length > 0);
    r.refuse = true;
    for (const sock of r.sockets) sock.destroy();
    await until(() => s.state.connection === 'offline');
    for (let i = 25; i < 50; i++) m.sink!.samples(samples(i));
    expect(s.state.phase).toBe('recording');
    r.refuse = false;
    await until(() => s.state.connection === 'online', 8000);
    for (let i = 50; i < 60; i++) m.sink!.samples(samples(i));
    s.finish();
    const result = await s.result;
    expect(result?.text).toBe(expected(60));
  });

  it('finishes offline as pending, then completes when the server is back', async () => {
    const r = await rig();
    r.refuse = true;
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('hold');
    for (let i = 0; i < 12; i++) m.sink!.samples(samples(i));
    s.finish();
    await until(() => s.state.phase === 'pending');
    r.refuse = false;
    const result = await s.result;
    expect(result?.text).toBe(expected(12));
  });

  it('restores an abandoned session from the journal and spool', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('handsFree');
    await until(() => s.state.connection === 'online');
    for (let i = 0; i < 25; i++) m.sink!.samples(samples(i));
    await until(() => s.state.committed.length > 0);
    r.refuse = true;
    for (const sock of r.sockets) sock.destroy();
    for (let i = 25; i < 33; i++) m.sink!.samples(samples(i));
    s.abandon();
    await s.flushed();
    r.refuse = false;
    const pending = await listDictations(store, { target: 'doc-1' });
    expect(pending.map((d) => d.status)).toEqual(['unfinished']);
    const restored = await VoiceSession.restore(s.id, { url: r.url, token: () => 't', store, socket: (url) => new WebSocket(url) as unknown as SocketLike });
    const result = await restored!.result;
    expect(result?.text.startsWith(expected(20))).toBe(true);
    expect(result?.text.split(' ').length).toBeGreaterThanOrEqual(30);
    expect(new Set(result?.text.split(' ')).size).toBe(result?.text.split(' ').length);
  });

  it('stops at the length limit and keeps the text', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory, maxMs: 1500 });
    await s.start('handsFree');
    for (let i = 0; i < 30; i++) m.sink!.samples(samples(i));
    expect(s.state.stoppedBy).toBe('limit');
    const result = await s.result;
    expect(result?.text).toBe(expected(15));
  });

  it('finishes a hands-free session after long silence', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory, silenceFinishMs: 500 });
    await s.start('handsFree');
    for (let i = 0; i < 3; i++) m.sink!.samples(samples(i));
    for (let i = 3; i < 20; i++) m.sink!.samples(samples(i, 0));
    expect(s.state.stoppedBy).toBe('silence');
    expect((await s.result)?.text).toBe(expected(3));
  });

  it('cancel discards locally and keeps the record for a day', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('hold');
    for (let i = 0; i < 5; i++) m.sink!.samples(samples(i));
    s.cancel();
    expect(await s.result).toBeNull();
    await s.flushed();
    const list = await listDictations(store);
    expect(list[0]?.status).toBe('discarded');
    expect(store.frames.get(s.id)?.size ?? 0).toBe(0);
  });

  it('reports a microphone failure and leaves nothing behind', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const s = session(r, store, { capture: async () => { throw new Error('denied'); } });
    await s.start('hold');
    expect(s.state).toMatchObject({ phase: 'failed', failure: 'microphone' });
    await s.flushed();
    expect(await store.sessions()).toEqual([]);
  });

  it('a silent dictation that finishes with no text leaves nothing to recover', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    const { m, factory } = mic();
    const s = session(r, store, { capture: factory });
    await s.start('hold');
    await until(() => s.state.connection === 'online');
    for (let i = 0; i < 45; i++) m.sink!.samples(samples(i, 0));
    s.finish();
    expect((await s.result)?.text).toBe('');
    await s.flushed();
    expect(await store.sessions()).toEqual([]);
    expect(await listDictations(store)).toEqual([]);
  });

  it('a release before the microphone starts ends with empty text', async () => {
    const r = await rig();
    const store = new MemoryVoiceStore();
    let resolveCapture!: (c: { stop: () => void }) => void;
    let stopped = false;
    const s = session(r, store, { capture: () => new Promise((res) => { resolveCapture = res; }) });
    const started = s.start('hold');
    s.finish();
    resolveCapture({ stop: () => { stopped = true; } });
    await started;
    expect((await s.result)?.text).toBe('');
    expect(stopped).toBe(true);
  });
});

describe('recovery list', () => {
  const start = (session: string): JournalRecord => ({ t: 'start', session, target: 'doc-1', languages: ['zh-CN'], at: 1_000 });
  const audio = (n: number) => Array.from({ length: n }, (_, i) => new Uint8Array(640).fill(i % 256));
  const seed = async (store: MemoryVoiceStore, session: string, records: JournalRecord[], frames = 0) => {
    for (const r of [start(session), ...records]) await store.append(session, r);
    if (frames) await store.putFrames(session, 0, audio(frames));
  };

  it('drops a finished dictation with no text (old journals too) and its audio', async () => {
    const store = new MemoryVoiceStore();
    await seed(store, 'silent', [{ t: 'commit', seg: 0, text: '', startMs: 0, endMs: 3000 }, { t: 'finish', endMs: 3000, at: 2_000 }, { t: 'complete', at: 3_000 }], 150);
    await seed(store, 'nothing', [{ t: 'finish', endMs: 1200, at: 2_000 }, { t: 'complete', at: 3_000 }], 60);
    expect(await listDictations(store, { now: 10_000 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
    expect(store.frames.size).toBe(0);
  });

  it('drops a finished dictation whose text is only blank', async () => {
    const store = new MemoryVoiceStore();
    await seed(store, 'blank', [{ t: 'commit', seg: 0, text: '  ', startMs: 0, endMs: 2000 }, { t: 'commit', seg: 1, text: '\n', startMs: 2000, endMs: 4000 }, { t: 'finish', endMs: 4000, at: 2_000 }, { t: 'complete', at: 3_000 }]);
    expect(await listDictations(store, { now: 10_000 })).toEqual([]);
    expect(await store.sessions()).toEqual([]);
  });

  it('still offers a finished dictation with text that was never inserted', async () => {
    const store = new MemoryVoiceStore();
    await seed(store, 'kept', [{ t: 'commit', seg: 0, text: '做一个短片', startMs: 0, endMs: 3000 }, { t: 'finish', endMs: 3000, at: 2_000 }, { t: 'complete', at: 3_000 }]);
    const list = await listDictations(store, { now: 10_000 });
    expect(list).toMatchObject([{ session: 'kept', status: 'complete', text: '做一个短片', durationMs: 3000 }]);
  });

  it('still offers an unfinished dictation with text, and one with audio but no text yet', async () => {
    const store = new MemoryVoiceStore();
    await seed(store, 'words', [{ t: 'commit', seg: 0, text: '做一个短片', startMs: 0, endMs: 3000 }], 200);
    await seed(store, 'audio', [], 100);
    const list = await listDictations(store, { now: 10_000 });
    expect(list.map((d) => [d.session, d.status, d.text]).sort()).toEqual([['audio', 'unfinished', ''], ['words', 'unfinished', '做一个短片']]);
    expect(list.find((d) => d.session === 'audio')!.durationMs).toBeGreaterThan(0);
  });

  it('keeps inserted and discarded records with no text until they expire', async () => {
    const store = new MemoryVoiceStore();
    await seed(store, 'inserted', [{ t: 'finish', endMs: 1200, at: 2_000 }, { t: 'complete', at: 3_000 }, { t: 'inserted', at: 4_000 }]);
    await seed(store, 'discarded', [{ t: 'discarded', at: 4_000 }]);
    const list = await listDictations(store, { now: 10_000 });
    expect(list.map((d) => d.status).sort()).toEqual(['discarded', 'inserted']);
  });
});
