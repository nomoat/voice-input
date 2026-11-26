export interface TidyRequest {
    text: string;
    surface?: string;
    languages?: readonly string[];
}
export interface TidyPrompt {
    system: string;
    user: string;
}
export declare const MAX_TIDY_CHARS = 40000;
export declare function tidyPrompt(request: TidyRequest): TidyPrompt;
export declare function acceptTidy(original: string, tidied: string): string | null;
export declare function tidyDictation(request: TidyRequest, complete: (prompt: TidyPrompt) => Promise<string>): Promise<{
    markdown: string;
    tidied: boolean;
}>;
