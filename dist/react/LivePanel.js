import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clock } from './strings.js';
const color = {
    bg: 'var(--voice-bg, Canvas)',
    fg: 'var(--voice-fg, CanvasText)',
    muted: 'var(--voice-muted, GrayText)',
    border: 'var(--voice-border, rgba(127,127,127,0.28))',
    accent: 'var(--voice-accent, #e5484d)',
    danger: 'var(--voice-danger, #e5484d)',
};
function usePlacement(anchor, open) {
    const [style, setStyle] = useState({ display: 'none' });
    useLayoutEffect(() => {
        if (!open)
            return;
        const place = () => {
            const el = anchor.current;
            if (!el)
                return;
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const width = Math.min(vw - 16, Math.max(280, Math.min(rect.width, 560)));
            const left = Math.max(8, Math.min(rect.left + (rect.width - width) / 2, vw - width - 8));
            const bottom = Math.max(8, window.innerHeight - rect.top + 8);
            const roomAbove = rect.top - 16;
            const maxHeight = Math.max(120, Math.min(roomAbove, vw < 640 ? window.innerHeight * 0.4 : 320));
            setStyle({ position: 'fixed', left, width, bottom, maxHeight });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        window.visualViewport?.addEventListener('resize', place);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
            window.visualViewport?.removeEventListener('resize', place);
        };
    }, [anchor, open]);
    return style;
}
function Level({ level, live }) {
    const bars = [0.55, 0.85, 1, 0.7, 0.45];
    return (_jsx("span", { "aria-hidden": "true", style: { display: 'inline-flex', alignItems: 'center', gap: 2, height: 14 }, children: bars.map((k, i) => (_jsx("span", { style: { width: 3, borderRadius: 2, background: live ? color.accent : color.muted, height: `${Math.max(3, Math.round(14 * Math.min(1, level * 1.4) * k))}px`, transition: 'height 90ms linear' } }, i))) }));
}
export function LivePanel({ view, strings, anchor, onDone, onCancel, onClose, Button }) {
    const placement = usePlacement(anchor, view.open);
    const scroller = useRef(null);
    const [follow, setFollow] = useState(true);
    const state = view.state;
    const committed = state?.committed ?? '';
    const interim = state?.interim ?? '';
    useEffect(() => {
        const el = scroller.current;
        if (el && follow)
            el.scrollTop = el.scrollHeight;
    }, [committed, interim, follow]);
    if (!view.open || !state)
        return null;
    const phase = state.phase;
    const recording = phase === 'recording' || phase === 'starting';
    const hold = state.mode === 'hold';
    const handsFree = state.mode === 'handsFree';
    const cancelArmed = view.cancelArmed && hold;
    let status = strings.listening;
    if (view.tidying)
        status = strings.tidying;
    else if (phase === 'paused')
        status = strings.paused;
    else if (phase === 'finishing' || phase === 'done')
        status = strings.finishing;
    else if (phase === 'pending')
        status = strings.savedOffline;
    else if (state.connection === 'offline')
        status = strings.offline;
    else if (state.connection === 'connecting')
        status = strings.connecting;
    else if (handsFree && state.silenceMs >= 60_000)
        status = strings.stillListening;
    const notice = view.notice && view.notice !== 'pending'
        ? {
            empty: strings.emptyResult,
            microphone: strings.microphoneDenied,
            unauthorized: strings.signInAgain,
            rejected: strings.rejected,
            limit: strings.stoppedAtLimit,
            silence: strings.stoppedBySilence,
        }[view.notice]
        : null;
    const button = (primary) => ({
        appearance: 'none', border: `1px solid ${primary ? 'transparent' : color.border}`, borderRadius: 999,
        padding: '6px 14px', font: 'inherit', fontSize: 13, cursor: 'pointer',
        background: primary ? color.fg : 'transparent', color: primary ? color.bg : color.fg,
    });
    const action = (label, onClick, primary) => Button ? _jsx(Button, { onClick: onClick, primary: primary, children: label }) : _jsx("button", { type: "button", onClick: onClick, style: button(primary), children: label });
    return (_jsxs("div", { role: "region", "aria-label": strings.voiceInput, "data-voice-panel": "", "data-phase": phase, style: {
            ...placement, zIndex: 2147483000, display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
            background: cancelArmed ? color.danger : color.bg, color: cancelArmed ? '#fff' : color.fg,
            border: `1px solid ${color.border}`, borderRadius: 'var(--voice-radius, 16px)',
            boxShadow: 'var(--voice-shadow, 0 12px 32px rgba(0,0,0,0.18))', overflow: 'hidden',
            font: 'var(--voice-font, inherit)', transition: 'background 120ms',
        }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 4px', fontSize: 12, color: cancelArmed ? '#fff' : color.muted }, children: [_jsx(Level, { level: state.level, live: recording && !cancelArmed }), _jsx("span", { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: cancelArmed ? strings.releaseToCancel : status }), state.remainingMs <= 60_000 && recording ? _jsx("span", { children: strings.minuteLeft }) : null, _jsx("span", { style: { fontVariantNumeric: 'tabular-nums' }, children: clock(state.elapsedMs) })] }), _jsxs("div", { ref: scroller, "data-voice-text": "", onScroll: (e) => {
                    const el = e.currentTarget;
                    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
                }, style: { position: 'relative', flex: '1 1 auto', minHeight: 44, overflowY: 'auto', padding: '4px 14px 10px', fontSize: 16, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, children: [committed || interim ? (_jsxs(_Fragment, { children: [_jsx("span", { children: committed }), _jsx("span", { style: { color: cancelArmed ? 'rgba(255,255,255,0.75)' : color.muted }, children: interim })] })) : (_jsx("span", { style: { color: cancelArmed ? 'rgba(255,255,255,0.75)' : color.muted }, children: notice ?? '…' })), notice && (committed || interim) ? _jsx("div", { style: { marginTop: 6, fontSize: 13, color: color.muted }, children: notice }) : null] }), !follow ? (_jsxs("button", { type: "button", onClick: () => setFollow(true), style: { ...button(false), position: 'absolute', right: 12, bottom: 56, background: color.bg, fontSize: 12 }, children: [strings.latest, " \u2193"] })) : null, _jsx("span", { "aria-live": "polite", style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }, children: committed.slice(-200) }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 10px 14px', borderTop: `1px solid ${cancelArmed ? 'transparent' : color.border}`, fontSize: 12, color: cancelArmed ? '#fff' : color.muted }, children: [recording && hold ? _jsx("span", { style: { flex: 1 }, children: cancelArmed ? strings.releaseToCancel : strings.holdHint }) : null, (recording || phase === 'paused') && !hold ? (_jsxs(_Fragment, { children: [_jsx("span", { style: { flex: 1 }, children: state.mode === 'undecided' ? '' : strings.tapHint }), action(strings.cancel, onCancel, false), action(strings.done, onDone, true)] })) : null, !recording && phase !== 'paused' ? (_jsxs(_Fragment, { children: [_jsx("span", { style: { flex: 1 } }), action(strings.close, phase === 'pending' || notice ? onClose : onCancel, false)] })) : null] })] }));
}
