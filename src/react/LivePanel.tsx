import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react';
import type { VoiceInputView } from './useVoiceInput.js';
import { clock, type VoiceStrings } from './strings.js';

export interface LivePanelProps {
  view: VoiceInputView;
  strings: VoiceStrings;
  anchor: RefObject<HTMLElement | null>;
  onDone: () => void;
  onCancel: () => void;
  onClose: () => void;
  Button?: (props: { onClick: () => void; primary: boolean; children: string }) => ReactElement;
}

const color = {
  bg: 'var(--voice-bg, Canvas)',
  fg: 'var(--voice-fg, CanvasText)',
  muted: 'var(--voice-muted, GrayText)',
  border: 'var(--voice-border, rgba(127,127,127,0.28))',
  accent: 'var(--voice-accent, #e5484d)',
  danger: 'var(--voice-danger, #e5484d)',
};

interface Box {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

function anchorBox(el: HTMLElement): Box | null {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const child of Array.from(el.children)) {
    const r = child.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return top === Infinity ? null : { top, bottom, left, width: right - left };
}

const MIN_PANEL = 120;

function usePlacement(anchor: RefObject<HTMLElement | null>, open: boolean): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ display: 'none' });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cap = vw < 640 ? vh * 0.4 : 320;
      const box = anchorBox(el);
      const visible = box && box.bottom > 0 && box.top < vh;
      if (!box || !visible) {
        const width = Math.min(vw - 16, 560);
        setStyle({ position: 'fixed', left: (vw - width) / 2, width, bottom: 16, maxHeight: Math.max(MIN_PANEL, Math.min(cap, vh - 32)) });
        return;
      }
      const width = Math.min(vw - 16, Math.max(280, Math.min(box.width, 560)));
      const left = Math.max(8, Math.min(box.left + (box.width - width) / 2, vw - width - 8));
      const roomAbove = box.top - 16;
      const roomBelow = vh - box.bottom - 16;
      if (roomAbove < MIN_PANEL && roomBelow > roomAbove) {
        setStyle({ position: 'fixed', left, width, top: Math.max(8, box.bottom + 8), maxHeight: Math.max(MIN_PANEL, Math.min(roomBelow, cap)) });
        return;
      }
      const bottom = Math.max(8, vh - box.top + 8);
      setStyle({ position: 'fixed', left, width, bottom, maxHeight: Math.max(MIN_PANEL, Math.min(roomAbove, cap)) });
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

function Level({ level, live }: { level: number; live: boolean }) {
  const bars = [0.55, 0.85, 1, 0.7, 0.45];
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 14 }}>
      {bars.map((k, i) => (
        <span key={i} style={{ width: 3, borderRadius: 2, background: live ? color.accent : color.muted, height: `${Math.max(3, Math.round(14 * Math.min(1, level * 1.4) * k))}px`, transition: 'height 90ms linear' }} />
      ))}
    </span>
  );
}

export function LivePanel({ view, strings, anchor, onDone, onCancel, onClose, Button }: LivePanelProps) {
  const placement = usePlacement(anchor, view.open);
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const state = view.state;
  const committed = state?.committed ?? '';
  const interim = state?.interim ?? '';

  useEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [committed, interim, follow]);

  if (!view.open || !state) return null;

  const phase = state.phase;
  const recording = phase === 'recording' || phase === 'starting';
  const hold = state.mode === 'hold';
  const handsFree = state.mode === 'handsFree';
  const cancelArmed = view.cancelArmed && hold;

  let status: string = strings.listening;
  if (view.tidying) status = strings.tidying;
  else if (phase === 'paused') status = strings.paused;
  else if (phase === 'finishing' || phase === 'done') status = strings.finishing;
  else if (phase === 'pending') status = strings.savedOffline;
  else if (state.connection === 'offline') status = strings.offline;
  else if (state.connection === 'connecting') status = strings.connecting;
  else if (handsFree && state.silenceMs >= 60_000) status = strings.stillListening;

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

  const button = (primary: boolean): CSSProperties => ({
    appearance: 'none', border: `1px solid ${primary ? 'transparent' : color.border}`, borderRadius: 999,
    padding: '6px 14px', font: 'inherit', fontSize: 13, cursor: 'pointer',
    background: primary ? color.fg : 'transparent', color: primary ? color.bg : color.fg,
  });

  const action = (label: string, onClick: () => void, primary: boolean) =>
    Button ? <Button onClick={onClick} primary={primary}>{label}</Button> : <button type="button" onClick={onClick} style={button(primary)}>{label}</button>;

  return (
    <div
      role="region"
      aria-label={strings.voiceInput}
      data-voice-panel=""
      data-phase={phase}
      style={{
        ...placement, zIndex: 2147483000, display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: cancelArmed ? color.danger : color.bg, color: cancelArmed ? '#fff' : color.fg,
        border: `1px solid ${color.border}`, borderRadius: 'var(--voice-radius, 16px)',
        boxShadow: 'var(--voice-shadow, 0 12px 32px rgba(0,0,0,0.18))', overflow: 'hidden',
        font: 'var(--voice-font, inherit)', transition: 'background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 4px', fontSize: 12, color: cancelArmed ? '#fff' : color.muted }}>
        <Level level={state.level} live={recording && !cancelArmed} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cancelArmed ? strings.releaseToCancel : status}</span>
        {state.remainingMs <= 60_000 && recording ? <span>{strings.minuteLeft}</span> : null}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{clock(state.elapsedMs)}</span>
      </div>
      <div
        ref={scroller}
        data-voice-text=""
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        style={{ position: 'relative', flex: '1 1 auto', minHeight: 44, overflowY: 'auto', padding: '4px 14px 10px', fontSize: 16, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {committed || interim ? (
          <>
            <span>{committed}</span>
            <span style={{ color: cancelArmed ? 'rgba(255,255,255,0.75)' : color.muted }}>{interim}</span>
          </>
        ) : (
          <span style={{ color: cancelArmed ? 'rgba(255,255,255,0.75)' : color.muted }}>{notice ?? '…'}</span>
        )}
        {notice && (committed || interim) ? <div style={{ marginTop: 6, fontSize: 13, color: color.muted }}>{notice}</div> : null}
      </div>
      {!follow ? (
        <div style={{ position: 'absolute', right: 12, bottom: 56 }}>
          {Button ? <Button onClick={() => setFollow(true)} primary={false}>{`${strings.latest} ↓`}</Button> : <button type="button" onClick={() => setFollow(true)} style={{ ...button(false), background: color.bg, fontSize: 12 }}>{strings.latest} ↓</button>}
        </div>
      ) : null}
      <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{committed.slice(-200)}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 10px 14px', borderTop: `1px solid ${cancelArmed ? 'transparent' : color.border}`, fontSize: 12, color: cancelArmed ? '#fff' : color.muted }}>
        {recording && hold ? <span style={{ flex: 1 }}>{cancelArmed ? strings.releaseToCancel : strings.holdHint}</span> : null}
        {(recording || phase === 'paused') && !hold ? (
          <>
            <span style={{ flex: 1 }}>{state.mode === 'undecided' ? '' : strings.tapHint}</span>
            {action(strings.cancel, onCancel, false)}
            {action(strings.done, onDone, true)}
          </>
        ) : null}
        {!recording && phase !== 'paused' ? (
          <>
            <span style={{ flex: 1 }} />
            {action(strings.close, phase === 'pending' || notice ? onClose : onCancel, false)}
          </>
        ) : null}
      </div>
    </div>
  );
}
