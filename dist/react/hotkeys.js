import { jsx as _jsx } from "react/jsx-runtime";
import { Fragment, useEffect, useRef, useState } from 'react';
const EDITABLE = [
    'input', 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', '[role="spinbutton"]', '[role="slider"]', '[role="listbox"]',
    '[role="option"]', '[role="menu"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="tab"]', '[role="grid"]', '[role="tree"]',
].join(', ');
const CONTROL = 'button, a[href], summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
export function focusTakesKeys(element) {
    if (!element || element === element.ownerDocument.body || element === element.ownerDocument.documentElement)
        return false;
    if (element.closest(EDITABLE))
        return true;
    if (!element.matches(CONTROL))
        return false;
    try {
        return element.matches(':focus-visible');
    }
    catch {
        return true;
    }
}
function blockedByDialog(scope) {
    const dialogs = document.querySelectorAll('[aria-modal="true"], dialog[open]');
    for (const dialog of dialogs) {
        if (!scope || !dialog.contains(scope))
            return true;
    }
    return false;
}
const owners = [];
const isSpace = (e) => e.code === 'Space' || e.key === ' ';
export function useVoiceHotkeys(options) {
    const latest = useRef(options);
    latest.current = options;
    const { enabled } = options;
    useEffect(() => {
        if (!enabled || typeof window === 'undefined')
            return;
        const id = Symbol('voice-hotkeys');
        owners.push(id);
        let held = false;
        const mine = () => owners[owners.length - 1] === id;
        const free = (e) => {
            if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey)
                return false;
            if (focusTakesKeys(document.activeElement))
                return false;
            const scope = latest.current.scope?.current;
            if (scope && (!scope.isConnected || scope.getClientRects().length === 0))
                return false;
            return !blockedByDialog(scope);
        };
        const onKeyDown = (e) => {
            if (!mine())
                return;
            if (isSpace(e)) {
                if (held) {
                    e.preventDefault();
                    return;
                }
                if (e.shiftKey || e.repeat || !free(e))
                    return;
                e.preventDefault();
                held = true;
                latest.current.press();
            }
            else if (e.key === '/' && latest.current.focus && !held && free(e)) {
                e.preventDefault();
                latest.current.focus();
            }
        };
        const onKeyUp = (e) => {
            if (!held || !isSpace(e))
                return;
            e.preventDefault();
            held = false;
            latest.current.release();
        };
        const onBlur = () => {
            if (!held)
                return;
            held = false;
            (latest.current.interrupt ?? latest.current.release)();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        return () => {
            const at = owners.indexOf(id);
            if (at >= 0)
                owners.splice(at, 1);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
            if (held)
                (latest.current.interrupt ?? latest.current.release)();
        };
    }, [enabled]);
}
const KEYBOARD_QUERY = '(hover: hover) and (pointer: fine)';
export function useKeyboardDevice() {
    const [keyboard, setKeyboard] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(KEYBOARD_QUERY).matches);
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
            return;
        const query = window.matchMedia(KEYBOARD_QUERY);
        const update = () => setKeyboard(query.matches);
        update();
        query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
    }, []);
    return keyboard;
}
export function voiceKeyHintText(strings) {
    return strings.keyHint.replace('{space}', strings.spaceKey).replace('{slash}', '/');
}
const defaultKeyStyle = {
    display: 'inline-block',
    padding: '0 0.4em',
    margin: '0 0.15em',
    borderRadius: '0.35em',
    border: '1px solid currentColor',
    fontFamily: 'inherit',
    fontSize: '0.85em',
    lineHeight: 1.5,
    opacity: 0.8,
};
export function VoiceKeyHint({ strings, className, keyClassName, style, keyStyle }) {
    const parts = strings.keyHint.split(/(\{space\}|\{slash\})/);
    return (_jsx("span", { className: className, style: style, "aria-hidden": "true", "data-voice-key-hint": "", children: parts.map((part, i) => {
            if (part === '{space}' || part === '{slash}') {
                return (_jsx("kbd", { className: keyClassName, style: keyClassName ? keyStyle : { ...defaultKeyStyle, ...keyStyle }, children: part === '{space}' ? strings.spaceKey : '/' }, i));
            }
            return _jsx(Fragment, { children: part }, i);
        }) }));
}
