const NO_SPACE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;
const LEADING_PUNCT = /^[.,!?;:)\]}%'"’”…]/u;
export function joinText(before, after) {
    if (!before)
        return after;
    if (!after)
        return before;
    if (/\s$/u.test(before) || /^\s/u.test(after))
        return before + after;
    const last = before.at(-1) ?? '';
    const first = after[0] ?? '';
    if (NO_SPACE_CHAR.test(last) || NO_SPACE_CHAR.test(first) || LEADING_PUNCT.test(after))
        return before + after;
    return `${before} ${after}`;
}
export function displayText(segments) {
    const ordered = [...segments].sort((a, b) => a.seg - b.seg);
    let committed = '';
    let interim = '';
    let open = false;
    let next = ordered[0]?.seg ?? 0;
    for (const s of ordered) {
        if (s.final && !open && s.seg === next) {
            committed = joinText(committed, s.text);
            next++;
        }
        else {
            open = true;
            interim = joinText(interim, s.text);
        }
    }
    if (committed && interim) {
        const joined = joinText(committed, interim);
        interim = joined.slice(committed.length);
    }
    return { committed, interim };
}
export function insertText(base, selectionStart, selectionEnd, text) {
    const head = base.slice(0, selectionStart);
    const tail = base.slice(selectionEnd);
    const left = joinText(head, text);
    const value = joinText(left, tail);
    const caret = left.length;
    return { value, caret };
}
