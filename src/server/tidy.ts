export interface TidyRequest {
  text: string;
  surface?: string;
  languages?: readonly string[];
}

export interface TidyPrompt {
  system: string;
  user: string;
}

export const MAX_TIDY_CHARS = 40_000;

const BASE = `You clean up dictated text. The person spoke it aloud and a speech recognizer wrote it down.

Do:
- Add correct punctuation and split the text into paragraphs where the topic or speaker changes.
- Remove filler words and false starts (for example 嗯, 啊, 那个, 就是说, 然后然后, um, uh, you know) when they carry no meaning.
- Fix words the recognizer clearly misheard, when the right word is obvious from context.
- Keep the person's own words, order, language and tone. Keep mixed-language text mixed.

Do not:
- Summarize, shorten, explain, translate, answer, or add anything new.
- Change names, numbers or facts.

Return only the cleaned text as Markdown (paragraphs; headings or lists only if the person clearly dictated them). No preamble, no code fences.`;

const SCREENPLAY = `
This text is a screenplay or a scene being dictated. Where the person clearly dictates structure, lay it out as plain screenplay text:
- A scene heading on its own line (for example "第一场 日 外 天台" or "INT. KITCHEN - NIGHT").
- Action as normal paragraphs.
- A character name on its own line, then that character's dialogue on the next line.
Do not invent scenes, characters or dialogue the person did not say.`;

export function tidyPrompt(request: TidyRequest): TidyPrompt {
  const system = BASE + (request.surface === 'screenplay' ? SCREENPLAY : '');
  return { system, user: request.text };
}

function stripFences(text: string): string {
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return (fenced?.[1] ?? text).trim();
}

const contentLength = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '').length;

export function acceptTidy(original: string, tidied: string): string | null {
  const out = stripFences(tidied);
  if (!out) return null;
  const before = contentLength(original);
  const after = contentLength(out);
  if (before > 40 && (after < before * 0.55 || after > before * 1.25)) return null;
  return out;
}

export async function tidyDictation(request: TidyRequest, complete: (prompt: TidyPrompt) => Promise<string>): Promise<{ markdown: string; tidied: boolean }> {
  const text = request.text.trim();
  if (!text || text.length > MAX_TIDY_CHARS) return { markdown: text, tidied: false };
  let raw: string;
  try {
    raw = await complete(tidyPrompt({ ...request, text }));
  } catch {
    return { markdown: text, tidied: false };
  }
  const accepted = acceptTidy(text, raw);
  return accepted ? { markdown: accepted, tidied: true } : { markdown: text, tidied: false };
}
