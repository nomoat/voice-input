import type { IncomingMessage } from 'node:http';
import type { ProviderSpec } from './providers/types.js';

const COUNTRY_HEADERS = ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country', 'x-appengine-country', 'x-country-code'];

export function countryOf(request: IncomingMessage): string | undefined {
  for (const name of COUNTRY_HEADERS) {
    const value = request.headers[name];
    const code = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
    if (code && /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1') return code;
  }
  return undefined;
}

export type SpeechRegion = 'cn' | 'global';

export function regionOf(country: string | undefined, languages: readonly string[]): SpeechRegion {
  if (country) return country === 'CN' ? 'cn' : 'global';
  return languages[0]?.toLowerCase().startsWith('zh') ? 'cn' : 'global';
}

export interface ProviderSet {
  doubao?: ProviderSpec | undefined;
  doubaoIme?: ProviderSpec | undefined;
  wetype?: ProviderSpec | undefined;
  gemini?: ProviderSpec | undefined;
}

export type SpeechChoice = 'doubao' | 'gemini';

export const SPEECH_CHOICES: readonly SpeechChoice[] = ['doubao', 'gemini'];

export function isSpeechChoice(value: unknown): value is SpeechChoice {
  return value === 'doubao' || value === 'gemini';
}

export function speechChoiceFor(languages: readonly string[]): SpeechChoice {
  return languages[0]?.trim().toLowerCase().startsWith('zh') ? 'doubao' : 'gemini';
}

export function speechChain(choice: SpeechChoice, set: ProviderSet): ProviderSpec[] {
  const order = choice === 'doubao'
    ? [set.doubao, set.doubaoIme, set.wetype, set.gemini]
    : [set.gemini, set.doubao, set.doubaoIme];
  return order.filter((p): p is ProviderSpec => Boolean(p));
}

export function providerChain(region: SpeechRegion, set: ProviderSet): ProviderSpec[] {
  return speechChain(region === 'cn' ? 'doubao' : 'gemini', set);
}
