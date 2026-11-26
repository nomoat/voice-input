import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { VoiceSession } from '../client/session.js';
import { listDictations, markDiscarded, markInserted } from '../client/recovery.js';
import { englishVoiceStrings } from './strings.js';
import { defaultVoiceStore } from './useVoiceInput.js';
export function useVoiceRecovery(target, store = defaultVoiceStore()) {
    const [items, setItems] = useState([]);
    const refresh = useCallback(async () => {
        try {
            const all = await listDictations(store, { target });
            setItems(all.filter((d) => (d.status === 'unfinished' || d.status === 'complete') && (d.text || d.durationMs > 0)));
        }
        catch {
            setItems([]);
        }
    }, [store, target]);
    useEffect(() => {
        void refresh();
        const onFocus = () => void refresh();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);
    return { items, refresh };
}
const minutes = (ms) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} min`;
};
export function VoiceRecovery({ target, url, token, store = defaultVoiceStore(), strings = englishVoiceStrings, onText, className, Button }) {
    const { items, refresh } = useVoiceRecovery(target, store);
    const [busy, setBusy] = useState(null);
    const item = items[0];
    if (!item)
        return null;
    const restore = async () => {
        setBusy(item.session);
        try {
            let text = item.tidy ?? item.text;
            if (item.status === 'unfinished') {
                const session = await VoiceSession.restore(item.session, { url, store, ...(token ? { token } : {}) });
                const result = await session?.result;
                if (!result)
                    return;
                text = result.text;
            }
            if (text)
                await onText(text, { raw: item.text || text, tidied: Boolean(item.tidy), session: item.session, mode: 'restore' });
            await markInserted(store, item.session);
        }
        finally {
            setBusy(null);
            void refresh();
        }
    };
    const discard = async () => {
        await markDiscarded(store, item.session);
        void refresh();
    };
    const action = (label, onClick, primary) => Button ? _jsx(Button, { onClick: onClick, primary: primary, disabled: busy !== null, children: label }) : _jsx("button", { type: "button", disabled: busy !== null, onClick: onClick, children: label });
    const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text;
    return (_jsxs("div", { role: "status", "data-voice-recovery": "", className: className, style: className ? undefined : { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid var(--voice-border, rgba(127,127,127,0.28))', borderRadius: 12, fontSize: 13 }, children: [_jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsx("strong", { style: { fontWeight: 600 }, children: strings.unfinished(minutes(item.durationMs)) }), preview ? _jsx("span", { style: { display: 'block', color: 'var(--voice-muted, GrayText)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: preview }) : null] }), action(busy ? strings.finishing : item.status === 'complete' ? strings.insert : strings.restore, () => void restore(), true), action(strings.discard, () => void discard(), false)] }));
}
