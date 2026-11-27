export declare const DEFAULT_FORMAT_MS = 1200;
export declare const DEFAULT_WARM_EVERY_MS = 30000;
export declare const GEMINI_FORMAT_MODEL = "gemini-3.5-flash-lite";
export declare const FORMAT_SYSTEM = "You clean up a short dictated message. A speech recognizer wrote it down.\n- Fix punctuation. Remove filler words and false starts (\u55EF, \u554A, \u90A3\u4E2A, \u5C31\u662F\u8BF4, \u7136\u540E\u7136\u540E, um, uh, like, you know) when they carry no meaning.\n- When the person corrects themselves (\"\u4E0D\u5BF9\", \"I mean\", \"\u6539\u6210\"), keep only the corrected version.\n- Fix words the recognizer clearly misheard, when the right word is obvious.\n- Keep the person's words, order, language and tone. Keep mixed-language text mixed. Do not summarize, translate, answer or add anything.\nReturn only the cleaned text, no quotes, no preamble.";
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
export declare function geminiFormatter(options: GeminiFormatterOptions): SegmentFormatter;
