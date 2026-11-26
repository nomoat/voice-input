import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isHold, move, press, release, TAP_MS } from '../client/gesture.js';
import { LivePanel } from './LivePanel.js';
import { englishVoiceStrings } from './strings.js';
import { useVoiceInput } from './useVoiceInput.js';
export function MicIcon({ size = 16 }) {
    return (_jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }), _jsx("path", { d: "M5 10a7 7 0 0 0 14 0" }), _jsx("path", { d: "M12 17v5" })] }));
}
export function StopIcon({ size = 16 }) {
    return (_jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", children: _jsx("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2.5", fill: "currentColor" }) }));
}
export function useVoiceButton(config, disabled = false) {
    const voice = useVoiceInput(config);
    const track = useRef(null);
    const holdTimer = useRef(undefined);
    const stopTap = useRef(false);
    const keyDown = useRef(false);
    const { view, active } = voice;
    const clearHold = () => clearTimeout(holdTimer.current);
    const down = (x, y) => {
        if (active && voice.session.current?.state.mode === 'handsFree') {
            stopTap.current = true;
            return;
        }
        if (active)
            return;
        stopTap.current = false;
        track.current = press(performance.now(), x, y);
        voice.begin('undecided');
        clearHold();
        holdTimer.current = setTimeout(() => {
            if (track.current)
                voice.setMode('hold');
        }, TAP_MS);
    };
    const up = () => {
        clearHold();
        if (stopTap.current) {
            stopTap.current = false;
            voice.finish();
            return;
        }
        const t = track.current;
        track.current = null;
        if (!t)
            return;
        voice.armCancel(false);
        const outcome = release(t, performance.now());
        if (outcome === 'handsFree')
            voice.setMode('handsFree');
        else if (outcome === 'cancel')
            voice.cancel();
        else
            voice.finish();
    };
    const handlers = {
        onPointerDown: (e) => {
            if (disabled || e.button !== 0)
                return;
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            down(e.clientX, e.clientY);
        },
        onPointerMove: (e) => {
            const t = track.current;
            if (!t)
                return;
            const next = move(t, e.clientX, e.clientY);
            track.current = next;
            if (isHold(next, performance.now()))
                voice.setMode('hold');
            voice.armCancel(next.cancelArmed);
        },
        onPointerUp: up,
        onPointerCancel: () => {
            clearHold();
            if (!track.current)
                return;
            track.current = null;
            voice.armCancel(false);
            voice.finish();
        },
        onKeyDown: (e) => {
            if (disabled || e.repeat) {
                if (e.key === ' ' || e.key === 'Enter')
                    e.preventDefault();
                return;
            }
            if (e.key === ' ') {
                e.preventDefault();
                keyDown.current = true;
                down(0, 0);
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (active)
                    voice.finish();
                else
                    voice.begin('handsFree');
            }
        },
        onKeyUp: (e) => {
            if (e.key === ' ' && keyDown.current) {
                e.preventDefault();
                keyDown.current = false;
                up();
            }
        },
        onContextMenu: (e) => e.preventDefault(),
    };
    useEffect(() => {
        if (!view.open)
            return;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                voice.cancel();
            }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                voice.finish();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [view.open, voice]);
    useEffect(() => clearHold, []);
    return { voice, view, active, handlers };
}
export function VoicePanelPortal({ voice, strings, anchor, Button }) {
    if (!voice.view.open || typeof document === 'undefined')
        return null;
    return createPortal(_jsx(LivePanel, { view: voice.view, strings: strings, anchor: anchor, onDone: voice.finish, onCancel: voice.cancel, onClose: voice.close, ...(Button ? { Button } : {}) }), document.body);
}
export function VoiceButton({ config, strings = englishVoiceStrings, anchor, className, activeClassName, style, disabled, icon, stopIcon, size = 16 }) {
    const { voice, active, handlers } = useVoiceButton(config, disabled);
    const buttonRef = useRef(null);
    return (_jsxs(_Fragment, { children: [_jsx("button", { ref: buttonRef, type: "button", "aria-label": active ? strings.stop : strings.voiceInput, "aria-pressed": active, title: active ? strings.stop : strings.buttonHint, disabled: disabled, "data-voice-button": "", "data-active": active ? 'true' : undefined, className: [className, active ? activeClassName : undefined].filter(Boolean).join(' ') || undefined, style: { touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', ...style }, ...handlers, children: active ? (stopIcon ?? _jsx(StopIcon, { size: size })) : (icon ?? _jsx(MicIcon, { size: size })) }), _jsx(VoicePanelPortal, { voice: voice, strings: strings, anchor: anchor ?? buttonRef })] }));
}
