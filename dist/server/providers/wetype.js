import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { bufferField, bytes, compress, crypt, decompress, field, hash, intField, OggOpusPackets, request, response, uint } from './wetype-codec.js';
const HOST = 'wetype.weixin.qq.com';
const VERSION = '3.0.0(670)';
const identities = new Map();
const bootstraps = new Map();
export function opusArguments() {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe',
        '-f', 's16le', '-ar', '16000', '-ac', '1', '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0',
        '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'off', '-application', 'voip', '-frame_duration', '20',
        '-f', 'opus', '-page_duration', '20000', '-flush_packets', '1', 'pipe:1'];
}
export class WeTypeProvider extends EventEmitter {
    deviceId;
    keys;
    ffmpeg;
    ws;
    encoder;
    identity;
    voiceId = BigInt(`0x${randomBytes(11).toString('hex')}`).toString().padStart(25, '0').slice(-25);
    pending = new Map();
    task = 0;
    seq = 0;
    offset = 0;
    packets = [];
    closed = false;
    finishing = false;
    lastResultSeq = -1;
    lastText;
    pollTimer;
    constructor(deviceId, keys, ffmpeg = 'ffmpeg') {
        super();
        this.deviceId = deviceId;
        this.keys = keys;
        this.ffmpeg = ffmpeg;
    }
    start() {
        const ws = new WebSocket(`wss://${HOST}/`, 'wxws_pb', { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
        this.ws = ws;
        ws.on('error', () => this.fail(new Error('WeType connection failed')));
        ws.on('close', () => this.fail(new Error('WeType disconnected')));
        ws.on('message', (data, binary) => {
            if (this.closed || !binary)
                return;
            try {
                const reply = response(data);
                if (!reply)
                    return;
                const pending = this.pending.get(reply.seq);
                if (!pending)
                    return;
                this.pending.delete(reply.seq);
                clearTimeout(pending.timer);
                if (reply.status !== 200) {
                    const cached = identities.get(this.deviceId);
                    if ([5004, 5011].includes(reply.status) && cached)
                        cached.expires = 0;
                    pending.reject(new Error(`WeType rejected request (${reply.status})`));
                }
                else
                    pending.resolve(reply);
            }
            catch (error) {
                this.fail(error);
            }
        });
        ws.on('open', () => this.initialize().catch((error) => this.fail(error)));
    }
    async initialize() {
        const existing = bootstraps.get(this.deviceId);
        if (existing)
            await existing.catch(() => undefined);
        if (this.closed)
            return;
        const cached = identities.get(this.deviceId);
        if (cached && cached.expires > Date.now())
            this.identity = cached;
        else {
            const operation = this.bootstrap(cached);
            bootstraps.set(this.deviceId, operation);
            try {
                this.identity = await operation;
            }
            finally {
                if (bootstraps.get(this.deviceId) === operation)
                    bootstraps.delete(this.deviceId);
            }
        }
        if (this.closed)
            return;
        const encoder = spawn(this.ffmpeg, opusArguments(), { stdio: ['pipe', 'pipe', 'pipe'] });
        this.encoder = encoder;
        const parser = new OggOpusPackets((packet) => {
            const length = Buffer.alloc(2);
            length.writeUInt16LE(packet.length);
            this.packets.push(length, packet);
            if (this.packets.length >= 10)
                this.flushAudio(false);
        });
        encoder.on('error', () => this.fail(new Error('WeType audio encoder is unavailable')));
        encoder.stdin.on('error', () => this.fail(new Error('WeType audio encoding failed')));
        encoder.stderr.on('data', () => undefined);
        encoder.stdout.on('data', (data) => {
            if (this.closed)
                return;
            try {
                parser.write(data);
            }
            catch (error) {
                this.fail(error);
            }
        });
        encoder.on('close', (code) => {
            if (this.closed)
                return;
            try {
                if (code !== 0 || !this.finishing)
                    throw new Error('WeType audio encoding failed');
                parser.finish();
                this.flushAudio(true);
            }
            catch (error) {
                this.fail(error);
            }
        });
        this.emit('ready');
    }
    async bootstrap(cached) {
        const { signKey, handshakeKey } = this.keys;
        const ecdh = createECDH('secp128r1');
        const pub = ecdh.generateKeys('hex').toUpperCase();
        const letters = [...Buffer.from(hash('sha256', this.deviceId), 'hex').subarray(0, 12)].map((v) => String.fromCharCode(97 + (v % 26))).join('');
        const prefix = `MAC${'Mac17,8'.padStart(17, '0')}${letters}`;
        const device = prefix + hash('md5', prefix + signKey);
        const dh = Buffer.concat([bytes(1, pub), bytes(2, ''), uint(3, cached ? 0 : 1), bytes(4, device),
            ...(cached ? [uint(5, cached.uin)] : []), bytes(7, ''), bytes(8, 'Mac17,8'), bytes(9, '')]);
        const reply = await this.rpc('/oauth_pubkey_v2', dh, handshakeKey, { 'Kb-Uin': cached?.uin ?? '0', 'Kb-DeviceCodeRestrictionV2': '1' });
        const decoded = this.decode(reply, handshakeKey);
        if (intField(decoded, 1))
            throw new Error('WeType key exchange rejected');
        const server = bufferField(decoded, 2)?.toString() ?? '';
        if (!/^04[0-9a-f]{64}$/i.test(server))
            throw new Error('Invalid WeType server key');
        const key = ecdh.computeSecret(Buffer.from(server, 'hex')).toString('hex').toUpperCase().padStart(32, '0');
        let uin = cached?.uin;
        if (!uin) {
            const token = bufferField(decoded, 4)?.toString();
            if (!token)
                throw new Error('Missing WeType bootstrap token');
            const allocated = await this.rpc('/gen_uin_v2', Buffer.concat([bytes(1, device), bytes(2, server), bytes(4, randomUUID().replaceAll('-', '')), bytes(5, '')]), key, { 'Kb-GenUinToken': token, 'Kb-DeviceCodeRestrictionV2': '1' });
            const body = this.decode(allocated, key);
            if (intField(body, 1))
                throw new Error('WeType anonymous identity rejected');
            uin = bufferField(body, 2)?.toString();
            if (!uin || uin === '0')
                throw new Error('Missing WeType anonymous identity');
        }
        const ttl = Number(intField(decoded, 3) ?? 600n);
        const identity = { key, uin, expires: Date.now() + Math.max(1, ttl - 30) * 1000 };
        identities.set(this.deviceId, identity);
        return identity;
    }
    rpc(path, payload, key, extra = {}) {
        const ws = this.ws;
        if (this.closed || !ws)
            return Promise.reject(new Error('WeType session closed'));
        if (this.pending.size >= 128 || ws.bufferedAmount > 256 * 1024)
            return Promise.reject(new Error('WeType connection is too slow'));
        const task = ++this.task;
        const compression = path === '/api_v2' && payload.length >= 301 ? '2' : '1';
        const body = crypt(key, compression === '2' ? compress(payload) : payload);
        const timestamp = String(Date.now());
        const trace = randomBytes(8).toString('hex');
        const md5 = hash('md5', body);
        const sign = `5${VERSION}2${path === '/api_v2' ? '45480' : ''}${timestamp}${md5}${path === '/gen_uin_v2' ? extra['Kb-GenUinToken'] : path === '/api_v2' ? extra['Kb-Uin'] : ''}${trace}${task}${this.keys.signKey}`;
        const headers = { ...extra, 'Kb-OsType': '5', 'Kb-Version': VERSION, 'Kb-SystemVersion': '27.0.0', 'Kb-PackageType': '3',
            Use_DebugNet: '0', 'Kb-TimeStamp': timestamp, 'Kb-BodyMd5': md5, 'Kb-TraceId': trace, 'Kb-TaskId': task, 'Kb-Scene': '2',
            'Kb-Sign': hash('sha256', sign), 'Content-Length': body.length, 'Kb-CompressionType': compression, 'Content-Type': 'application/octet-stream', HOST };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(task);
                reject(new Error('WeType request timed out'));
            }, 6000);
            this.pending.set(task, { resolve, reject, timer });
            ws.send(request(task, path, headers, body), (error) => {
                if (error)
                    this.fail(error);
            });
        });
    }
    decode(reply, key = this.identity?.key ?? '') {
        const body = crypt(key, reply.body, true);
        return reply.headers['kb-compressiontype'] === '2' ? decompress(body) : body;
    }
    get writable() {
        return !this.closed && (this.encoder?.stdin.writableLength ?? 0) < 64 * 1024 && this.pending.size < 64 && (this.ws?.bufferedAmount ?? 0) < 64 * 1024;
    }
    audio(pcm) {
        if (!this.closed && !this.finishing)
            this.encoder?.stdin.write(pcm);
    }
    finish() {
        if (this.closed || this.finishing)
            return;
        this.finishing = true;
        this.encoder?.stdin.end();
    }
    flushAudio(end) {
        let audio = Buffer.concat(this.packets);
        this.packets = [];
        if (!this.seq)
            audio = Buffer.concat([Buffer.from('#!OPUS_RAW_V1\x02\x01\x00', 'binary'), audio]);
        this.offset += audio.length;
        this.voice(audio, ++this.seq, end).then(() => {
            if (end)
                this.poll();
        }).catch((error) => this.fail(error));
    }
    async voice(audio, seq, end) {
        const identity = this.identity;
        if (this.closed || !identity)
            return;
        const inner = Buffer.concat([bytes(2, this.voiceId), bytes(4, audio), uint(5, 5), uint(6, end ? 1 : 0), uint(7, seq), uint(11, this.offset), uint(24, 1)]);
        const reply = await this.rpc('/api_v2', bytes(1, inner), identity.key, {
            'Kb-Uin': identity.uin, 'Kb-SharedKeySuffix': identity.key.slice(-4), 'Kb-CmdId': '4548', 'Kb-SubCmdId': '0',
        });
        if (this.closed)
            return;
        const body = bufferField(this.decode(reply), 1);
        if (!body)
            throw new Error('Missing WeType voice response');
        const base = bufferField(body, 1);
        if (base && field(base, 1))
            throw new Error('WeType recognition failed');
        const final = intField(body, 5) === 1n;
        const resultSeq = Number(intField(body, 3) ?? 0n);
        const text = (bufferField(body, 14) ?? bufferField(body, 4))?.toString();
        if (typeof text === 'string' && (final || (text && text !== this.lastText && resultSeq >= this.lastResultSeq))) {
            this.lastResultSeq = resultSeq;
            this.lastText = text;
            this.emit('transcript', { text, final });
        }
        if (final) {
            this.emit('done');
            this.close();
        }
    }
    poll() {
        if (this.closed)
            return;
        this.pollTimer = setTimeout(() => {
            this.voice(Buffer.alloc(0), 0, true).then(() => this.poll()).catch((error) => this.fail(error));
        }, 100);
    }
    fail(error) {
        if (this.closed)
            return;
        this.close();
        this.emit('error', error);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearTimeout(this.pollTimer);
        this.encoder?.kill('SIGKILL');
        this.ws?.terminate();
        for (const { timer, reject } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('WeType session closed'));
        }
        this.pending.clear();
        this.packets = [];
    }
}
export function wetype(options) {
    const keys = { signKey: options.signKey, handshakeKey: options.handshakeKey };
    return {
        name: 'wetype',
        connectMs: options.connectMs ?? 8_000,
        finishMs: options.finishMs ?? 8_000,
        create: (context) => new WeTypeProvider(context.deviceId, keys, options.ffmpeg),
    };
}
