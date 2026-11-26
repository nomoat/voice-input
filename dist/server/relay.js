import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MAX_SESSION_MS, parseClientMessage } from '../protocol.js';
import { RelaySession } from './session.js';
export function deviceIdFor(secret, userId) {
    const digest = createHmac('sha256', secret).update(`voice-input:${userId}`).digest('hex').slice(0, 15);
    return ((BigInt(`0x${digest}`) % 9000000000000000n) + 1000000000000000n).toString();
}
function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
export function createVoiceRelay(options) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    const perUser = new Map();
    let total = 0;
    const limitPerUser = options.streamsPerUser ?? 2;
    const limitTotal = options.streamsTotal ?? 200;
    const maxMs = options.maxMs ?? MAX_SESSION_MS;
    const serve = (ws, request) => {
        let session;
        let user;
        let start;
        let authenticating = false;
        let counted = false;
        const opened = Date.now();
        let alive = true;
        const send = (event) => {
            if (ws.readyState === ws.OPEN)
                ws.send(JSON.stringify(event));
        };
        const end = () => {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
                ws.close(1000);
        };
        const release = () => {
            if (!counted || !user)
                return;
            counted = false;
            total--;
            const n = (perUser.get(user.userId) ?? 1) - 1;
            if (n > 0)
                perUser.set(user.userId, n);
            else
                perUser.delete(user.userId);
        };
        const authTimer = setTimeout(() => {
            if (!session) {
                send({ type: 'error', code: 'timeout', retryable: true });
                end();
            }
        }, 10_000);
        const ping = setInterval(() => {
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            ws.ping();
        }, 20_000);
        ws.on('pong', () => {
            alive = true;
        });
        ws.on('message', (data, binary) => {
            alive = true;
            if (binary) {
                if (!session)
                    return;
                const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                session.audio(buffer);
                return;
            }
            const message = parseClientMessage(data.toString());
            if (!message) {
                send({ type: 'error', code: 'bad_request', retryable: false });
                end();
                return;
            }
            if (message.type === 'cancel') {
                session?.cancel();
                end();
                return;
            }
            if (message.type === 'finish') {
                session?.finish();
                return;
            }
            if (session || authenticating)
                return;
            authenticating = true;
            start = message;
            void (async () => {
                let who = null;
                try {
                    who = await options.authenticate(request, message.token);
                }
                catch {
                    who = null;
                }
                if (ws.readyState !== ws.OPEN)
                    return;
                if (!who) {
                    send({ type: 'error', code: 'unauthorized', retryable: false });
                    end();
                    return;
                }
                if ((perUser.get(who.userId) ?? 0) >= limitPerUser || total >= limitTotal) {
                    send({ type: 'error', code: 'limit', retryable: true });
                    end();
                    return;
                }
                user = who;
                perUser.set(who.userId, (perUser.get(who.userId) ?? 0) + 1);
                total++;
                counted = true;
                clearTimeout(authTimer);
                const chain = options.providers(request, message, who);
                if (!chain.length) {
                    send({ type: 'error', code: 'providers_unavailable', retryable: false });
                    end();
                    return;
                }
                session = new RelaySession({
                    start: message,
                    providers: chain,
                    context: { userId: who.userId, deviceId: deviceIdFor(options.secret, who.userId), languages: message.languages },
                    send,
                    close: end,
                    maxMs,
                    ...(options.timing ? { timing: options.timing } : {}),
                });
            })();
        });
        ws.on('close', () => {
            clearTimeout(authTimer);
            clearInterval(ping);
            if (session) {
                session.shutdown();
                if (start) {
                    const metric = { event: 'voice.session', ...session.stats, resumed: start.fromMs > 0, ms: Date.now() - opened };
                    if (start.surface)
                        metric.surface = start.surface;
                    options.metric?.(metric);
                }
            }
            release();
        });
        ws.on('error', () => ws.terminate());
    };
    return {
        handleUpgrade(request, socket, head) {
            let pathname;
            try {
                pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
            }
            catch {
                return false;
            }
            if (pathname !== options.path)
                return false;
            const origin = request.headers.origin;
            if (options.allowOrigin && !options.allowOrigin(origin, request)) {
                reject(socket, '403 Forbidden');
                return true;
            }
            wss.handleUpgrade(request, socket, head, (ws) => serve(ws, request));
            return true;
        },
        close() {
            for (const client of wss.clients)
                client.terminate();
            wss.close();
        },
        get active() {
            return total;
        },
    };
}
export function attachVoiceRelay(server, options) {
    const relay = createVoiceRelay(options);
    server.on('upgrade', (request, socket, head) => {
        relay.handleUpgrade(request, socket, head);
    });
    return relay;
}
