import { FRAME_BYTES, FRAME_MS, MAX_SESSION_MS } from '../protocol.js';
import { frameRms, PauseDetector } from './pause.js';
import { Segment } from './segment.js';
export const DEFAULT_TIMING = { minMs: 20_000, maxMs: 60_000, idleCutMs: 1_500 };
export class RelaySession {
    options;
    frame;
    nextSeg;
    current;
    open = new Map();
    pause = new PauseDetector();
    timing;
    maxMs;
    maxOpen;
    finishing = false;
    closed = false;
    ackHeld = false;
    lastAckFrame = -1;
    idleTimer;
    stats = { frames: 0, segments: 0, failovers: 0, providers: [], outcome: 'closed' };
    constructor(options) {
        this.options = options;
        this.frame = options.start.fromMs / FRAME_MS;
        this.nextSeg = options.start.nextSeg;
        this.timing = { ...DEFAULT_TIMING, ...options.timing };
        this.maxMs = options.maxMs ?? MAX_SESSION_MS;
        this.maxOpen = options.maxOpenSegments ?? 4;
        options.send({ type: 'ready', maxMs: this.maxMs });
    }
    audio(data) {
        if (this.closed || this.finishing)
            return;
        if (data.length !== FRAME_BYTES) {
            this.fail('bad_request', false);
            return;
        }
        if ((this.frame + 1) * FRAME_MS > this.maxMs + 10_000) {
            this.fail('limit', false);
            return;
        }
        const state = this.pause.update(frameRms(data));
        if (!this.current)
            this.current = this.newSegment();
        this.current.append(data, state.voice);
        this.frame++;
        this.stats.frames++;
        const length = (this.frame - this.current.startFrame) * FRAME_MS;
        const pauseFrames = length >= 45_000 ? 2 : 3;
        if ((length >= this.timing.minMs && state.silentFrames >= pauseFrames) || length >= this.timing.maxMs)
            this.cut();
        this.armIdle();
        this.ack();
    }
    finish() {
        if (this.closed || this.finishing)
            return;
        this.finishing = true;
        clearTimeout(this.idleTimer);
        this.cut();
        this.checkDone();
    }
    cancel() {
        this.stats.outcome = 'cancelled';
        this.shutdown();
    }
    shutdown() {
        if (this.closed)
            return;
        this.closed = true;
        clearTimeout(this.idleTimer);
        for (const segment of this.open.values())
            segment.close();
        this.open.clear();
        this.current = undefined;
        this.options.close();
    }
    newSegment() {
        const seg = this.nextSeg++;
        const segment = new Segment({
            seg,
            startFrame: this.frame,
            providers: this.options.providers,
            context: this.options.context,
            onProvider: (name, attempt) => {
                if (attempt > 0)
                    this.stats.failovers++;
                if (!this.stats.providers.includes(name))
                    this.stats.providers.push(name);
            },
        });
        this.open.set(seg, segment);
        this.stats.segments++;
        segment.on('interim', (text) => {
            if (!this.closed)
                this.options.send({ type: 'interim', seg, text });
        });
        segment.on('commit', ({ text, endFrame }) => {
            if (this.closed)
                return;
            this.open.delete(seg);
            this.options.send({ type: 'commit', seg, text, startMs: segment.startFrame * FRAME_MS, endMs: endFrame * FRAME_MS });
            if (this.ackHeld)
                this.ack(true);
            this.checkDone();
        });
        segment.on('failed', () => this.fail('providers_unavailable', true));
        return segment;
    }
    cut() {
        const segment = this.current;
        this.current = undefined;
        this.pause.reset();
        segment?.end();
    }
    armIdle() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.closed && !this.finishing)
                this.cut();
        }, this.timing.idleCutMs);
    }
    ack(force = false) {
        if (this.open.size >= this.maxOpen) {
            this.ackHeld = true;
            return;
        }
        if (!force && this.frame - this.lastAckFrame < 5)
            return;
        this.ackHeld = false;
        this.lastAckFrame = this.frame;
        this.options.send({ type: 'ack', ms: this.frame * FRAME_MS });
    }
    checkDone() {
        if (this.closed || !this.finishing || this.open.size)
            return;
        this.options.send({ type: 'done', nextSeg: this.nextSeg });
        this.stats.outcome = 'done';
        this.shutdown();
    }
    fail(code, retryable) {
        if (this.closed)
            return;
        this.options.send({ type: 'error', code, retryable });
        this.stats.outcome = 'error';
        this.stats.error = code;
        this.shutdown();
    }
}
