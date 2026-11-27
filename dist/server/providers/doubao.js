import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import WebSocket from 'ws';
export const DOUBAO_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const DOUBAO_ASR_RESOURCE = 'volc.seedasr.sauc.duration';
const FULL_REQUEST = 0b0001;
const AUDIO_ONLY = 0b0010;
const FULL_RESPONSE = 0b1001;
const ERROR_RESPONSE = 0b1111;
const LAST_PACKET = 0b0010;
const HAS_SEQUENCE = 0b0001;
const JSON_SERIALIZATION = 1;
const GZIP = 1;
export function doubaoFrame(type, flags, serialization, payload) {
    const body = gzipSync(payload);
    const header = Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | GZIP, 0, 0, 0, 0, 0]);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}
export function parseDoubaoFrame(buf) {
    if (buf.length < 4)
        throw new Error('Truncated ASR frame');
    let offset = (buf[0] & 0x0f) * 4;
    const type = buf[1] >> 4;
    const flags = buf[1] & 0x0f;
    const need = (n) => {
        if (offset + n > buf.length)
            throw new Error('Truncated ASR frame');
    };
    if (type === ERROR_RESPONSE) {
        need(8);
        const code = buf.readUInt32BE(offset);
        const size = buf.readUInt32BE(offset + 4);
        need(8 + size);
        return { last: true, error: { code, message: buf.subarray(offset + 8, offset + 8 + size).toString() } };
    }
    if (type !== FULL_RESPONSE)
        return { last: false };
    if (flags & HAS_SEQUENCE) {
        need(4);
        offset += 4;
    }
    need(4);
    const size = buf.readUInt32BE(offset);
    need(4 + size);
    let payload = buf.subarray(offset + 4, offset + 4 + size);
    if ((buf[2] & 0x0f) === GZIP && payload.length)
        payload = gunzipSync(payload);
    const out = { last: (flags & LAST_PACKET) !== 0 };
    if (payload.length) {
        const json = JSON.parse(payload.toString());
        if (typeof json.result?.text === 'string')
            out.text = json.result.text;
    }
    return out;
}
export class DoubaoAsrProvider extends EventEmitter {
    apiKey;
    deviceId;
    options;
    ws;
    ready = false;
    closed = false;
    finishing = false;
    bytes = 0;
    lastText = '';
    constructor(apiKey, deviceId, options = {}) {
        super();
        this.apiKey = apiKey;
        this.deviceId = deviceId;
        this.options = options;
    }
    start() {
        if (this.closed || this.ws)
            return;
        if (!this.apiKey) {
            queueMicrotask(() => this.fail('Doubao is not configured'));
            return;
        }
        try {
            const ws = new WebSocket(this.options.endpoint ?? DOUBAO_ASR_ENDPOINT, {
                headers: { 'X-Api-Key': this.apiKey, 'X-Api-Resource-Id': this.options.resourceId ?? DOUBAO_ASR_RESOURCE, 'X-Api-Connect-Id': randomUUID() },
                handshakeTimeout: 10_000,
                maxPayload: 1024 * 1024,
                perMessageDeflate: false,
            });
            this.ws = ws;
            ws.on('open', () => {
                const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true };
                if (this.options.hotwords?.length)
                    request.corpus = { context: JSON.stringify({ hotwords: this.options.hotwords.map((word) => ({ word })) }) };
                this.send(doubaoFrame(FULL_REQUEST, 0, JSON_SERIALIZATION, Buffer.from(JSON.stringify({
                    user: { uid: this.deviceId },
                    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
                    request,
                }))));
                if (this.closed)
                    return;
                this.ready = true;
                this.emit('ready');
            });
            ws.on('message', (data, binary) => {
                if (this.closed || !binary)
                    return;
                let response;
                try {
                    response = parseDoubaoFrame(data);
                }
                catch {
                    this.fail('Invalid Doubao response');
                    return;
                }
                if (response.error) {
                    this.fail(`Doubao error ${response.error.code}`);
                    return;
                }
                if (response.text)
                    this.lastText = response.text;
                if (response.text || response.last)
                    this.emit('transcript', { text: this.lastText, final: response.last });
                if (response.last && !this.closed) {
                    this.close();
                    this.emit('done');
                }
            });
            ws.on('unexpected-response', () => this.fail('Doubao refused the connection'));
            ws.on('error', () => this.fail('Doubao connection failed'));
            ws.on('close', () => this.fail('Doubao disconnected'));
        }
        catch {
            this.fail('Doubao connection failed');
        }
    }
    send(frame) {
        if (this.closed || this.ws?.readyState !== WebSocket.OPEN)
            return;
        try {
            this.ws.send(frame);
        }
        catch {
            this.fail('Doubao connection failed');
        }
    }
    get writable() {
        return !this.closed && this.ready && !this.finishing && this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64 * 1024;
    }
    audio(pcm) {
        if (this.closed || this.finishing || !pcm.length)
            return;
        this.bytes += pcm.length;
        this.send(doubaoFrame(AUDIO_ONLY, 0, 0, pcm));
    }
    finish() {
        if (this.closed || this.finishing)
            return;
        this.finishing = true;
        if (!this.bytes) {
            this.close();
            this.emit('done');
            return;
        }
        this.send(doubaoFrame(AUDIO_ONLY, LAST_PACKET, 0, Buffer.alloc(0)));
    }
    fail(reason) {
        if (this.closed)
            return;
        this.close();
        this.emit('error', new Error(reason));
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.ws?.terminate();
        this.apiKey = undefined;
        this.lastText = '';
    }
}
export function doubao(options) {
    const { apiKey, connectMs, finishMs, ...rest } = options;
    return {
        name: 'doubao',
        connectMs: connectMs ?? 8_000,
        finishMs: finishMs ?? 10_000,
        create: (context) => new DoubaoAsrProvider(apiKey, context.deviceId, rest),
    };
}
