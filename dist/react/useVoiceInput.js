import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceSession } from '../client/session.js';
import { MemoryVoiceStore } from '../client/store.js';
import { IndexedDbVoiceStore } from '../client/web/idb-store.js';
import { webCapture } from '../client/web/capture.js';
let sharedStore;
export function defaultVoiceStore() {
    sharedStore ??= IndexedDbVoiceStore.available() ? new IndexedDbVoiceStore() : new MemoryVoiceStore();
    return sharedStore;
}
const TIDY_TIMEOUT_MS = 30_000;
export function withTimeout(promise, ms) {
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
export function useVoiceInput(config) {
    const [view, setView] = useState({ open: false, state: null, tidying: false, cancelArmed: false, notice: null });
    const configRef = useRef(config);
    configRef.current = config;
    const sessionRef = useRef(null);
    const unsubscribeRef = useRef(null);
    const noticeTimer = useRef(undefined);
    const patch = useCallback((p) => setView((v) => ({ ...v, ...p })), []);
    const close = useCallback(() => {
        clearTimeout(noticeTimer.current);
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        sessionRef.current = null;
        setView({ open: false, state: null, tidying: false, cancelArmed: false, notice: null });
    }, []);
    const showNotice = useCallback((notice, autoCloseMs) => {
        clearTimeout(noticeTimer.current);
        patch({ notice, tidying: false });
        if (autoCloseMs)
            noticeTimer.current = setTimeout(close, autoCloseMs);
    }, [close, patch]);
    const deliver = useCallback(async (session, text) => {
        const c = configRef.current;
        let out = text;
        let tidied = false;
        if (c.tidy && text.length >= (c.tidyMinChars ?? 80)) {
            patch({ tidying: true });
            const md = await withTimeout(c.tidy(text), TIDY_TIMEOUT_MS);
            if (sessionRef.current !== session)
                return;
            if (md && md.trim()) {
                out = md;
                tidied = true;
                await session.saveTidy(md);
            }
        }
        if (sessionRef.current !== session)
            return;
        await c.onText(out, { raw: text, tidied, session: session.id });
        await session.markInserted();
    }, [patch]);
    const begin = useCallback((mode) => {
        if (sessionRef.current)
            return sessionRef.current;
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
            if (sessionRef.current !== session)
                return;
            setView((v) => ({ ...v, open: true, state, ...(state.phase === 'pending' ? { notice: 'pending' } : v.notice === 'pending' ? { notice: null } : {}) }));
        });
        void session.result.then(async (result) => {
            if (sessionRef.current !== session)
                return;
            const state = session.state;
            if (!result) {
                if (state.phase === 'failed')
                    showNotice(state.failure === 'microphone' ? 'microphone' : state.failure === 'unauthorized' ? 'unauthorized' : 'rejected');
                else
                    close();
                return;
            }
            if (!result.text) {
                showNotice('empty', 2500);
                return;
            }
            try {
                await deliver(session, result.text);
            }
            catch {
                showNotice('rejected');
                return;
            }
            if (sessionRef.current !== session)
                return;
            if (state.stoppedBy)
                showNotice(state.stoppedBy, 4000);
            else
                close();
        });
        void session.start(mode);
        return session;
    }, [close, deliver, showNotice]);
    const finish = useCallback(() => sessionRef.current?.finish(), []);
    const cancel = useCallback(() => {
        const session = sessionRef.current;
        if (!session)
            return close();
        const phase = session.state.phase;
        if (phase === 'done' || phase === 'failed' || phase === 'cancelled')
            return close();
        if (phase === 'pending') {
            session.detach();
            return close();
        }
        session.cancel();
    }, [close]);
    const setMode = useCallback((mode) => sessionRef.current?.setMode(mode), []);
    const armCancel = useCallback((armed) => setView((v) => (v.cancelArmed === armed ? v : { ...v, cancelArmed: armed })), []);
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
            if (document.visibilityState === 'hidden' && session?.state.mode !== 'handsFree')
                session?.finish();
        };
        const onPageHide = () => {
            const session = sessionRef.current;
            if (session && session.state.phase !== 'done')
                session.abandon();
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
