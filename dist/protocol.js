export const PROTOCOL_VERSION = 1;
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
export const MAX_SESSION_MS = 20 * 60_000;
export const SEND_WINDOW_MS = 30_000;
const isInt = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
export function parseClientMessage(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!value || typeof value !== 'object')
        return null;
    const m = value;
    if (m.type === 'cancel')
        return { type: 'cancel' };
    if (m.type === 'finish')
        return isInt(m.endMs) ? { type: 'finish', endMs: m.endMs } : null;
    if (m.type !== 'start')
        return null;
    if (m.v !== PROTOCOL_VERSION)
        return null;
    if (typeof m.session !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(m.session))
        return null;
    if (!isInt(m.fromMs) || m.fromMs % FRAME_MS !== 0 || !isInt(m.nextSeg))
        return null;
    const languages = Array.isArray(m.languages)
        ? m.languages.filter((l) => typeof l === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)).slice(0, 4)
        : [];
    const start = { type: 'start', v: PROTOCOL_VERSION, session: m.session, languages, fromMs: m.fromMs, nextSeg: m.nextSeg };
    if (typeof m.token === 'string' && m.token.length <= 8192)
        start.token = m.token;
    if (typeof m.surface === 'string' && /^[a-z0-9_-]{1,32}$/.test(m.surface))
        start.surface = m.surface;
    return start;
}
export function parseServerEvent(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!value || typeof value !== 'object')
        return null;
    const e = value;
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
                ? { type: 'error', code: e.code, retryable: e.retryable === true }
                : null;
        default:
            return null;
    }
}
