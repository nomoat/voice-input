import { useCallback, useEffect, useState } from 'react';
import { VoiceSession } from '../client/session.js';
import { listDictations, markDiscarded, markInserted, type StoredDictation } from '../client/recovery.js';
import type { VoiceStore } from '../client/store.js';
import { englishVoiceStrings, type VoiceStrings } from './strings.js';
import { defaultVoiceStore, type VoiceTextInfo } from './useVoiceInput.js';

export interface VoiceRecoveryProps {
  target: string;
  url: string;
  token?: () => Promise<string | undefined> | string | undefined;
  store?: VoiceStore;
  strings?: VoiceStrings;
  onText: (text: string, info: VoiceTextInfo) => void | Promise<void>;
  className?: string;
}

export function useVoiceRecovery(target: string, store: VoiceStore = defaultVoiceStore()) {
  const [items, setItems] = useState<StoredDictation[]>([]);
  const refresh = useCallback(async () => {
    try {
      const all = await listDictations(store, { target });
      setItems(all.filter((d) => (d.status === 'unfinished' || d.status === 'complete') && (d.text || d.durationMs > 0)));
    } catch {
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

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} min`;
};

export function VoiceRecovery({ target, url, token, store = defaultVoiceStore(), strings = englishVoiceStrings, onText, className }: VoiceRecoveryProps) {
  const { items, refresh } = useVoiceRecovery(target, store);
  const [busy, setBusy] = useState<string | null>(null);
  const item = items[0];
  if (!item) return null;

  const restore = async () => {
    setBusy(item.session);
    try {
      let text = item.tidy ?? item.text;
      if (item.status === 'unfinished') {
        const session = await VoiceSession.restore(item.session, { url, store, ...(token ? { token } : {}) });
        const result = await session?.result;
        if (!result) return;
        text = result.text;
      }
      if (text) await onText(text, { raw: item.text || text, tidied: Boolean(item.tidy), session: item.session });
      await markInserted(store, item.session);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const discard = async () => {
    await markDiscarded(store, item.session);
    void refresh();
  };

  const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text;
  return (
    <div role="status" data-voice-recovery="" className={className} style={className ? undefined : { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid var(--voice-border, rgba(127,127,127,0.28))', borderRadius: 12, fontSize: 13 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ fontWeight: 600 }}>{strings.unfinished(minutes(item.durationMs))}</strong>
        {preview ? <span style={{ display: 'block', color: 'var(--voice-muted, GrayText)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span> : null}
      </span>
      <button type="button" disabled={busy !== null} onClick={() => void restore()}>{busy ? strings.finishing : item.status === 'complete' ? strings.insert : strings.restore}</button>
      <button type="button" disabled={busy !== null} onClick={() => void discard()}>{strings.discard}</button>
    </div>
  );
}
