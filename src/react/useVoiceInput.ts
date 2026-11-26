import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceSession, type CaptureFactory, type VoiceMode, type VoiceState, type VoiceStop } from '../client/session.js';
import { MemoryVoiceStore, type VoiceStore } from '../client/store.js';
import { IndexedDbVoiceStore } from '../client/web/idb-store.js';
import { webCapture } from '../client/web/capture.js';

export interface VoiceTextInfo {
  raw: string;
  tidied: boolean;
  session: string;
  mode: VoiceMode;
  stoppedBy?: VoiceStop;
}

export interface VoiceInputConfig {
  url: string;
  token?: () => Promise<string | undefined> | string | undefined;
  languages: string[];
  target: string;
  surface?: string;
  onText: (text: string, info: VoiceTextInfo) => void | Promise<void>;
  tidy?: (text: string) => Promise<string | null>;
  tidyMinChars?: number;
  store?: VoiceStore;
  capture?: CaptureFactory;
  maxMs?: number;
}

export type VoiceNotice = 'empty' | 'microphone' | 'unauthorized' | 'rejected' | 'limit' | 'silence' | 'pending';

export interface VoiceInputView {
  open: boolean;
  state: VoiceState | null;
  tidying: boolean;
  cancelArmed: boolean;
  notice: VoiceNotice | null;
}

let sharedStore: VoiceStore | undefined;
export function defaultVoiceStore(): VoiceStore {
  sharedStore ??= IndexedDbVoiceStore.available() ? new IndexedDbVoiceStore() : new MemoryVoiceStore();
  return sharedStore;
}

const TIDY_TIMEOUT_MS = 30_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function useVoiceInput(config: VoiceInputConfig) {
  const [view, setView] = useState<VoiceInputView>({ open: false, state: null, tidying: false, cancelArmed: false, notice: null });
  const configRef = useRef(config);
  configRef.current = config;
  const sessionRef = useRef<VoiceSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const patch = useCallback((p: Partial<VoiceInputView>) => setView((v) => ({ ...v, ...p })), []);

  const close = useCallback(() => {
    clearTimeout(noticeTimer.current);
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    sessionRef.current = null;
    setView({ open: false, state: null, tidying: false, cancelArmed: false, notice: null });
  }, []);

  const showNotice = useCallback((notice: VoiceNotice, autoCloseMs?: number) => {
    clearTimeout(noticeTimer.current);
    patch({ notice, tidying: false });
    if (autoCloseMs) noticeTimer.current = setTimeout(close, autoCloseMs);
  }, [close, patch]);

  const deliver = useCallback(async (session: VoiceSession, text: string) => {
    const c = configRef.current;
    let out = text;
    let tidied = false;
    if (c.tidy && text.length >= (c.tidyMinChars ?? 80)) {
      patch({ tidying: true });
      const md = await withTimeout(c.tidy(text), TIDY_TIMEOUT_MS);
      if (sessionRef.current !== session) return;
      if (md && md.trim()) {
        out = md;
        tidied = true;
        await session.saveTidy(md);
      }
    }
    if (sessionRef.current !== session) return;
    const { mode, stoppedBy } = session.state;
    await c.onText(out, { raw: text, tidied, session: session.id, mode, ...(stoppedBy ? { stoppedBy } : {}) });
    await session.markInserted();
  }, [patch]);

  const begin = useCallback((mode: VoiceMode) => {
    if (sessionRef.current) return sessionRef.current;
    const c = configRef.current;
    clearTimeout(noticeTimer.current);
    const session = new VoiceSession({
      url: c.url,
      languages: c.languages,
      target: c.target,
      store: c.store ?? defaultVoiceStore(),
      capture: c.capture ?? webCapture(),
      ...(c.token ? { token: c.token } : {}),
      ...(c.surface ? { surface: c.surface } : {}),
      ...(c.maxMs ? { maxMs: c.maxMs } : {}),
    });
    sessionRef.current = session;
    unsubscribeRef.current = session.subscribe((state) => {
      if (sessionRef.current !== session) return;
      setView((v) => ({ ...v, open: true, state, ...(state.phase === 'pending' ? { notice: 'pending' as const } : v.notice === 'pending' ? { notice: null } : {}) }));
    });
    void session.result.then(async (result) => {
      if (sessionRef.current !== session) return;
      const state = session.state;
      if (!result) {
        if (state.phase === 'failed') showNotice(state.failure === 'microphone' ? 'microphone' : state.failure === 'unauthorized' ? 'unauthorized' : 'rejected');
        else close();
        return;
      }
      if (!result.text) {
        showNotice('empty', 2500);
        return;
      }
      try {
        await deliver(session, result.text);
      } catch {
        showNotice('rejected');
        return;
      }
      if (sessionRef.current !== session) return;
      if (state.stoppedBy && state.stoppedBy !== 'interrupted') showNotice(state.stoppedBy, 4000);
      else close();
    });
    void session.start(mode);
    return session;
  }, [close, deliver, showNotice]);

  const finish = useCallback(() => sessionRef.current?.finish(), []);
  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return close();
    const phase = session.state.phase;
    if (phase === 'done' || phase === 'failed' || phase === 'cancelled') return close();
    if (phase === 'pending') {
      session.detach();
      return close();
    }
    session.cancel();
  }, [close]);
  const setMode = useCallback((mode: VoiceMode) => sessionRef.current?.setMode(mode), []);
  const armCancel = useCallback((armed: boolean) => setView((v) => (v.cancelArmed === armed ? v : { ...v, cancelArmed: armed })), []);

  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
    const session = sessionRef.current;
    sessionRef.current = null;
    unsubscribeRef.current?.();
    session?.detach();
  }, []);

  useEffect(() => {
    const onHide = () => {
      const session = sessionRef.current;
      if (document.visibilityState === 'hidden' && session?.state.mode !== 'handsFree') session?.finish('interrupted');
    };
    const onPageHide = () => {
      const session = sessionRef.current;
      if (session && session.state.phase !== 'done') session.abandon();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  const active = Boolean(view.state && ['starting', 'recording', 'paused'].includes(view.state.phase));
  return { view, active, begin, finish, cancel, setMode, armCancel, close, session: sessionRef };
}
