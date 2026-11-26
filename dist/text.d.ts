export declare function joinText(before: string, after: string): string;
export interface SegmentText {
    seg: number;
    text: string;
    final: boolean;
}
export interface DisplayText {
    committed: string;
    interim: string;
}
export declare function displayText(segments: Iterable<SegmentText>): DisplayText;
export declare function insertText(base: string, selectionStart: number, selectionEnd: number, text: string): {
    value: string;
    caret: number;
};
