import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

export const DEFAULT_FORMAT_MS = 1_200;
export const DEFAULT_WARM_EVERY_MS = 30_000;
export const GEMINI_FORMAT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_REPLY_BYTES = 1024 * 1024;

export const FORMAT_SYSTEM = `You clean up a short dictated message. A speech recognizer wrote it down.
- Fix punctuation. Remove filler words and false starts (嗯, 啊, 那个, 就是说, 然后然后, um, uh, like, you know) when they carry no meaning.
- When the person corrects themselves ("不对", "I mean", "改成"), keep only the corrected version.
- Fix words the recognizer clearly misheard, when the right word is obvious.
- Keep the person's words, order, language and tone. Keep mixed-language text mixed. Do not summarize, translate, answer or add anything.
Return only the cleaned text, no quotes, no preamble.`;

export interface FormatContext {
  provider: string;
  languages: readonly string[];
  signal?: AbortSignal;
}

export interface WarmContext {
  providers: readonly string[];
  languages: readonly string[];
}

export interface SegmentFormatter {
  (text: string, context: FormatContext): Promise<string | null>;
  warm?: (context: WarmContext) => void;
}

export interface GeminiFormatterOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  system?: string;
  maxOutputTokens?: number;
  warmEveryMs?: number;
}

interface GeminiReply {
  candidates?: { finishReason?: string; content?: { parts?: { text?: unknown }[] } }[];
}

let httpAgent: HttpAgent | undefined;
let httpsAgent: HttpsAgent | undefined;

const AGENT_OPTIONS = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32, maxFreeSockets: 8, scheduling: 'lifo' } as const;

function transport(url: URL) {
  return url.protocol === 'https:'
    ? { agent: (httpsAgent ??= new HttpsAgent(AGENT_OPTIONS)), send: httpsRequest }
    : { agent: (httpAgent ??= new HttpAgent(AGENT_OPTIONS)), send: httpRequest };
}

function getAndDiscard(url: URL, headers: Record<string, string>): Promise<void> {
  const { agent, send } = transport(url);
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'GET', agent, headers }, (res) => {
      res.on('error', reject);
      res.on('end', () => resolve());
      res.resume();
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Gemini warm-up timed out')));
    req.on('error', reject);
    req.end();
  });
}

function postJson(url: URL, payload: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(payload));
  const { agent, send } = transport(url);
  return new Promise((resolve, reject) => {
    const onReply = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) {
          res.destroy(new Error('Gemini reply too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`Gemini HTTP ${res.statusCode ?? 0}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Invalid Gemini reply'));
        }
      });
    };
    const req = send(url, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers }, ...(signal ? { signal } : {}) }, onReply);
    req.setTimeout(10_000, () => req.destroy(new Error('Gemini timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export function geminiFormatter(options: GeminiFormatterOptions): SegmentFormatter {
  const model = options.model ?? GEMINI_FORMAT_MODEL;
  const url = new URL(`${options.endpoint ?? GEMINI_API}/models/${model}:generateContent`);
  const modelUrl = new URL(`${options.endpoint ?? GEMINI_API}/models/${model}`);
  const system = options.system ?? FORMAT_SYSTEM;
  const every = options.warmEveryMs ?? DEFAULT_WARM_EVERY_MS;
  let warming = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  const warm = () => {
    const now = Date.now();
    if (warming || now - lastAt < every) return;
    warming = true;
    lastAt = now;
    let pending: Promise<void>;
    try {
      pending = getAndDiscard(modelUrl, { 'x-goog-api-key': options.apiKey });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .catch(() => undefined)
      .finally(() => {
        warming = false;
      });
  };
  const format: SegmentFormatter = async (text, context) => {
    lastAt = Math.max(lastAt, Date.now());
    const reply = (await postJson(
      url,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0, maxOutputTokens: options.maxOutputTokens ?? 1024, thinkingConfig: { thinkingLevel: 'minimal' } },
      },
      { 'x-goog-api-key': options.apiKey },
      context.signal,
    )) as GeminiReply;
    const candidate = reply.candidates?.[0];
    if (!candidate || (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP')) throw new Error('Gemini did not finish the text');
    const out = (candidate.content?.parts ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('').trim();
    if (!out) throw new Error('Gemini returned no text');
    return out;
  };
  format.warm = warm;
  return format;
}
