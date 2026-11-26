export const PROTOCOL_VERSION = 1;

export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

export const MAX_SESSION_MS = 20 * 60_000;
export const SEND_WINDOW_MS = 30_000;

export type ErrorCode = 'unauthorized' | 'bad_request' | 'limit' | 'providers_unavailable' | 'timeout' | 'server';

export interface StartMessage {
  type: 'start';
  v: number;
  session: string;
  token?: string;
  languages: string[];
  surface?: string;
  fromMs: number;
  nextSeg: number;
}

export interface FinishMessage {
  type: 'finish';
  endMs: number;
}

export interface CancelMessage {
  type: 'cancel';
}

export type ClientMessage = StartMessage | FinishMessage | CancelMessage;

export interface ReadyEvent {
  type: 'ready';
  maxMs: number;
}

export interface InterimEvent {
  type: 'interim';
  seg: number;
  text: string;
}

export interface CommitEvent {
  type: 'commit';
  seg: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface AckEvent {
  type: 'ack';
  ms: number;
}

export interface DoneEvent {
  type: 'done';
  nextSeg: number;
}

export interface ErrorEvent {
  type: 'error';
  code: ErrorCode;
  retryable: boolean;
}

export type ServerEvent = ReadyEvent | InterimEvent | CommitEvent | AckEvent | DoneEvent | ErrorEvent;

const isInt = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (m.type === 'cancel') return { type: 'cancel' };
  if (m.type === 'finish') return isInt(m.endMs) ? { type: 'finish', endMs: m.endMs } : null;
  if (m.type !== 'start') return null;
  if (m.v !== PROTOCOL_VERSION) return null;
  if (typeof m.session !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(m.session)) return null;
  if (!isInt(m.fromMs) || m.fromMs % FRAME_MS !== 0 || !isInt(m.nextSeg)) return null;
  const languages = Array.isArray(m.languages)
    ? m.languages.filter((l): l is string => typeof l === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)).slice(0, 4)
    : [];
  const start: StartMessage = { type: 'start', v: PROTOCOL_VERSION, session: m.session, languages, fromMs: m.fromMs, nextSeg: m.nextSeg };
  if (typeof m.token === 'string' && m.token.length <= 8192) start.token = m.token;
  if (typeof m.surface === 'string' && /^[a-z0-9_-]{1,32}$/.test(m.surface)) start.surface = m.surface;
  return start;
}

export function parseServerEvent(raw: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  switch (e.type) {
    case 'ready':
      return { type: 'ready', maxMs: isInt(e.maxMs, 1) ? e.maxMs : MAX_SESSION_MS };
    case 'interim':
      return isInt(e.seg) && typeof e.text === 'string' ? { type: 'interim', seg: e.seg, text: e.text } : null;
    case 'commit':
      return isInt(e.seg) && typeof e.text === 'string' && isInt(e.startMs) && isInt(e.endMs) && e.endMs >= e.startMs
        ? { type: 'commit', seg: e.seg, text: e.text, startMs: e.startMs, endMs: e.endMs }
        : null;
    case 'ack':
      return isInt(e.ms) ? { type: 'ack', ms: e.ms } : null;
    case 'done':
      return isInt(e.nextSeg) ? { type: 'done', nextSeg: e.nextSeg } : null;
    case 'error':
      return typeof e.code === 'string'
        ? { type: 'error', code: e.code as ErrorCode, retryable: e.retryable === true }
        : null;
    default:
      return null;
  }
}
