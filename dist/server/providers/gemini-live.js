import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
export const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export class GeminiLiveProvider extends EventEmitter {
    apiKey;
    model;
    ws;
    ready = false;
    closed = false;
    finishing = false;
    committed = '';
    bytes = 0;
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey;
        this.model = model;
    }
    start() {
        if (this.closed || this.ws)
            return;
        if (!this.apiKey) {
            queueMicrotask(() => this.fail('Gemini is not configured'));
            return;
        }
        try {
            const ws = new WebSocket(ENDPOINT, { headers: { 'x-goog-api-key': this.apiKey }, handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false });
            this.ws = ws;
            ws.on('open', () => {
                this.send({
                    setup: {
                        model: `models/${this.model}`,
                        generationConfig: { responseModalities: ['TEXT'] },
                        inputAudioTranscription: {},
                        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
                    },
                });
            });
            ws.on('message', (data) => {
                if (this.closed)
                    return;
                try {
                    this.message(JSON.parse(data.toString()));
                }
                catch {
                    this.fail('Invalid Gemini response');
                }
            });
            ws.on('error', () => this.fail('Gemini connection failed'));
            ws.on('close', () => this.fail('Gemini disconnected'));
        }
        catch {
            this.fail('Gemini connection failed');
        }
    }
    message(message) {
        if (message.error || message.goAway) {
            this.fail('Gemini is unavailable');
            return;
        }
        if (message.setupComplete && !this.ready) {
            this.ready = true;
            this.send({ realtimeInput: { activityStart: {} } });
            if (!this.closed)
                this.emit('ready');
        }
        const content = message.serverContent;
        if (!this.ready || !content)
            return;
        const final = content.inputTranscription?.text;
        const interim = content.interimInputTranscription?.text;
        if (typeof final === 'string') {
            this.committed += final;
            const done = this.finishing;
            this.emit('transcript', { text: this.committed, final: done });
            if (done && !this.closed) {
                this.close();
                this.emit('done');
            }
        }
        else if (typeof interim === 'string') {
            this.emit('transcript', { text: this.committed + interim, final: false });
        }
    }
    send(message) {
        if (this.closed || !this.ws)
            return;
        try {
            this.ws.send(JSON.stringify(message));
        }
        catch {
            this.fail('Gemini connection failed');
        }
    }
    get writable() {
        return !this.closed && this.ready && this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64 * 1024;
    }
    audio(pcm) {
        if (this.closed || this.finishing || !pcm.length)
            return;
        this.bytes += pcm.length;
        this.send({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
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
        this.send({ realtimeInput: { activityEnd: {} } });
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
        this.committed = '';
    }
}
export function geminiLive(options) {
    const model = options.model ?? GEMINI_TRANSCRIBE_MODEL;
    return {
        name: 'gemini',
        connectMs: options.connectMs ?? 10_000,
        finishMs: options.finishMs ?? 15_000,
        create: () => new GeminiLiveProvider(options.apiKey, model),
    };
}
