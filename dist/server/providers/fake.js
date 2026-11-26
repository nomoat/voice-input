import { EventEmitter } from 'node:events';
import { FRAME_BYTES } from '../../protocol.js';
export const frameLabel = (frames) => frames.map((f) => `f${f}`).join(' ');
export function fakeFrame(index, amplitude = 8000) {
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_BYTES / 2; i++)
        frame.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
    frame.writeInt16LE(index & 0x7fff, 2);
    frame.writeInt16LE(amplitude ? 0x1234 : 0, 4);
    return frame;
}
export class FakeProvider extends EventEmitter {
    behavior;
    frames = [];
    received = 0;
    closed = false;
    finishing = false;
    timer;
    constructor(behavior = {}) {
        super();
        this.behavior = behavior;
    }
    start() {
        if (this.behavior.failOnStart) {
            this.timer = setTimeout(() => this.fail(), 1);
            return;
        }
        this.timer = setTimeout(() => !this.closed && this.emit('ready'), this.behavior.readyMs ?? 1);
    }
    get writable() {
        return !this.closed;
    }
    audio(pcm) {
        if (this.closed || this.finishing)
            return;
        this.received += pcm.length;
        for (let at = 0; at + 6 <= pcm.length; at += FRAME_BYTES) {
            if (pcm.readInt16LE(at + 4) === 0x1234)
                this.frames.push(pcm.readInt16LE(at + 2));
        }
        if (this.behavior.failAfterBytes !== undefined && this.received >= this.behavior.failAfterBytes) {
            this.fail();
            return;
        }
        this.emit('transcript', { text: this.text(), final: false });
    }
    finish() {
        if (this.closed || this.finishing)
            return;
        this.finishing = true;
        if (this.behavior.neverFinish)
            return;
        this.timer = setTimeout(() => {
            if (this.closed)
                return;
            this.emit('transcript', { text: this.text(), final: true });
            this.emit('done');
            this.close();
        }, this.behavior.finishMs ?? 1);
    }
    text() {
        return (this.behavior.text ?? frameLabel)(this.frames);
    }
    fail() {
        if (this.closed)
            return;
        this.close();
        this.emit('error', new Error('fake failure'));
    }
    close() {
        this.closed = true;
        clearTimeout(this.timer);
    }
}
export function fakeProvider(name, behavior = {}, timing = {}) {
    const created = [];
    return {
        name,
        created,
        connectMs: timing.connectMs ?? 200,
        finishMs: timing.finishMs ?? 300,
        create: () => {
            const p = new FakeProvider(typeof behavior === 'function' ? behavior() : behavior);
            created.push(p);
            return p;
        },
    };
}
