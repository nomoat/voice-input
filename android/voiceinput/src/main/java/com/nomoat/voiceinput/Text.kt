package com.nomoat.voiceinput

data class SegmentText(val seg: Int, val text: String, val final: Boolean)

data class DisplayText(val committed: String, val interim: String)

data class Insertion(val value: String, val caret: Int)

private val LEADING_PUNCTUATION = setOf('.', ',', '!', '?', ';', ':', ')', ']', '}', '%', '\'', '"', '’', '”', '…')

internal fun joinsWithoutSpace(codePoint: Int): Boolean {
    if (codePoint in 0x3000..0x303F || codePoint in 0xFF00..0xFFEF) return true
    val script = try {
        Character.UnicodeScript.of(codePoint)
    } catch (_: IllegalArgumentException) {
        return false
    }
    return script == Character.UnicodeScript.HAN || script == Character.UnicodeScript.HIRAGANA || script == Character.UnicodeScript.KATAKANA
}

fun joinText(before: String, after: String): String {
    if (before.isEmpty()) return after
    if (after.isEmpty()) return before
    if (before.last().isWhitespace() || after.first().isWhitespace()) return before + after
    val last = before.codePointBefore(before.length)
    val first = after.codePointAt(0)
    if (joinsWithoutSpace(last) || joinsWithoutSpace(first) || after.first() in LEADING_PUNCTUATION) return before + after
    return "$before $after"
}

fun displayText(segments: Iterable<SegmentText>): DisplayText {
    val ordered = segments.sortedBy { it.seg }
    var committed = ""
    var interim = ""
    var open = false
    var next = ordered.firstOrNull()?.seg ?: 0
    for (s in ordered) {
        if (s.final && !open && s.seg == next) {
            committed = joinText(committed, s.text)
            next++
        } else {
            open = true
            interim = joinText(interim, s.text)
        }
    }
    if (committed.isNotEmpty() && interim.isNotEmpty()) {
        val joined = joinText(committed, interim)
        interim = joined.substring(committed.length)
    }
    return DisplayText(committed, interim)
}

fun insertText(base: String, selectionStart: Int, selectionEnd: Int, text: String): Insertion {
    val start = selectionStart.coerceIn(0, base.length)
    val end = selectionEnd.coerceIn(start, base.length)
    val left = joinText(base.substring(0, start), text)
    val value = joinText(left, base.substring(end))
    return Insertion(value, left.length)
}
