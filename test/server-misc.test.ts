import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { acceptTidy, countryOf, fakeProvider, providerChain, regionOf, tidyDictation, tidyPrompt } from '../src/server/index.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('region routing', () => {
  it('reads the country from edge headers', () => {
    expect(countryOf(req({ 'cf-ipcountry': 'cn' }))).toBe('CN');
    expect(countryOf(req({ 'cf-ipcountry': 'XX' }))).toBeUndefined();
    expect(countryOf(req({}))).toBeUndefined();
  });
  it('mainland China uses Doubao first; everyone else Gemini first', () => {
    const set = { doubao: fakeProvider('doubao'), doubaoIme: fakeProvider('doubao-ime'), gemini: fakeProvider('gemini') };
    expect(providerChain(regionOf('CN', []), set).map((p) => p.name)).toEqual(['doubao', 'doubao-ime', 'gemini']);
    expect(providerChain(regionOf('US', ['zh-CN']), set).map((p) => p.name)).toEqual(['gemini', 'doubao', 'doubao-ime']);
    expect(regionOf('HK', ['zh-HK'])).toBe('global');
    expect(regionOf(undefined, ['zh-CN'])).toBe('cn');
    expect(regionOf(undefined, ['en-US'])).toBe('global');
  });
});

describe('tidy', () => {
  const raw = '嗯那个第一场就是说日外景老城区的天台上阿明靠着栏杆抽烟远处传来火车的声音他回头看了一眼楼梯口';
  it('accepts a cleanup that keeps the content', () => {
    expect(acceptTidy(raw, '第一场，日，外景。老城区的天台上，阿明靠着栏杆抽烟，远处传来火车的声音。他回头看了一眼楼梯口。')).toBeTruthy();
  });
  it('refuses a summary or an expansion', () => {
    expect(acceptTidy(raw, '阿明在天台抽烟。')).toBeNull();
    expect(acceptTidy(raw, raw + '然后阿明走下楼梯，打开了门，看见了一个陌生人站在那里，手里拿着一封信。')).toBeNull();
  });
  it('falls back to the raw text when the model fails', async () => {
    expect(await tidyDictation({ text: raw }, async () => { throw new Error('x'); })).toEqual({ markdown: raw, tidied: false });
  });
  it('adds screenplay layout rules only for the screenplay surface', () => {
    expect(tidyPrompt({ text: 'x', surface: 'screenplay' }).system).toContain('screenplay');
    expect(tidyPrompt({ text: 'x' }).system).not.toContain('scene heading');
  });
});
