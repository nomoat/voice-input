import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type StartMessage } from '../protocol.js';
import { type RelaySessionStats, type SegmentTiming } from './session.js';
import type { ProviderSpec } from './providers/types.js';
import type { SpeechChoice } from './region.js';
export interface VoiceUser {
    userId: string;
    languages?: readonly string[];
    speech?: SpeechChoice;
}
export declare class VoiceRefusal extends Error {
    readonly code: 'forbidden' | 'unauthorized';
    constructor(code?: 'forbidden' | 'unauthorized');
}
export interface VoiceMetric extends RelaySessionStats {
    event: 'voice.session';
    surface?: string;
    resumed: boolean;
    ms: number;
}
export interface VoiceRelayOptions {
    path: string;
    authenticate: (request: IncomingMessage, token: string | undefined) => Promise<VoiceUser | null>;
    providers: (request: IncomingMessage, start: StartMessage, user: VoiceUser) => ProviderSpec[];
    secret: string;
    allowOrigin?: (origin: string | undefined, request: IncomingMessage) => boolean;
    streamsPerUser?: number;
    streamsTotal?: number;
    maxMs?: number;
    timing?: Partial<SegmentTiming>;
    metric?: (metric: VoiceMetric) => void;
}
export interface VoiceRelay {
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    close(): void;
    readonly active: number;
}
export declare function deviceIdFor(secret: string, userId: string): string;
export declare function createVoiceRelay(options: VoiceRelayOptions): VoiceRelay;
export declare function attachVoiceRelay(server: Server, options: VoiceRelayOptions): VoiceRelay;
