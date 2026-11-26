import Foundation

public struct SegmentText: Sendable, Equatable {
    public var seg: Int
    public var text: String
    public var final: Bool

    public init(seg: Int, text: String, final: Bool) {
        self.seg = seg
        self.text = text
        self.final = final
    }
}

public struct DisplayText: Sendable, Equatable {
    public var committed: String
    public var interim: String

    public init(committed: String, interim: String) {
        self.committed = committed
        self.interim = interim
    }
}

public struct TextInsertion: Sendable, Equatable {
    public var value: String
    public var caret: Int
    public var replacement: String
    public var replacementCaret: Int
}

public enum VoiceText {
    public static func join(_ before: String, _ after: String) -> String {
        before + separator(before, after) + after
    }

    public static func separator(_ before: String, _ after: String) -> String {
        guard let last = before.unicodeScalars.last, let first = after.unicodeScalars.first else { return "" }
        if isSpace(last) || isSpace(first) { return "" }
        if noSpace(last) || noSpace(first) || leadingPunctuation(first) { return "" }
        return " "
    }

    public static func display<S: Sequence>(_ segments: S) -> DisplayText where S.Element == SegmentText {
        let ordered = segments.sorted { $0.seg < $1.seg }
        var committed = ""
        var interim = ""
        var open = false
        var next = ordered.first?.seg ?? 0
        for s in ordered {
            if s.final && !open && s.seg == next {
                committed = join(committed, s.text)
                next += 1
            } else {
                open = true
                interim = join(interim, s.text)
            }
        }
        if !committed.isEmpty && !interim.isEmpty { interim = separator(committed, interim) + interim }
        return DisplayText(committed: committed, interim: interim)
    }

    public static func insert(_ base: String, selectionStart: Int, selectionEnd: Int, text: String) -> (value: String, caret: Int) {
        let r = insertion(base, selectionStart: selectionStart, selectionEnd: selectionEnd, text: text)
        return (r.value, r.caret)
    }

    public static func insertion(_ base: String, selectionStart: Int, selectionEnd: Int, text: String) -> TextInsertion {
        let ns = base as NSString
        let start = min(max(0, selectionStart), ns.length)
        let end = min(max(start, selectionEnd), ns.length)
        let head = ns.substring(to: start)
        let tail = ns.substring(from: end)
        let lead = separator(head, text)
        let left = head + lead + text
        let trail = separator(left, tail)
        let replacement = lead + text + trail
        return TextInsertion(
            value: left + trail + tail,
            caret: (left as NSString).length,
            replacement: replacement,
            replacementCaret: ((lead + text) as NSString).length
        )
    }

    static func isSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    static func leadingPunctuation(_ s: Unicode.Scalar) -> Bool {
        switch s {
        case ".", ",", "!", "?", ";", ":", ")", "]", "}", "%", "'", "\"", "\u{2019}", "\u{201D}", "\u{2026}": return true
        default: return false
        }
    }

    static func noSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x3000...0x303F, 0xFF00...0xFFEF: return true
        case 0x2E80...0x2E99, 0x2E9B...0x2EF3, 0x2F00...0x2FD5, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFA6D, 0xFA70...0xFAD9,
             0x16FE2...0x16FE3, 0x16FF0...0x16FF1, 0x20000...0x2A6DF, 0x2A700...0x2EE5D, 0x2F800...0x2FA1D, 0x30000...0x323AF:
            return true
        case 0x3041...0x3096, 0x309D...0x309F, 0x1B001...0x1B11F, 0x1B132, 0x1B150...0x1B152, 0x1F200:
            return true
        case 0x30A1...0x30FA, 0x30FD...0x30FF, 0x31F0...0x31FF, 0x32D0...0x32FE, 0x3300...0x3357,
             0x1AFF0...0x1AFFE, 0x1B000, 0x1B120...0x1B122, 0x1B155, 0x1B164...0x1B167:
            return true
        default:
            return false
        }
    }
}
