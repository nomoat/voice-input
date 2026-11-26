import type { IncomingMessage } from 'node:http';
import type { ProviderSpec } from './providers/types.js';
export declare function countryOf(request: IncomingMessage): string | undefined;
export type SpeechRegion = 'cn' | 'global';
export declare function regionOf(country: string | undefined, languages: readonly string[]): SpeechRegion;
export interface ProviderSet {
    doubao?: ProviderSpec | undefined;
    doubaoIme?: ProviderSpec | undefined;
    wetype?: ProviderSpec | undefined;
    gemini?: ProviderSpec | undefined;
}
export declare function providerChain(region: SpeechRegion, set: ProviderSet): ProviderSpec[];
